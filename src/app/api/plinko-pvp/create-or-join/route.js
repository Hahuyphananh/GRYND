// src/app/api/plinko-pvp/create-or-join/route.js
//
// POST — stake-keyed matchmaking for Plinko Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition status to
//      `ready` with a 3-second banner; ball_1 opens once the
//      banner expires via /status auto-advance).
//   3. Otherwise → create a fresh waiting match (deduct stake).
//
// Unlike mines-pvp there's no host-picked game param (minesCount)
// — the only player input at create time is the stake. The joiner
// just consumes whatever stake the host picked.
//
// Always returns the resulting match in a normalised shape so the
// frontend can react identically to "created" vs "joined".

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createOrJoin } from "../../../../lib/plinko-pvp/serverStore";
import {
  MAX_STAKE,
  MIN_STAKE,
} from "../../../../lib/plinko-pvp/constants";
import { broadcastMatchUpdate } from "../../../../lib/plinko-pvp/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentBall: match.currentBall ?? 1,
    p1Score: match.p1Score ?? 0,
    p2Score: match.p2Score ?? 0,
    // p1/p2CurrentInputs are the "ball in flight" indicators. They're
    // cleared after the ball resolves; the client can use them to
    // render a "waiting for opponent" hint on the commit panel. The
    // per-viewer derived flags (viewerCanLaunch / viewerHasCommitted /
    // opponentHasCommitted / viewerCanCancel) are set in the GET
    // match route's per-viewer normaliser — this create-or-join
    // response just needs the raw state for the redirect.
    p1CurrentInputs: match.p1CurrentInputs || null,
    p2CurrentInputs: match.p2CurrentInputs || null,
    roundDeadline: match.roundDeadline,
    roundTimer: match.roundTimerSeconds ?? 20,
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
  } catch {
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
    const result = await createOrJoin({ userId, stakeAmount });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    const match = result.match;

    // Best-effort push to the match room so the opponent sees the
    // status flip (waiting → ready) without waiting for the next
    // 1.5s poll. The helper internally handles the no-op case when
    // the realtime-server runs in a separate process.
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
    console.error("[plinko-pvp/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
