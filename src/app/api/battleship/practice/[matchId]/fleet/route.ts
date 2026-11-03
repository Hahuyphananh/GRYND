// src/app/api/battleship/practice/[matchId]/fleet/route.ts
//
// POST — confirm the human's fleet in a PRACTICE match.
//
// The body is still exactly `{ ships }`: the bot's fleet was written at creation,
// and confirming here is what opens combat (the store then commits the bot's
// first shot before the human can submit one).

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { confirmFleet, isMatchId } from "../../../../../../lib/battleship/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/battleship/rooms";

export async function POST(
  req: Request,
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

  const body = (await req.json().catch(() => ({}))) as { ships?: unknown };
  if (!Array.isArray(body?.ships)) {
    return NextResponse.json(
      { success: false, error: "ships must be an array of ship placements" },
      { status: 400 },
    );
  }

  try {
    const result = await confirmFleet({ userId, matchId, ships: body.ships });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    if (result.dto.isAi !== true) {
      return NextResponse.json(
        { success: false, error: "This is not a practice match" },
        { status: 403 },
      );
    }

    broadcastMatchUpdate(matchId, {
      phase: result.dto.phase,
      round: result.dto.round,
      seat: result.dto.you.seat,
    });

    return NextResponse.json({
      success: true,
      data: { ...result.dto, confirmed: result.confirmed },
    });
  } catch (error) {
    await logError({
      errorType: "battleship_practice_fleet_error",
      errorMessage:
        error instanceof Error ? error.message : "Battleship practice fleet confirm failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/practice/[matchId]/fleet",
      game: "Battleship",
      metadata: { operation: "practice_confirm_fleet" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
