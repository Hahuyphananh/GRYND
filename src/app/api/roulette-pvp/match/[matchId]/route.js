// src/app/api/roulette-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. If the
// current round's deadline has elapsed and one side is missing a bet,
// the server force-resolves the round (treating the missing side as
// having submitted empty bets). This way clients can rely on a simple
// "fetch status, render state, render wheel only if lastSpinResultIndex
// changed" loop without ever having to compute winners themselves.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
} from "../../../../../lib/roulette-pvp/serverStore";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";

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

export async function GET(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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
    // Real seat identity (username + official icon + equipped name
    // color) for both seats. One query for both; the AI seat stays null
    // and the client falls back to its localized "GRYND AI" label.
    const identity = await getSeatIdentity(
      match?.player1Id,
      match?.player2Id,
    );
    let rounds = [];
    if (match && match.lastSpinResultIndex !== null) {
      rounds = await fetchMatchRounds(matchId);
    }
    return NextResponse.json({
      success: true,
      data: {
        match: {
          ...normaliseMatch(match, userId),
          player1Name: identity.player1?.name ?? null,
          player1IconKey: identity.player1?.iconKey ?? null,
          player1NameColor: identity.player1?.nameColor ?? null,
          player2Name: identity.player2?.name ?? null,
          player2IconKey: identity.player2?.iconKey ?? null,
          player2NameColor: identity.player2?.nameColor ?? null,
        },
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
          serverEliminated: Array.isArray(r.serverEliminated)
            ? r.serverEliminated
            : [],
          eliminations: r.eliminations || {},
          calls: r.calls || {},
          callResults: r.callResults || {},
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
