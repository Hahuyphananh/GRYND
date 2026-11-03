// src/app/api/battleship/match/[matchId]/cancel/route.ts
//
// POST — close the caller's own WAITING lobby.
//
// Same shape as every other lobby cancellation: host only, waiting only, decided
// by the store (not by the route) and recorded on the canonical match lifecycle.
// A live match is never cancelled by this endpoint.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { cancelMatch, isMatchId } from "../../../../../../lib/battleship/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/battleship/rooms";

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
    const result = await cancelMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    broadcastMatchUpdate(matchId, { phase: result.dto.phase });
    return NextResponse.json({ success: true, data: result.dto });
  } catch (error) {
    await logError({
      errorType: "battleship_cancel_error",
      errorMessage: error instanceof Error ? error.message : "Battleship cancel failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/match/[matchId]/cancel",
      game: "Battleship",
      metadata: { operation: "cancel_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
