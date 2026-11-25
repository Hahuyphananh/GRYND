// src/app/api/jobs/solitaire-ghost-pool/route.ts
//
// GET /api/jobs/solitaire-ghost-pool — record ghost runs from finished matches.
//
// WHY IT EXISTS
// -------------
// Ranked Solitaire keeps its live queue and falls back to a recorded replay of
// another real player's run of the SAME deal when nobody joins. Those runs live
// in `solitaire_ghost_runs`, and this job fills that table from HISTORY: every
// finished ranked duel whose log still replays (its board was never re-dealt)
// becomes one or two pool rows. Running it after a deploy is what makes the
// pool warm immediately instead of only after the next human duel finishes —
// and re-running it after the retention sweep refills anything that was pruned.
//
// WHAT IT WRITES
// --------------
// ONLY its own pool table, and only INSERTs, guarded by
// `ON CONFLICT (source_match_id, source_seat) DO NOTHING`. It reads finished
// matches and their stored move logs; it never reads or writes a rating,
// trophy, warer, user, live match, queue request or ghost match row.
//
// IDEMPOTENT
// ----------
// The candidate query skips matches already recorded, and the insert conflicts
// are no-ops, so a retried call, an overlapping tick or two schedulers racing
// cannot duplicate a run.
//
// Scheduled by `grynd-job-solitaire-ghost-pool.timer` (deploy/jobs/, every ten
// minutes) and by the same route's Vercel Cron entry, both carrying the
// platform's CRON_SECRET bearer token (src/lib/security/cronAuth).

import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import { db } from "../../../../db/client";
import { backfillGhostRuns } from "../../../../lib/solitaire-duel/ghosts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  // Bounded per tick, so a scheduler can never turn one call into a full
  // history walk. One match yields at most two runs (one per replayable seat).
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(200, requested) : 50;

  try {
    const result = await backfillGhostRuns(db, { limit });
    return Response.json({ success: true, limit, ...result });
  } catch (error) {
    console.error("[jobs/solitaire-ghost-pool] backfill failed:", error);
    return Response.json(
      { success: false, error: "Ghost pool backfill failed" },
      { status: 500 },
    );
  }
}
