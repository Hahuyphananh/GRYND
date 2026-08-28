// src/app/api/roulette-pvp/create-or-join/route.js
//
// POST — stake-based matchmaking:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition status to round_1).
//   3. Otherwise → create a fresh waiting match (deduct stake).
//
// Always returns the resulting match in a normalised shape so the
// frontend can react identically to "created" vs "joined".

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createOrJoin } from "../../../../lib/roulette-pvp/serverStore";
import { logError } from "../../../../lib/logError";

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

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const stakeAmount = Number(body?.stakeAmount);
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    return NextResponse.json(
      { success: false, error: "Invalid stake amount" },
      { status: 400 },
    );
  }

  // Hard cap matching the rounding precision of the user's balance.
  if (stakeAmount > 1000000) {
    return NextResponse.json(
      { success: false, error: "Stake exceeds maximum limit" },
      { status: 400 },
    );
  }

  try {
    const result = await createOrJoin({
      userId,
      stakeAmount,
    });

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
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[roulette-pvp/create-or-join] error:", error);
    await logError({
      errorType: "roulette_pvp_matchmaking_error",
      errorMessage: error instanceof Error ? error.message : "Roulette PvP matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/roulette-pvp/create-or-join",
      game: "Roulette PvP",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
