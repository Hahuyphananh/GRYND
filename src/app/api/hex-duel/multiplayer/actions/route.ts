import { auth } from "@clerk/nextjs/server";
import { and, eq, gt, not, or, asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";

/**
 * Backoff (in ms) between the failed first attempt and the retry on
 * this read-only polling path. Tuned for Neon free-tier auto-suspend:
 * a cold-resuming compute typically takes a few tens of milliseconds
 * before the first query lands, so a no-backoff retry fires on the
 * same cold connection and fails identically. Bumped via constant
 * rather than magic number so it can be tuned per-environment
 * (dev/prod/staging) without a code-search.
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
 * visible in production logs (see below).
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
      "[hex-duel/multiplayer/actions] SELECT failed, retrying once",
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

export async function GET(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read them
  // without re-parsing req.url. Defaults are overwritten by the parser
  // below in the happy path; safe fallback values keep catch diagnostics
  // sensible if the throw happened during URL parsing (gameId stays NaN,
  // afterId stays 0).
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

    // Verify caller is a player in this game.
    // Two historical fixes painted this 500 in production:
    //   1. The raw `sql\`(${player1Id} = ${userId} OR ...)\`` template was
    //      replaced with typed `or(eq(...), eq(...))`. The raw template's
    //      neon-serverless parameter binder threw before the Postgres
    //      roundtrip. (See Sentry.)
    //   2. The bare `ne(hexDuelActions.userId, userId)` operator in the
    //      actions filter is also suspected to share the same parameter-
    //      binder fragility, and was replaced with `not(eq(...))` which
    //      takes the standard parameterized path through Drizzle.
    //
    // This PK lookup is intentionally NOT wrapped in
    // `withSingleRetryForReadOnly`. Authoring/updating 500s here is
    // useful: a single-row PK query failing is almost certainly a real
    // bug (auth filter rejecting valid user, schema mismatch, DB
    // permissions) that we WANT a noisy 500 to surface, not a silent
    // retry that masks it. The translations retry is reserved for the
    // multi-row polling query below where Neon cold-starts can
    // intermittently flake.
    const [game] = await db
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
      .limit(1);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Build conditions dynamically (avoid undefined in and() for drizzle compat).
    // Use `not(eq(...))` instead of the standalone `ne()` operator as a
    // defensive choice under the `drizzle-orm/neon-serverless` driver —
    // bare `ne()` is suspected (unverified) to share the same
    // parameter-binder issue as the raw `sql\`!= ${userId}\`` template
    // it replaced. `not(eq(...))` produces semantically identical SQL
    // (`<> $1`) via Drizzle's standard parameterized path. Even if this
    // is a placebo, the prior fix (swapping raw `sql` templates for
    // typed operators) should already resolve the 500 — this just
    // removes the questionable operator entirely.
    const conditions = [
      eq(hexDuelActions.gameId, gameId),
      not(eq(hexDuelActions.userId, userId)),
    ];
    if (afterId > 0) {
      conditions.push(gt(hexDuelActions.id, afterId));
    }

    // Wrapped in `withSingleRetry` to ride out transient Neon transport
    // failures (cold-starts, WS reconnects, statement_timeout). The
    // first `db.select` for `hexDuelGames` above is a single row lookup
    // keyed on the PK — failing once there is highly unlikely and
    // surfaces an actual bug, so it stays un-retried; only the more
    // load-sensitive actions query gets the safety net.
    const actions = await withSingleRetryForReadOnly(() =>
      db
        .select()
        .from(hexDuelActions)
        .where(and(...conditions))
        .orderBy(asc(hexDuelActions.id))
        .limit(50),
    );

    // Match the sibling `spectate/route.ts` pattern so the two near-
    // identical files read the same way. `Math.max()` of an empty array
    // is `-Infinity`, so guard against zero results by falling back to
    // `afterId` (the last-known client checkpoint).
    const maxId =
      actions.length > 0
        ? Math.max(...actions.map((a) => a.id))
        : afterId;

    return NextResponse.json({
      success: true,
      actions: actions.map((a) => ({
        id: a.id,
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
    // is surfaced — and switch the *server-side* `errorCode` so the
    // catch block can be cross-referenced from the client's generic
    // response.
    console.error(
      "[hex-duel/multiplayer/actions] GET failed",
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
