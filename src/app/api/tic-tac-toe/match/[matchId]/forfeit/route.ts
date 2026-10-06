// src/app/api/tic-tac-toe/match/[matchId]/forfeit/route.ts
//
// POST — concede an active match. The opponent is awarded the win and the match
// settles through exactly the same path as a played-out victory (existing
// rating/trophy infrastructure, exactly once).

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import {
  forfeitMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/tic-tac-toe/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/tic-tac-toe/rooms";

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
        { status: result.status },
      );
    }
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: true,
      result: result.match.result ?? null,
      matchCompleted: true,
    });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "tic_tac_toe_forfeit_error",
      errorMessage:
        error instanceof Error ? error.message : "Tic-Tac-Toe forfeit failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tic-tac-toe/match/[matchId]/forfeit",
      game: "Tic-Tac-Toe",
      metadata: { operation: "forfeit" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
