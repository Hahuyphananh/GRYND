// src/app/api/mines-pvp/create-or-join/route.js
//
// POST — stake-keyed matchmaking for Mines Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition to `ready` with
//      a 3-second banner, server rolls the first-player turn order).
//   3. Otherwise → create a fresh waiting match (deduct stake, lock
//      in the host's mine count + generate the server-authoritative
//      board).
//
// `minesCount` is REQUIRED at create time and IGNORED at join time —
// the joiner just consumes whatever mine count the host picked. This
// prevents a malicious joiner from substituting a different mine
// count to "fix" the match.
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
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    p1Pick: match.p1Pick ?? null,
    p2Pick: match.p2Pick ?? null,
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
