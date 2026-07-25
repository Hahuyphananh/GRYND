import { auth } from "@clerk/nextjs/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames, users } from "../../../../../db/schema";

/**
 * Backoff (in ms) between the failed first attempt and the retry on
 * this read-only polling path. Tuned for Neon free-tier auto-suspend:
 * a cold-resuming compute typically takes a few tens of milliseconds
 * before the first query lands, so a no-backoff retry fires on the
 * same cold connection and fails identically. Kept in sync with the
 * sibling `actions/route.ts` and `status/route.ts` so tuning one
 * without the others doesn't drift.
 */
const POLL_RETRY_BACKOFF_MS = 75;

/**
 * Run a read-only SELECT with a single retry on transient failure.
 *
 * READ-ONLY CONSTRAINT: this helper takes a `() => Promise<T>` —
 * type-system-wise it accepts anything, but it MUST NOT be passed a
 * mutating function (db.insert, db.update, db.delete, calls inside a
 * transaction that mutates). Silent retry on a mutation would create
 * duplicate rows / double-debits. If you need the same pattern for a
 * mutation, write an explicit retry that classifies errors and is
 * named accordingly — do not rename this helper.
 *
 * The Vercel → Neon transport (`drizzle-orm/neon-serverless` over a
 * `@neondatabase/serverless` Pool) occasionally throws Drizzle's
 * `DrizzleQueryError` wrapper for what are actually transient infra
 * blips — Neon compute cold-starts, auto-suspend resumes, brief
 * WebSocket reconnects, `statement_timeout` ticks under burst load.
 * Drizzle wraps every DB/network error in `DrizzleQueryError` whose
 * `.message` is the literal `"Failed query: <sql>"` and whose real
 * Postgres / network error sits on `.cause`. Those transient wraps
 * used to surface as 500 to the client.
 *
 * Uses `POLL_RETRY_BACKOFF_MS` between attempts so a cold-resuming
 * Neon compute has time to warm before the second attempt lands.
 *
 * If the second attempt also fails, we re-throw and the catch block
 * logs both the wrapper AND `.cause` so the real cause is finally
 * visible in production logs. Identical helper to the sibling routes
 * — kept inline here so the polled routes can be read independently.
 * Extract to `src/lib/db/retry.ts` once a fourth caller shows up.
 */
async function withSingleRetryForReadOnly<T>(
  fn: () => Promise<T>,
  opts: { backoffMs?: number } = {},
): Promise<T> {
  const backoffMs = opts.backoffMs ?? POLL_RETRY_BACKOFF_MS;
  try {
    return await fn();
  } catch (firstErr: any) {
    console.warn(
      "[hex-duel/multiplayer/spectate] SELECT failed, retrying once",
      {
        causeMessage: firstErr?.cause?.message,
        causeCode: firstErr?.cause?.code,
        causeName: firstErr?.cause?.name,
        backoffMs,
      },
    );
    if (backoffMs > 0) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    return await fn();
  }
}

/**
 * GET /api/hex-duel/multiplayer/spectate?gameId=...&afterId=...
 * Returns game metadata + all actions for a spectator to reconstruct the game state.
 * Unlike the regular actions endpoint, this does NOT require the caller to be a player.
 */
