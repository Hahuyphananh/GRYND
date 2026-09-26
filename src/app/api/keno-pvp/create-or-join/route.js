// src/app/api/keno-pvp/create-or-join/route.js
//
// POST — stake-keyed matchmaking for the Keno Survival Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition to `ready` with a
//      3-second banner).
//   3. Otherwise → create a fresh waiting match (deduct stake).
//
// Always returns the resulting match in a normalised shape so the
// frontend can react identically to "created" vs "joined".

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { createOrJoin } from "../../../../lib/keno-pvp/serverStore";
import { normalizeStake } from "../../../../lib/games/stakes";
import {
  broadcastMatchUpdate,
  kenoPvpMatchRoom,
} from "../../../../lib/keno-pvp/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentRound: match.currentRound ?? 1,
    roundsWonPlayer1: Number(match.roundsWonPlayer1) || 0,
    roundsWonPlayer2: Number(match.roundsWonPlayer2) || 0,
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    roundDeadline: match.roundDeadline,
    winnerId: match.winnerId ?? null,
    result: match.result ?? null,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
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

  // STAKES ARE RETIRED (src/lib/games/stakes.js): a match is free to enter.
  // The requested stake is normalized to 0 so no range check can reject a
  // free match, and the store's escrow/payout arithmetic runs against 0.
  const stakeAmount = normalizeStake(body?.stakeAmount);

  try {
    const result = await createOrJoin({ userId, stakeAmount });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    const match = result.match;

    broadcastMatchUpdate(match.id, {
      status: match.status,
      joined: Boolean(result.joined),
      created: !result.joined,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(match),
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[keno-pvp/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
