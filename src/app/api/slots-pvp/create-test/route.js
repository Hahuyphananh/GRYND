// src/app/api/slots-pvp/create-test/route.js
//
// POST — start a PRACTICE match against the test bot ("Test vs Bot").
//
// This is the explicit alternative to the old behaviour where a real
// "Play" click could match the user against one of the developer's
// test accounts. The main matchmaker now excludes test-account lobbies
// entirely; this route is the only way to play one of them. The match
// is FREE PLAY (mirrors dice-flush / farkle AI mode): no stake is
// escrowed from either side and no payout is credited at settlement —
// the bot seat is driven by the server's poll-time auto-stop at a fast
// cadence, so the human player gets a live-feeling opponent.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  createTestMatch,
  enrichMatchesWithUsers,
} from "../../../../lib/slots-pvp/serverStore.js";
import { MIN_STAKE, MAX_STAKE } from "../../../../lib/slots-pvp/constants.js";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    theme: match.theme || "fruit",
    status: match.status,
    currentSpin: match.currentSpin ?? 1,
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
    players: match.players ?? null,
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
    body = {};
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
    const result = await createTestMatch({ userId, stakeAmount });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Enrich with user names + profile images (best-effort, mirrors
    // create-or-join) so the match view renders real player heads.
    let match = result.match;
    try {
      const e = await enrichMatchesWithUsers(match);
      if (e) match = e;
    } catch (err) {
      console.warn(
        "[slots-pvp/create-test] user enrichment failed:",
        err && err.message ? err.message : err,
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(match),
        test: true,
      },
    });
  } catch (error) {
    console.error("[slots-pvp/create-test] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
