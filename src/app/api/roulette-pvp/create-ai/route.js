// POST — create a free human-vs-AI Roulette match.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { createAiMatch } from "../../../../lib/roulette-pvp/serverStore";
import { attachSeatIdentity } from "../../../../lib/seatIdentity";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentRound: match.currentRound,
    scorePlayer1: match.scorePlayer1,
    scorePlayer2: match.scorePlayer2,
    roundDeadline: match.roundDeadline,
    lastSpinResultIndex: match.lastSpinResultIndex,
    lastSpinResult: match.lastSpinResult,
    winnerId: match.winnerId,
    result: match.result,
    prizePaid: Number(match.prizePaid || 0),
    houseFee: Number(match.houseFee || 0),
    startingPoints: Number(match.startingPoints || 100),
    playerOnePoints: Number(match.playerOnePoints || 100),
    playerTwoPoints: Number(match.playerTwoPoints || 100),
    roundTimer: match.roundTimerSeconds ?? 20,
    suddenDeath: Boolean(match.suddenDeath),
    startedAt: match.startedAt,
    endedAt: match.endedAt,
  };
}

export async function POST() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  try {
    const result = await createAiMatch({ userId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    return NextResponse.json({
      success: true,
      data: {
        // Seat identity (real name / icon / name color) merged in so
        // the initial render is already correct before the first poll.
        match: await attachSeatIdentity(normaliseMatch(result.match)),
        joined: true,
      },
    });
  } catch (error) {
    console.error("[roulette-pvp/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
