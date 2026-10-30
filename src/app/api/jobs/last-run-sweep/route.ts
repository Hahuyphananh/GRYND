// src/app/api/jobs/last-run-sweep/route.ts
//
// GET /api/jobs/last-run-sweep — close LAST RUN lifecycle rows that can never
// finish.
//
// WHY
//   A match is simulated inside the Next.js process. If BOTH players disappear
//   before any authorised request observes the final state (tabs closed, host
//   restarted mid-race), nothing ever writes the completion, and the
//   `match_lifecycle` row stays `started` forever. Those rows are noise for
//   every queue/latency query and would make "in flight" counts drift.
//
// WHAT IT DOES — AND DOES NOT DO
//   It moves only `match_lifecycle` rows of THIS game from `started` to
//   `failed` after a generous grace window (well beyond the 75 s course cap and
//   the match registry's own retention). It never writes a `last_run_matches`
//   row, never picks a winner, never touches a rating and never touches another
//   game's rows. An interrupted match therefore stays out of history and out of
//   Elo — exactly what "no result" means.
//
// Auth: the platform's cron guard (`CRON_SECRET` bearer). Fails closed.

import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";

import { db } from "../../../../db";
import { matchLifecycle } from "../../../../db/schema";
import { LAST_RUN_GAME_KEY } from "../../../../lib/last-run/constants";
import {
  canTransitionMatchLifecycle,
  type MatchLifecycleStatus,
} from "../../../../lib/matchLifecycle";
import { transitionMatchLifecycle } from "../../../../lib/matchLifecycleStore";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

export const dynamic = "force-dynamic";

/** Far beyond MATCH_MAX_MS (75 s) — only genuinely abandoned rows qualify. */
const STALE_AFTER_MS = 10 * 60_000;
const BATCH = 50;

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  try {
    const stale = await db
      .select({ matchId: matchLifecycle.matchId, status: matchLifecycle.status })
      .from(matchLifecycle)
      .where(
        and(
          eq(matchLifecycle.gameKey, LAST_RUN_GAME_KEY),
          eq(matchLifecycle.status, "started"),
          lt(matchLifecycle.updatedAt, cutoff),
        ),
      )
      .limit(BATCH);

    let closed = 0;
    for (const row of stale) {
      if (!canTransitionMatchLifecycle(row.status as MatchLifecycleStatus, "failed")) continue;
      try {
        await transitionMatchLifecycle({
          matchId: row.matchId,
          to: "failed",
          at: new Date(),
          playerCount: 2,
        });
        closed += 1;
      } catch (error) {
        console.error(
          "[last-run-sweep] failed to close",
          row.matchId,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return NextResponse.json({ ok: true, scanned: stale.length, closed });
  } catch (error) {
    console.error("[last-run-sweep] failed:", error);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
