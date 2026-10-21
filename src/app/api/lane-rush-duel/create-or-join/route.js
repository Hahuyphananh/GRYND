// src/app/api/lane-rush-duel/create-or-join/route.js
//
// POST — stake-keyed matchmaking for Lane Rush Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition to `ready` with
//      a 3-second banner, server rolls the first-player turn order).
//   3. Otherwise → create a fresh waiting match (deduct stake, stamp the
//      host's difficulty and game state version 1 = racing).
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
    // New matches are the reworked racing game (version 1). Legacy bridge
    // rows keep version 0 and stay on the old transition path.
    gameStateVersion: Number(match.gameStateVersion) || 0,
    mode: Number(match.gameStateVersion) === 1 ? "race" : "duel",
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

  // The wager policy clamps the requested stake to the legal range (0 = a free
  // match); the store re-validates it and rejects an out-of-range value.
  const stakeAmount = normalizeStake(body?.stakeAmount, "lane-rush-duel");

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
