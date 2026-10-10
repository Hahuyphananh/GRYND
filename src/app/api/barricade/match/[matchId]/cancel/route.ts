// src/app/api/barricade/match/[matchId]/cancel/route.ts
//
// POST — close the caller's own OPEN lobby (nothing has settled, so no result is
// recorded and no rating/stat moves). Only the creator, and only while the row
// is still `waiting` with an empty second seat: the store enforces both, so a
// player can never cancel a live match or someone else's lobby.
//
// This is what makes an abandoned lobby disappear instead of lingering in the
// open-lobby list forever.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  cancelMatch,
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
    const result = await cancelMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      cancelled: true,
    });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "barricade_cancel_error",
      errorMessage:
        error instanceof Error ? error.message : "Barricade lobby cancel failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/barricade/match/[matchId]/cancel",
      game: "Barricade",
      metadata: { operation: "cancel" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
