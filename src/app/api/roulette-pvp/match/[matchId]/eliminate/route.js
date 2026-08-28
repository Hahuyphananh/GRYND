// src/app/api/roulette-pvp/match/[matchId]/eliminate/route.js
//
// POST — pay ELIMINATION_COST match points to remove a single number
// from the shared wheel for the current round. Removals are visible to
// both players immediately (the board dims the dead pocket) and the
// spin is drawn from the LIVE pool only — removed numbers can never
// come up or be bet on. Capped per player per round, and the wheel
// never shrinks below MIN_LIVE_NUMBERS.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { buyElimination } from "../../../../../../lib/roulette-pvp/serverStore";
import { logError } from "../../../../../../lib/logError";

function normaliseMatch(match, viewerId) {
  if (!match) return null;
  const isPlayer1 = viewerId && match.player1Id === viewerId;
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
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    startingPoints: match.startingPoints ? Number(match.startingPoints) : 100,
    playerOnePoints: match.playerOnePoints ? Number(match.playerOnePoints) : 0,
    playerTwoPoints: match.playerTwoPoints ? Number(match.playerTwoPoints) : 0,
    roundTimer: match.roundTimerSeconds ?? 25,
    suddenDeath: Boolean(match.suddenDeath),
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    player1Bets: match.player1Bets || null,
    player2Bets: match.player2Bets || null,
    // ── Skill layer ────────────────────────────────────────────────
    serverEliminated: Array.isArray(match.serverEliminated)
      ? match.serverEliminated
      : [],
    eliminations: match.eliminations || {},
    // Per-viewer call info: only your own call is revealed live (the
    // opponent's is a private guess until the round resolves).
    myCall: isPlayer1 ? match.calls?.player1 || null : match.calls?.player2 || null,
    opponentCallMade: Boolean(isPlayer1 ? match.calls?.player2 : match.calls?.player1),
  };
}

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const number = body?.number;
  if (!Number.isFinite(Number(number))) {
    return NextResponse.json(
      { success: false, error: "A valid number is required" },
      { status: 400 },
    );
  }

  try {
    const result = await buyElimination({ userId, matchId, number });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    return NextResponse.json({
      success: true,
      data: { match: normaliseMatch(result.match, userId) },
    });
  } catch (error) {
    console.error("[roulette-pvp/match/eliminate] error:", error);
    await logError({
      errorType: "roulette_pvp_elimination_error",
      errorMessage: error instanceof Error ? error.message : "Roulette PvP elimination failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/roulette-pvp/match/[matchId]/eliminate",
      game: "Roulette PvP",
      metadata: { operation: "buy_elimination" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
