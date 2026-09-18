// src/app/api/blackjack-pvp/create-or-join/route.js
//
// POST — stake-based matchmaking:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition status to round_1).
//   3. Otherwise → create a fresh waiting match (deduct stake).
//
// Always returns the resulting match in a normalised shape so the
// frontend can react identically to "created" vs "joined". Mirrors
// `src/app/api/roulette-pvp/create-or-join/route.js` so that voting
// behaviour and any client-side fanout helpers stay compatible.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import {
  attachSeatIdentity,
  createOrJoin,
} from "../../../../lib/blackjack-pvp/serverStore";
import { MAX_STAKE, MIN_STAKE } from "../../../../lib/blackjack-pvp/constants";

function normaliseMatch(match) {
  if (!match) return null;
  // Wire-only computed booleans — derived from the per-seat state
  // enum to avoid split-brain with stored denormalized columns.
  //   standing = state !== 'playing'
  const p1Standing = match.player1State !== "playing";
  const p2Standing = match.player2State !== "playing";
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    roundNumber: match.roundNumber,
    roundsWonPlayer1: match.roundsWonPlayer1,
    roundsWonPlayer2: match.roundsWonPlayer2,
    player1Hand: match.player1Hand || [],
    player2Hand: match.player2Hand || [],
    player1State: match.player1State || "playing",
    player2State: match.player2State || "playing",
    player1Standing: p1Standing,
    player2Standing: p2Standing,
    roundDeadline: match.roundDeadline,
    winner: match.winner,
    result: match.result,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    roundTimer: match.roundTimerSeconds ?? 20,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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
  if (!Number.isFinite(stakeAmount) || stakeAmount < MIN_STAKE) {
    return NextResponse.json(
      { success: false, error: "Invalid stake amount" },
      { status: 400 },
    );
  }
  if (stakeAmount > MAX_STAKE) {
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
        // Seat identity (real name / icon / name color) merged in so
        // the initial render is already correct before the first poll.
        match: await attachSeatIdentity(normaliseMatch(result.match)),
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
