import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { joinQueue, leaveQueue, peekMatch, queueStatus, queueLength } from "../../../../lib/last-run/matchRegistry";
import { mirrorLastRunPairing } from "../../../../lib/last-run/persistence";

export const dynamic = "force-dynamic";

/**
 * The LAST RUN queue.
 *
 *   GET    → this player's status (`idle` / `queued` / `matched` + matchId)
 *   POST   → join (idempotent); pairs the two longest-waiting players
 *   DELETE → leave the queue
 *
 * Auth is Clerk's session only. The userId is taken from the verified session,
 * never from the body, so a caller cannot queue or cancel as somebody else.
 * `name` is cosmetic and is sanitised server-side.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ success: true, ...queueStatus(userId), waiting: queueLength() });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const result = joinQueue({ userId, name: body?.name });

  // A fresh pairing opens the canonical match record (queued → forming →
  // ready). Fire-and-forget: matchmaking never waits on the database, and a
  // duplicate POST re-uses the same match instead of inserting a second row.
  if (result.status === "matched") {
    const match = peekMatch(result.matchId);
    if (match) {
      void mirrorLastRunPairing({ matchId: match.id, queuedAt: match.createdAt, playerCount: 2 });
    }
  }

  return NextResponse.json({ success: true, ...result, waiting: queueLength() });
}

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const removed = leaveQueue(userId);
  return NextResponse.json({ success: true, removed });
}
