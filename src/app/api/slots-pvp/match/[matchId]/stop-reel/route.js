// src/app/api/slots-pvp/match/[matchId]/stop-reel/route.js
//
// POST — server-authoritative reel stop for PvP Slots. The player
// sends the reel index they want to lock (plus the spin number they
// believe is live, for the stale-round guard). The server validates
// participation / one-shot lock-in / deadline and — when BOTH boards
// are locked — resolves the round in the same transaction.
//
// The client never submits scores: the outcome reels + stop-accuracy
// offsets are generated and recorded server-side only.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { stopReel } from "../../../../../../lib/slots-pvp/serverStore.js";
import { broadcastMatchUpdate } from "../../../../../../lib/slots-pvp/rooms.js";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

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
    body = {};
  }

  const reelIndex = Number(body?.reelIndex);
  const currentSpin =
    body?.currentSpin != null ? Number(body.currentSpin) : null;

  try {
    const result = await stopReel({
      userId,
      matchId,
      reelIndex,
      currentSpin,
    });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the opponent sees the stop / round
    // resolution without waiting for the next poll.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      roundResolved: result.roundResolved === true,
      boardLocked: result.boardLocked === true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match.status,
        seat: result.seat,
        reelStopped: result.reelStopped,
        boardLocked: result.boardLocked === true,
        roundResolved: result.roundResolved === true,
      },
    });
  } catch (error) {
    console.error("[slots-pvp/match/stop-reel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
