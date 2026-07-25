import { auth } from "@clerk/nextjs/server";
import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
import { getNeonSql } from "../../../../../db/neon";

/**
 * Backoff (in ms) between the failed first attempt and the retry on
 * this read-only polling path. Tuned for Neon free-tier auto-suspend:
 * a cold-resuming compute typically takes a few tens of milliseconds
 * before the first query lands, so a no-backoff retry fires on the
 * same cold connection and fails identically. Belt-and-suspenders on
 * top of the neon-http transport's own internal retry — neon-http
 * already retries on 5xx / network errors via its fetch polyfill, but
 * that layer doesn't retry if the neon-serverless Pool is the
 * transport; since we now use neon-http here this is redundant but
 * cheap and keeps the contract uniform across polled routes.
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
        // Raw neon-http / Postgres / fetch fields:
        errMessage: firstErr?.message,
        errCode: firstErr?.code,
        errName: firstErr?.name,
        // DrizzleQueryError wrapper fields (if any other layer wraps):
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
 * Row shape returned by the raw neon-http query below. snake_case
 * because we hand-write the SELECT; the `.map(...)` block below
 * translates to the camelCase shape the client expects.
 */
type HexDuelActionRow = {
  id: number;
  action_type: string;
  source_key: string | null;
  target_key: string | null;
  troop_count: number | null;
  created_at: string;
};

export async function GET(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them without re-parsing req.url. Defaults are overwritten by the
  // parser below in the happy path; safe fallback values keep catch
  // diagnostics sensible if the throw happened during URL parsing
  // (gameId stays NaN, afterId stays 0).
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
    //
    // This PK lookup is intentionally still on
    // `drizzle-orm/neon-serverless` Pool: single-row PK queries
    // finish in a few ms even on a cold connection, and the second
    // SELECT (the actions one) does the heavy lifting on a different
    // transport. Mixing transports here is intentional — see the
    // comment on the actions SELECT below for the rationale.
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

    // The actions SELECT runs on the neon-http transport via
    // `getNeonSql()` instead of the default drizzle-orm/neon-serverless
    // Pool client. Why:
    //
    //  1. The Pool transport keeps a long-lived WebSocket open to the
    //     Neon compute. On free-tier Neon, auto-suspend resumes close
    //     that socket; on Vercel serverless, function idle timeouts do
    //     the same. Both produce a "stale connection" failure that
    //     Drizzle wraps as `DrizzleQueryError` with the literal
    //     message `"Failed query: ..."` — the original 500s the user
    //     reported. The retry I added previously was guessing
    //     "transient" and did not help, because the underlying socket
    //     was still stale on the second attempt.
    //  2. neon-http is stateless: each call is an independent HTTP
    //     request, with no socket to go stale. It also retries
    //     internally on 5xx / network blips via its fetch polyfill,
    //     so most transient Neon-side hiccups resolve without us
    //     seeing them.
    //  3. If anything still goes wrong here, neon-http throws the raw
    //     Postgres error (or fetch error) directly — no Drizzle
    //     wrapper — so the catch block below finally surfaces the
    //     *actual* cause (SQLSTATE code, detail, hint) instead of
    //     `"Failed query: <sql>"`.
    //
    // Tagged template literals bind `${gameId}` and `${userId}` as
    // positional parameters, so the `<>` operator has no parameter-
    // binder fragility concerns. The previous `not(eq(...))` /
    // `ne()` / raw `sql\`!= ${userId}\`` debate is now moot.
    const sql = getNeonSql();
    const rows = (await withSingleRetryForReadOnly(() =>
      afterId > 0
        ? sql`
            SELECT id, action_type, source_key, target_key, troop_count, created_at
            FROM hex_duel_actions
            WHERE game_id = ${gameId} AND user_id <> ${userId} AND id > ${afterId}
            ORDER BY id ASC
            LIMIT 50
          `
        : sql`
            SELECT id, action_type, source_key, target_key, troop_count, created_at
            FROM hex_duel_actions
            WHERE game_id = ${gameId} AND user_id <> ${userId}
            ORDER BY id ASC
            LIMIT 50
          `,
    )) as HexDuelActionRow[];

    // Translate snake_case → camelCase to match the existing client
    // contract (this route previously returned Drizzle's auto-camelCase
    // rows). `serial` / `integer` Postgres columns come back from
    // neon-http as JS numbers already; the only normalization needed is
    // the nullable `troop_count` falling back to null (not undefined)
    // for type stability with the previous Drizzle return shape.
    const actions = rows.map((r) => ({
      id: r.id,
      actionType: r.action_type,
      sourceKey: r.source_key,
      targetKey: r.target_key,
      troopCount: r.troop_count ?? null,
      createdAt: r.created_at,
    }));

    // Match the sibling `spectate/route.ts` pattern. `Math.max()` of
    // an empty array is `-Infinity`, so guard against zero results by
    // falling back to `afterId` (the last-known client checkpoint).
    const maxId =
      actions.length > 0
        ? Math.max(...actions.map((a) => a.id))
        : afterId;

    return NextResponse.json({
      success: true,
      actions,
      latestActionId: maxId,
    });
  } catch (error: any) {
    // Capture BOTH the raw neon-http / Postgres / fetch error AND the
    // DrizzleQueryError `.cause` chain. On neon-http, `error.code` is
    // the Postgres SQLSTATE (e.g. "57014" statement_timeout, "53300"
    // too_many_connections). On Drizzle wrappers (the game-lookup
    // SELECT above still uses drizzle), the real error sits on
    // `.cause.code` and `.cause.detail`.
    //
    // The previous patch only logged `error.message` and a few
    // `.cause.*` fields — which produced only the useless
    // `"Failed query: <sql>"` wrapper text for the failing actions
    // SELECT and gave us nothing to act on. With neon-http, the
    // raw SQLSTATE / detail will finally surface and we can ship a
    // targeted fix instead of guessing.
    //
    // `gameId` / `afterId` are hoisted above so they are in scope
    // here even when the failure happened before/during URL parsing.
    console.error(
      "[hex-duel/multiplayer/actions] GET failed",
      {
        url: req.url,
        gameId,
        afterId,
        // Direct (neon-http raw / Postgres / fetch) fields:
        err: error?.message,
        errName: error?.name,
        errCode: error?.code,
        errSeverity: error?.severity,
        errDetail: error?.detail,
        errHint: error?.hint,
        // DrizzleQueryError wrapper fields (game-lookup SELECT path):
        causeMessage: error?.cause?.message,
        causeCode: error?.cause?.code,
        causeName: error?.cause?.name,
        causeDetail: error?.cause?.detail,
        causeHint: error?.cause?.hint,
        causeStack: error?.cause?.stack,
        stack: error?.stack,
      },
    );
    // Client-facing message stays generic — Postgres cause messages
    // can leak schema internals (table/column names, constraint
    // names), so we keep the diagnostic at the log layer and send
    // the client a stable, opaque message.
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