export async function GET(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them even on URL-parse failures.
  let gameId: number = NaN;
  let afterId = 0;
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    gameId = Number(searchParams.get("gameId"));
    afterId = Number(searchParams.get("afterId")) || 0;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    // Fetch game metadata with player names. Wrapped in
    // `withSingleRetryForReadOnly` for the same Neon cold-start
    // resilience as the other polled routes on this folder. Real
    // bugs (auth, schema, permissions) will fail consistently and
    // still surface through the cause-logging catch.
    const [game] = await withSingleRetryForReadOnly(() =>
      db
        .select({
          id: hexDuelGames.id,
          status: hexDuelGames.status,
          player1Id: hexDuelGames.player1Id,
          player2Id: hexDuelGames.player2Id,
          wagerAmount: hexDuelGames.wagerAmount,
          player1Name: users.name,
        })
        .from(hexDuelGames)
        .leftJoin(users, eq(users.clerkId, hexDuelGames.player1Id))
        .where(eq(hexDuelGames.id, gameId))
        .limit(1),
    );

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Only allow spectating games that are in progress
    const validStatuses = ["in_progress", "turn_player1", "turn_player2"];
    if (!validStatuses.includes(game.status)) {
      return NextResponse.json(
        { success: false, error: "Game is not currently in progress" },
        { status: 400 },
      );
    }

    // Fetch player2 name if they exist. Same retry reasoning as the
    // game lookup above. `game.player2Id` is narrowed non-null by the
    // outer if, but TS narrowing does not carry into the arrow
    // function passed to the helper, so the non-null assertion makes
    // the typing explicit.
    let player2Name: string | null = null;
    if (game.player2Id) {
      const [p2] = await withSingleRetryForReadOnly(() =>
        db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.clerkId, game.player2Id!))
          .limit(1),
      );
      player2Name = p2?.name || null;
    }

    const currentTurn = game.status === "turn_player1" ? "player1" : game.status === "turn_player2" ? "player2" : "player1";

    // Fetch ALL actions (not filtered by userId since spectator is not a player).
    // Wrapped in `withSingleRetryForReadOnly` — this is the
    // multi-row polling target. The actions row can grow during a
    // game, which makes it the most cold-start-sensitive read on
    // this endpoint.
    const conditions = [eq(hexDuelActions.gameId, gameId)];
    if (afterId > 0) {
      conditions.push(gt(hexDuelActions.id, afterId));
    }

    const actions = await withSingleRetryForReadOnly(() =>
      db
        .select()
        .from(hexDuelActions)
        .where(and(...conditions))
        .orderBy(sql`${hexDuelActions.id} ASC`)
        .limit(100),
    );

    const maxId = actions.length > 0 ? Math.max(...actions.map((a) => a.id)) : afterId;

    return NextResponse.json({
      success: true,
      game: {
        id: game.id,
        status: game.status,
        currentTurn,
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        wagerAmount: game.wagerAmount,
        player1Name: game.player1Name || "Player 1",
        player2Name: player2Name || "Player 2",
      },
      actions: actions.map((a) => ({
        id: a.id,
        userId: a.userId,
        actionType: a.actionType,
        sourceKey: a.sourceKey,
        targetKey: a.targetKey,
        troopCount: a.troopCount,
        createdAt: a.createdAt,
      })),
      latestActionId: maxId,
    });
  } catch (error: any) {
    // Capture the real cause on `error.cause` so Vercel function logs
    // (and Sentry if wired up) finally show the actual failure mode:
    // Drizzle 0.45.x wraps every DB/network error in a
    // `DrizzleQueryError` whose `.message` is literally
    // `"Failed query: <sql>"` and whose real Postgres / network error
    // sits on `.cause`. Without this, every prior "real errors" log
    // only showed the useless wrapper.
    //
    // We also log Postgres-specific fields (`detail`, `hint`) since
    // those are the highest-signal fields on real errors once `.cause`
    // is surfaced.
    console.error(
      "[hex-duel/multiplayer/spectate] GET failed",
      {
        url: req.url,
        gameId,
        afterId,
        // Wrapper (DrizzleQueryError):
        err: error?.message,
        stack: error?.stack,
        // Underlying cause (Postgres / Neon transport / Drizzle):
        causeMessage: error?.cause?.message,
        causeCode: error?.cause?.code,
        causeName: error?.cause?.name,
        causeDetail: error?.cause?.detail,
        causeHint: error?.cause?.hint,
        causeStack: error?.cause?.stack,
      },
    );
    // The client-facing `error` string is intentionally generic.
    // Postgres cause messages can leak schema internals ("relation
    // \"hex_duel_actions\" does not exist", constraint names, column
    // names, etc.), so we keep the diagnostic at the log layer and
    // send the client a stable, opaque message. If the client wants
    // to distinguish error modes, it should look at `success: false`
    // and HTTP 5xx — not at the text of `error`.
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
