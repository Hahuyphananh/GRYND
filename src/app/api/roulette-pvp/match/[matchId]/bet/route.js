// src/app/api/roulette-pvp/match/[matchId]/bet/route.js
//
// POST — submit (or replace) the calling player's bets for the current
// round. Server validates total ≤ caller's CURRENT match "points"
// balance (persistent across rounds, never reset).
//
// If both players end up with non-null bets after this call, the server
// resolves the round automatically (see serverStore.resolveRound) and
// returns the post-resolution state. Otherwise the response simply
// reflects the stored bets and `justResolved: false`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { submitBets } from "../../../../../../lib/roulette-pvp/serverStore";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
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
    // ── Prompt 2: persistent match "points" balance ───────────────
    startingPoints: match.startingPoints
      ? Number(match.startingPoints)
      : 100,
    playerOnePoints: match.playerOnePoints
      ? Number(match.playerOnePoints)
      : 0,
    playerTwoPoints: match.playerTwoPoints
      ? Number(match.playerTwoPoints)
      : 0,
    roundTimer: match.roundTimerSeconds ?? 25,
    suddenDeath: Boolean(match.suddenDeath),
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    player1Bets: match.player1Bets || null,
    player2Bets: match.player2Bets || null,
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

  const matchId = Number(params?.matchId);
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

  const bets = body?.bets;
  if (!bets || typeof bets !== "object") {
    return NextResponse.json(
      { success: false, error: "Bets must be a JSON object" },
      { status: 400 },
    );
  }

  try {
    const result = await submitBets({ userId, matchId, bets });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(result.match),
        justResolved: Boolean(result.justResolved),
      },
    });
  } catch (error) {
    console.error("[roulette-pvp/match/bet] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
