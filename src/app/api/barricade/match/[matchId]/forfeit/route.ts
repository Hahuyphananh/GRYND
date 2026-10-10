// src/app/api/barricade/match/[matchId]/forfeit/route.ts
//
// POST — resign an active match. The opponent is awarded the win and the match
// is settled through the same path a played-out victory uses (exactly once).
//
// Only a participant can resign, and only from their own seat: the store
// resolves the caller's seat from the row, so an unrelated account gets a 403
// and a seat can never resign on the opponent's behalf. The position is left
// exactly as the engine last wrote it — resigning does not move a pawn.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  forfeitMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/barricade/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/barricade/rooms";

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
      version: result.match.ply,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
      resultReason: result.match.resultReason ?? null,
      forfeited: true,
    });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "barricade_forfeit_error",
      errorMessage:
        error instanceof Error ? error.message : "Barricade forfeit failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/barricade/match/[matchId]/forfeit",
      game: "Barricade",
      metadata: { operation: "forfeit" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
