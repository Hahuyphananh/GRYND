// src/app/api/mines-pvp/create-or-join/route.js
//
// POST — stake-keyed matchmaking for Mines Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (transition to `ready`; a 3-second banner
//      runs, then both players start simultaneously).
//   3. Otherwise → create a fresh waiting match and generate the two
//      server-authoritative boards.
//
// `minesCount` is fixed server-side (10 on the 10×10 board) and is
// IGNORED — a client can never pick a different mine count.
//
// Always returns the resulting match in a normalised shape so the
// frontend can react identically to "created" vs "joined".

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { createOrJoin } from "../../../../lib/mines-pvp/serverStore";
import { normalizeStake } from "../../../../lib/games/stakes";
import {
  broadcastMatchUpdate,
  minesPvpMatchRoom,
} from "../../../../lib/mines-pvp/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  // Simultaneous model — no turn fields. Both seats play at will from the
  // one server-authoritative clock; the viewer's own board state arrives on
  // the subsequent /match/:id status fetch.
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    status: match.status,
    matchTimerSeconds: Number(match.matchTimerSeconds) || 0,
    matchDeadline: match.matchDeadline ?? null,
    myFlags: [],
    myScore: 0,
    opponentScore: 0,
    winReason: match.winReason ?? null,
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

  // minesCount is required at CREATE time. The server store's
  // validateMatchParams re-validates both stake + mines with a
  // clean 400 — NaN / out-of-range / non-integer are all rejected
  // there, so we just forward through.
  const minesCount = Number(body?.minesCount);

  try {
    const result = await createOrJoin({ userId, stakeAmount, minesCount });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    const match = result.match;

    // Best-effort push to the match room + lobby room. The helper
    // internally handles the no-op case when the realtime-server
    // runs in a separate process (the 1.5s client polling
    // fallback covers that case).
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
        match: normaliseMatch(match),
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
