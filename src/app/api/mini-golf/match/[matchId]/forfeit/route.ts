// src/app/api/mini-golf/match/[matchId]/forfeit/route.ts
//
// POST — concede an active match. The opponent is awarded the win and the
// match settles through exactly the same path as a played-out victory
// (existing rating/trophy infrastructure, exactly once).

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  forfeitMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/mini-golf/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mini-golf/rooms";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
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
        { status: result.status },
      );
    }
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: true,
      result: result.match.result ?? null,
      matchCompleted: true,
      stages: ["MATCH_COMPLETED"],
    });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "mini_golf_forfeit_error",
      errorMessage:
        error instanceof Error ? error.message : "Mini Golf forfeit failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/mini-golf/match/[matchId]/forfeit",
      game: "Mini Golf",
      metadata: { operation: "forfeit" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
