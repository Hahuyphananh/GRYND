// src/app/api/battleship/match/[matchId]/resign/route.ts
//
// POST — resign the caller's LIVE match.
//
// The body is empty. The seat comes from the Clerk gate and the winner is the
// OTHER seat, decided by the store; a request can never name a winner, a seat or
// a player id. A waiting lobby is cancelled through its own route, and a settled
// match is a 409.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, resignMatch } from "../../../../../../lib/battleship/serverStore";
import { publishForfeit } from "../../../../../../lib/battleship/publish";

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
    const result = await resignMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // The store recorded the winner; the route never computes or accepts one.
    publishForfeit({
      matchId,
      seat: result.winnerSeat,
      reason: "resigned",
      cancelled: false,
    });

    return NextResponse.json({
      success: true,
      data: { resigned: true, winnerSeat: result.winnerSeat },
    });
  } catch (error) {
    await logError({
      errorType: "battleship_resign_error",
      errorMessage: error instanceof Error ? error.message : "Battleship resign failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/match/[matchId]/resign",
      game: "Battleship",
      metadata: { operation: "resign_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
