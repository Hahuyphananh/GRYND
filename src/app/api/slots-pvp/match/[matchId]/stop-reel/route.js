// src/app/api/slots-pvp/match/[matchId]/stop-reel/route.js
//
// POST — server-authoritative column stop for PvP Slots ("Fruit Fortune
// Survival"). The player sends the column index they want to lock (plus
// the spin number they believe is live, for the stale-round guard). The
// server validates participation / stop-order / per-column deadline and
// — when BOTH runs have ended — resolves the round in the same
// transaction.
//
// The client never submits outcomes: every column's symbols are
// generated server-side from deterministic seeds, and the grace /
// survival combo logic is entirely server-authoritative.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { stopColumn } from "../../../../../../lib/slots-pvp/serverStore.js";
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

  const columnIndex = Number(body?.columnIndex);
  const currentSpin =
    body?.currentSpin != null ? Number(body.currentSpin) : null;
  const jettison = body?.jettison === true;

  try {
    const result = await stopColumn({
      userId,
      matchId,
      columnIndex,
      currentSpin,
      jettison,
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
      runEnded: result.runEnded === true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match.status,
        seat: result.seat,
        columnStopped: result.columnStopped,
        jettisoned: result.jettisoned === true,
        runEnded: result.runEnded === true,
        survived: result.survived,
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
