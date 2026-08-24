// POST — create a free human-vs-AI Blackjack match.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createAiMatch, playAiTurn } from "../../../../lib/blackjack-pvp/serverStore";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    roundNumber: match.roundNumber,
    roundsWonPlayer1: Number(match.roundsWonPlayer1 || 0),
    roundsWonPlayer2: Number(match.roundsWonPlayer2 || 0),
    player1Hand: match.player1Hand || [],
    // Never expose the bot's live cards before the normal match GET
    // applies the same opponent-hand scrubbing used by PvP.
    player2Hand: Array.isArray(match.player2Hand)
      ? match.player2Hand.map(() => ({ suit: "?", value: "?" }))
      : [],
    player1State: match.player1State || "playing",
    player2State: "playing",
    player1Standing: match.player1State !== "playing",
    player2Standing: match.player2State !== "playing",
    roundDeadline: match.roundDeadline,
    winner: match.winner,
    result: match.result,
    prizePaid: 0,
    houseFee: 0,
    roundTimer: match.roundTimerSeconds ?? 30,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const result = await createAiMatch({ userId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Let the server make the first bot decision immediately. This is
    // best-effort; status polling remains the recovery path.
    let aiResult = { match: result.match, actions: 0 };
    try {
      aiResult = await playAiTurn({ userId, matchId: result.match.id });
    } catch (error) {
      console.error("[blackjack-pvp/create-ai] initial AI turn failed:", error);
    }
    const match = aiResult.match || result.match;

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(match),
        joined: true,
        aiActions: Number(aiResult.actions || 0),
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
