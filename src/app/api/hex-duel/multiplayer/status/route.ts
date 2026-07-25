import { auth } from "@clerk/nextjs/server";
import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";

/**
 * Backoff (in ms) between the failed first attempt and the retry on
 * this read-only polling path. Tuned for Neon free-tier auto-suspend:
 * a cold-resuming compute typically takes a few tens of milliseconds
 * before the first query lands, so a no-backoff retry fires on the
 * same cold connection and fails identically. Bumped via constant
 * rather than magic number so it can be tuned per-environment
 * (dev/prod/staging) without a code-search. Kept in sync with the
 * sibling `actions/route.ts` so tuning one without the other doesn't
 * drift.
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
 * visible in production logs. Identical helper to the sibling
 * `actions/route.ts` — kept inline here so the two polled routes can
 * be read independently. If a third polled route joins them, extract
 * to `src/lib/db/retry.ts`.
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
      "[hex-duel/multiplayer/status] SELECT failed, retrying once",
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

/** Derive currentTurn from the status string */
function statusToTurn(status: string): "player1" | "player2" | null {
  if (status === "turn_player1") return "player1";
  if (status === "turn_player2") return "player2";
  return null;
}

export async function GET(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // `gameId` even when the throw happened during URL parsing.
  let gameId: number = NaN;
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    gameId = Number(searchParams.get("gameId"));

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    // Uses typed or(eq(...), eq(...)) instead of the raw
    // `sql\`(${hexDuelGames.player1Id} = ${userId} OR ...)\`` template,
    // which has parameter-binder fragility under
    // `drizzle-orm/neon-serverless` (root cause of past 500s).
    //
    // Wrapped in `withSingleRetryForReadOnly` to ride out transient
    // Neon transport failures (cold-starts, WS reconnects, statement
    // timeout ticks). Unlike the sibling `actions/route.ts`, this
    // status endpoint does not have a separate multi-row polling
    // query — the only reads ARE the game lookup and (conditional)
    // player2 name — so both reads get the resilience rather than
    // leaving PK lookups un-retried. Real bugs (auth filter, schema
    // mismatch, DB permissions) will fail consistently across both
    // attempts and still surface through the cause-logging catch.
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
        .where(
          and(
            eq(hexDuelGames.id, gameId),
            or(
              eq(hexDuelGames.player1Id, userId),
              eq(hexDuelGames.player2Id, userId),
            ),
          ),
        )
        .limit(1),
    );

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    const amHost = game.player1Id === userId;
    const bothJoined = game.player2Id !== null;
    const isReady = bothJoined && (game.status === "in_progress" || game.status.startsWith("turn_"));
    const currentTurn = statusToTurn(game.status);

    // Fetch player2 name if both joined
    let player2Name: string | null = null;
    if (game.player2Id) {
      // Same retry reasoning as the game lookup above. `game.player2Id`
      // is narrowed non-null by the outer if, but TS narrowing does not
      // carry into the arrow function passed to the helper, so the
      // non-null assertion makes the typing explicit.
      const [p2] = await withSingleRetryForReadOnly(() =>
        db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.clerkId, game.player2Id!))
          .limit(1),
      );
      player2Name = p2?.name || null;
    }

    return NextResponse.json({
      success: true,
      game: {
        id: game.id,
        status: game.status,
        bothJoined,
        isReady,
        amHost,
        currentTurn,
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        wagerAmount: game.wagerAmount,
        player1Name: game.player1Name || null,
        player2Name,
      },
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
      "[hex-duel/multiplayer/status] GET failed",
      {
        url: req.url,
        gameId,
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
    // \"hex_duel_games\" does not exist", constraint names, column
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

export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // `gameId` / `turn` even when the throw happened during JSON parsing.
  let gameId: number = NaN;
  let turn: string | null = null;
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      turn?: unknown;
    };
    gameId = Number(body.gameId);
    turn = typeof body.turn === "string" ? body.turn : null;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (turn && turn !== "player1" && turn !== "player2") {
      return NextResponse.json({ success: false, error: "Invalid turn value" }, { status: 400 });
    }

    // Uses typed or(eq(...), eq(...)) instead of the raw
    // `sql\`(${hexDuelGames.player1Id} = ${userId} OR ...)\`` template,
    // which has parameter-binder fragility under
    // `drizzle-orm/neon-serverless` (root cause of past 500s).
    //
    // Wrapped in `withSingleRetryForReadOnly` for the same Neon
    // cold-start resilience as the GET path. The subsequent
    // `db.update` is NOT wrapped — it's a mutation and silent retries
    // there would double-flip the game status (or be silently
    // idempotent-as-no-op, masking real transport bugs). See below.
    const [game] = await withSingleRetryForReadOnly(() =>
      db
        .select()
        .from(hexDuelGames)
        .where(
          and(
            eq(hexDuelGames.id, gameId),
            or(
              eq(hexDuelGames.player1Id, userId),
              eq(hexDuelGames.player2Id, userId),
            ),
          ),
        )
        .limit(1),
    );

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Accept turn updates from any player in the game (lightweight fallback — no strict enforcement)
    let newStatus = turn ? `turn_${turn}` : game.status;

    // If game is "in_progress" and no turn set yet, default to player1's turn
    if (game.status === "in_progress" && !turn) {
      newStatus = "turn_player1";
    }

    // Intentionally NOT wrapped in `withSingleRetryForReadOnly`. This
    // is a mutation (status flip); silent retries could double-apply
    // newStatus against itself, or — on idempotent same-value sets —
    // silently mask transport bugs that we want the cause-logging
    // catch above to surface.
    await db
      .update(hexDuelGames)
      .set({ status: newStatus })
      .where(eq(hexDuelGames.id, gameId));

    return NextResponse.json({
      success: true,
      game: { id: gameId, status: newStatus, currentTurn: statusToTurn(newStatus) },
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
      "[hex-duel/multiplayer/status] POST failed",
      {
        gameId,
        turn,
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
    // Postgres cause messages can leak schema internals, so we keep
    // the diagnostic at the log layer and send the client a stable,
    // opaque message.
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
