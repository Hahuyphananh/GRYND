// src/app/api/roulette-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. If the
// current round's deadline has elapsed and one side is missing a bet,
// the server force-resolves the round (treating the missing side as
// having submitted empty bets). This way clients can rely on a simple
// "fetch status, render state, render wheel only if lastSpinResultIndex
// changed" loop without ever having to compute winners themselves.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
} from "../../../../../lib/roulette-pvp/serverStore";

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
    // ── Prompt 2: persistent match "points" balance ─────────────────
    // `startingPoints` is the seed each player starts with at match
    // create (server-authoritative, always 100 by spec). The two
    // per-player balances (`playerOnePoints` / `playerTwoPoints`)
    // carry between rounds — they are NOT reset to `startingPoints`
    // after each round resolves.
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

export async function GET(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Next.js 15+/16: API route `params` is a Promise — must await before
  // reading properties. Accessing it synchronously yields `undefined`,
  // which `Number(undefined)` coerces to `NaN`, which the finite-check
  // below rejects with "Invalid matchId" — masking the real match.
  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await fetchMatchWithAutoResolve(userId, matchId);
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    const match = result.match;
    let rounds = [];
    if (match && match.lastSpinResultIndex !== null) {
      rounds = await fetchMatchRounds(matchId);
    }
    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(match),
        rounds: rounds.map((r) => ({
          id: r.id,
          roundNumber: r.roundNumber,
          isSuddenDeath: r.isSuddenDeath,
          spinResultIndex: r.spinResultIndex,
          spinResult: r.spinResult,
          player1Bets: r.player1Bets,
          player2Bets: r.player2Bets,
          player1TotalBet: Number(r.player1TotalBet),
          player2TotalBet: Number(r.player2TotalBet),
          player1Payout: Number(r.player1Payout),
          player2Payout: Number(r.player2Payout),
          player1Net: Number(r.player1Net),
          player2Net: Number(r.player2Net),
          roundWinner: r.roundWinner, // 'player1' | 'player2' | null (draw)
          createdAt: r.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("[roulette-pvp/match] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
