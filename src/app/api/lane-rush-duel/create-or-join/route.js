// src/app/api/lane-rush-duel/create-or-join/route.js
//
// POST — stake-keyed matchmaking for Lane Rush Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition to `ready` with
//      a 3-second banner, server rolls the first-player turn order).
//   3. Otherwise → create a fresh waiting match (deduct stake, lock
//      in the host's difficulty + provably-fair shared bridge).
//
// `difficulty` is REQUIRED at create time and IGNORED at join time —
// the joiner just consumes whatever difficulty the host picked.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { createOrJoin } from "../../../../lib/lane-rush-duel/serverStore";
import { attachSeatIdentity } from "../../../../lib/seatIdentity";
import { normalizeStake } from "../../../../lib/games/stakes";
import {
  broadcastMatchUpdate,
  laneRushDuelMatchRoom,
} from "../../../../lib/lane-rush-duel/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    difficulty: match.difficulty,
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    serverSeedHash: match.serverSeedHash,
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

  const vsBot = Boolean(body?.vsBot);

  // STAKES ARE RETIRED (src/lib/games/stakes.js): every match — practice or
  // ranked — is free to enter. The requested stake is normalized to 0 so no
  // range check can reject a free match, and the store's escrow/payout
  // arithmetic runs against 0.
  const stakeAmount = normalizeStake(body?.stakeAmount);

  const difficulty = String(body?.difficulty || "easy").toLowerCase();

  try {
    const result = await createOrJoin({
      userId,
      stakeAmount,
      difficulty,
      vsBot,
    });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    const match = result.match;

    if (result.joined) {
      broadcastMatchUpdate(match.id, {
        status: match.status,
        joined: true,
      });
    } else {
      broadcastMatchUpdate(match.id, {
        status: match.status,
        created: true,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        // Seat identity (real name / icon / name color) merged in so
        // the initial render is already correct before the first poll.
        match: await attachSeatIdentity(normaliseMatch(match)),
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
