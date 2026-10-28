// src/app/api/jobs/rank-snapshots/route.ts
//
// GET /api/jobs/rank-snapshots — the DAILY pass that records every ranked
// player's Overall Elo position for the current UTC day.
//
// WHY IT EXISTS
// -------------
// The GRYND PRO dashboard charts how a player's overall ranking moves over
// time. Elo and trophy history can be rebuilt from the settlement journals
// (`rating_events` / `trophy_events`), but a RANK cannot: it is a position
// among everyone else at one instant, and the platform only stores the CURRENT
// position. `player_rank_snapshots` (migration 0216) records it as the days
// pass, and this is the pass that does it for the whole population.
//
// ONE STATEMENT, IDEMPOTENT
// -------------------------
// The whole sweep is a single INSERT ... SELECT over the eligible players with
// `ON CONFLICT (user_id, bucket) DO UPDATE`, so:
//   * it never queries per player (no N+1), and the grouping rides the
//     `player_ratings` indexes,
//   * re-running it — or racing a player's own dashboard read, which captures
//     the same bucket for that player — can never create a second row for the
//     same player and day,
//   * players who are not ranked yet (fewer than 3 established game ratings)
//     are simply absent: there is no position to record, and the dashboard says
//     the curve has not started rather than plotting a fabricated rank.
//
// It is scheduled on the Oracle host by `grynd-job-rank-snapshots.timer`
// (deploy/jobs/), daily off-peak. Wire the same route into any other scheduler
// with the CRON_SECRET bearer token the platform's other jobs use
// (src/lib/security/cronAuth).
//
// READ/WRITE SCOPE: it writes ONLY its own snapshot table. No rating, trophy,
// match, subscription or user row is read or written anywhere in this file.

import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import {
  captureRankSnapshotsForAllRanked,
  utcDayBucket,
} from "../../../../lib/stats/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const bucket = utcDayBucket();

  try {
    const captured = await captureRankSnapshotsForAllRanked(bucket);
    return Response.json({ success: true, bucket, captured });
  } catch (error) {
    console.error("[jobs/rank-snapshots] sweep failed:", error);
    return Response.json(
      { success: false, bucket, error: "Rank snapshot sweep failed" },
      { status: 500 },
    );
  }
}
