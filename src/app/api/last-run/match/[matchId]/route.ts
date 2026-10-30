import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getCompletionRecord, getSnapshot } from "../../../../../lib/last-run/matchRegistry";
import { markLastRunStarted, persistLastRunCompletion } from "../../../../../lib/last-run/persistence";
import { readLastRunMatch } from "../../../../../lib/last-run/queries";

export const dynamic = "force-dynamic";

/**
 * The authoritative match snapshot.
 *
 * A client polls this. Every number it returns — distance, height, alive, tick,
 * outcome — is produced by the shared engine from inputs the server accepted.
 * A caller who does not hold a seat in the match gets 404, so knowing a match id
 * is not enough to watch, join or submit.
 *
 * Progression side effects hang off the SAME authoritative snapshot: the first
 * racing read records the canonical `started` transition, and the first read
 * that carries a final result records it once (idempotent at the database via a
 * deterministic event id). Both are fire-and-forget, so a slow or failing write
 * can never delay the result screen.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const { matchId } = await params;
  const snapshot = getSnapshot({ matchId, userId });
  if (!snapshot) {
    // The in-process registry only holds a live match. A refresh after a
    // restart, or a result screen reopened later, falls back to the durable
    // record — still membership-checked, still viewer-relative. An id that is
    // not the caller's match reads as "not found" in both paths.
    const recorded = await readLastRunMatch(matchId, userId);
    if (!recorded) {
      return NextResponse.json({ success: false, error: "Match not found" }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      snapshot: null,
      recorded: recorded.match,
      rating: recorded.rating,
    });
  }

  if (snapshot.phase === "racing") {
    void markLastRunStarted({ matchId, at: snapshot.startsAt });
  }
  if (snapshot.final) {
    const completion = getCompletionRecord(matchId, userId);
    if (completion) void persistLastRunCompletion(completion);
  }

  return NextResponse.json({ success: true, snapshot });
}
