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
import {
  playAiTurn,
  submitBets,
} from "../../../../../../lib/roulette-pvp/serverStore";

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

  // Skill layer: optional "call their bet" guess submitted with the
  // lock-in (string bet key, or absent/empty for no call).
  const call = body?.call ?? null;

  try {
    const result = await submitBets({ userId, matchId, bets, call });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // For AI matches, the server immediately plays the bot seat after
    // the human locks in. The client also retries this endpoint as an
    // idempotent fallback, but gameplay must not depend on the browser
    // remaining mounted after the human's POST succeeds.
    let finalMatch = result.match;
    let aiJustResolved = false;
    if (
      result.match?.isAi &&
      result.match.player1Id === userId &&
      result.match.player1Bets &&
      !result.match.player2Bets
    ) {
      const aiResult = await playAiTurn({ userId, matchId });
      if (aiResult.error) {
        console.error("[roulette-pvp/match/bet] AI turn error:", aiResult.error);
      } else {
        finalMatch = aiResult.match || finalMatch;
        aiJustResolved = Boolean(aiResult.justResolved);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(finalMatch, userId),
        justResolved: Boolean(result.justResolved || aiJustResolved),
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
