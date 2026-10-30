import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getCompletionRecord } from "../../../../../../lib/last-run/matchRegistry";
import { persistLastRunCompletion } from "../../../../../../lib/last-run/persistence";
import { readLastRunMatch } from "../../../../../../lib/last-run/queries";

export const dynamic = "force-dynamic";

/**
 * The PERSISTED result of a finished match, for the viewer's own seat.
 *
 * Why this exists: the snapshot route writes progression best-effort and
 * returns immediately, so the result screen must not assume the database write
 * has landed yet. This endpoint gives the client a place to ask "is my result
 * saved, and what did my rating do?" without inventing a number.
 *
 * Behaviour:
 *   * if the in-process match is still known and final, it drives the
 *     settlement now (idempotent) and then reads it back;
 *   * the read is membership-checked — a caller who is not a seat gets 404,
 *     identical to an unknown match, so ids cannot be probed;
 *   * `success: true` means the row exists. The client only displays Elo when
 *     `rating.applied` is true and the delta is present.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const { matchId } = await params;

  // Settle now when this process still holds the match; otherwise the row was
  // written by a previous request (or by the other seat's). Never fails the
  // read: persistence swallows and logs a database error.
  const completion = getCompletionRecord(matchId, userId);
  if (completion) await persistLastRunCompletion(completion);

  const recorded = await readLastRunMatch(matchId, userId);
  if (!recorded) {
    return NextResponse.json(
      { success: false, error: "Result not recorded yet" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    success: true,
    settled: true,
    match: recorded.match,
    rating: recorded.rating,
  });
}
