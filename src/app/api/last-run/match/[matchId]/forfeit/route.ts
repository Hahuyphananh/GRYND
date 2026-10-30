import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { forfeitMatch, getCompletionRecord } from "../../../../../../lib/last-run/matchRegistry";
import { persistLastRunCompletion } from "../../../../../../lib/last-run/persistence";

export const dynamic = "force-dynamic";

/**
 * Leave a live match (navigation away, explicit quit, disconnect).
 *
 * Deliberately idempotent: the first call finalises the match and every later
 * call returns the SAME result, so a retried request can never settle twice or
 * flip the winner. The progression write uses the same deterministic event id,
 * so a duplicate submission cannot create a second match record either.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const { matchId } = await params;
  const result = forfeitMatch({ matchId, userId, reason: "left" });
  if (!result) return NextResponse.json({ success: false, error: "Match not found" }, { status: 404 });

  const completion = getCompletionRecord(matchId, userId);
  if (completion) void persistLastRunCompletion(completion);

  return NextResponse.json({ success: true, final: result });
}
