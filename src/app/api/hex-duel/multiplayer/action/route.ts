import { auth } from "@clerk/nextjs/server";
import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";

/**
 * Backoff (in ms) between the failed first attempt and the retry on
 * this read-only polling path. Tuned for Neon free-tier auto-suspend:
 * a cold-resuming compute typically takes a few tens of milliseconds
 * before the first query lands, so a no-backoff retry fires on the
 * same cold connection and fails identically. Kept in sync with the
 * sibling polled routes (`actions/`, `spectate/`, `status/`) so
 * tuning one without the others doesn't drift.
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
      "[hex-duel/multiplayer/action] SELECT failed, retrying once",
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

export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them without re-parsing the request body. Safe fallback values
  // keep catch diagnostics sensible if the throw happened during
  // JSON parsing.
  let gameId: number = NaN;
  let actionType: string | null = null;

  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      actionType?: unknown;
      sourceKey?: string | null;
      targetKey?: string | null;
      troopCount?: number | null;
    };
    gameId = Number(body.gameId);
    actionType = typeof body.actionType === "string" ? body.actionType : null;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (
      !actionType ||
      !["attack", "displace", "endTurn", "skipRound"].includes(actionType)
    ) {
      return NextResponse.json({ success: false, error: "Invalid actionType" }, { status: 400 });
    }

    const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
    const targetKey = typeof body.targetKey === "string" ? body.targetKey : null;
    const troopCount =
      typeof body.troopCount === "number" && Number.isFinite(body.troopCount)
        ? body.troopCount
        : null;

    // Verify caller is a player in this game.
    // Uses typed `or(eq(...), eq(...))` instead of the raw
    // `sql\`(${hexDuelGames.player1Id} = ${userId} OR ...)\`` template,
    // which has parameter-binder fragility under
    // `drizzle-orm/neon-serverless` and was the root cause of prior
    // 500s on the sibling `actions/route.ts` (now fixed).
    //
    // Wrapped in `withSingleRetryForReadOnly` for Neon cold-start
    // resilience. The subsequent `db.insert` is NOT wrapped — it's a
    // mutation and silent retries there would create duplicate
    // `hex_duel_actions` rows. See below.
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

    // Intentionally NOT wrapped in `withSingleRetryForReadOnly`. This
    // is a mutation. Silent retries could double-insert duplicate
    // action rows for the same player move, which would corrupt the
    // action log on the client and let the same player appear to
    // move twice. Transport errors here will surface through the
    // cause-logging catch below — the player can re-issue the
    // action manually if they want.
    const [action] = await db
      .insert(hexDuelActions)
      .values({
        gameId,
        userId,
        actionType,
        sourceKey,
        targetKey,
        troopCount,
      })
      .returning({ id: hexDuelActions.id, createdAt: hexDuelActions.createdAt });

    return NextResponse.json({
      success: true,
      action: { id: action.id, createdAt: action.createdAt },
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
    //
    // `gameId` / `actionType` are hoisted above so they are in scope
    // here even when the failure happened during JSON parsing.
    console.error(
      "[hex-duel/multiplayer/action] POST failed",
      {
        url: req.url,
        gameId,
        actionType,
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
    // opaque message. If the client wants to distinguish error modes,
    // it should look at `success: false` and HTTP 5xx — not at the
    // text of `error`.
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
