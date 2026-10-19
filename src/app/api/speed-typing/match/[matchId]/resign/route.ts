// src/app/api/speed-typing/match/[matchId]/resign/route.ts
//
// POST — resign a live Speed Typing race. This is the same authoritative
// settlement the realtime disconnect path uses (`forfeitMatch`): the other
// seat wins through the normal rating/trophy writers, once. Session
// authenticated, so a caller can only forfeit their own seat.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import {
  forfeitMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/speed-typing/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/speed-typing/realtime";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await forfeitMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: Number(result.status) || 400 },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: result.forfeited === true,
      cancelled: result.cancelled === true,
      reason: "resign",
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        forfeited: result.forfeited === true,
        cancelled: result.cancelled === true,
      },
    });
  } catch (error) {
    console.error("[speed-typing/resign] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
