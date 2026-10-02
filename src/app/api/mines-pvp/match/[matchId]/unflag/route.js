// src/app/api/mines-pvp/match/[matchId]/unflag/route.js
//
// POST — remove a WRONG flag marker from the caller's OWN board. Unflagging
// is a board action like reveal/flag: it is validated server-side (active
// match, timer not expired, participant, not locked) and never trusts the
// client for anything but the cell index.
//
// A CONFIRMED mine (a correct flag, which already awarded its value and counts
// toward completion) can NOT be unflagged — see `unflagTile` in the server
// store. The −10 for a wrong flag is NOT refunded; only the marker clears.
//
// The POST response returns the caller's OWN flag state only. The opponent's
// flag locations are never sent.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { unflagTile } from "../../../../../../lib/mines-pvp/serverStore";
import {
  GRID_CELLS,
  correctFlagsForSeat,
  flagsForSeat,
  normalizeFlags,
} from "../../../../../../lib/mines-pvp/constants";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

function normaliseUnflagResult(match, userId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === userId;
  const viewerSeat = viewerIsPlayer1 ? "player1" : "player2";
  const correct = correctFlagsForSeat(match, viewerSeat);
  return {
    id: match.id,
    status: match.status,
    myScore: Number(viewerIsPlayer1 ? match.p1Score : match.p2Score) || 0,
    opponentScore: Number(viewerIsPlayer1 ? match.p2Score : match.p1Score) || 0,
    myFlags: flagsForSeat(match, viewerSeat),
    myCorrectFlagCells: correct,
    myIncorrectFlagCells: normalizeFlags(flagsForSeat(match, viewerSeat)).filter(
      (c) => !correct.includes(c),
    ),
    matchDeadline: match.matchDeadline ?? null,
  };
}

export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

  const cellIndex = Number(body?.cellIndex);
  if (
    !Number.isInteger(cellIndex) ||
    cellIndex < 0 ||
    cellIndex >= GRID_CELLS
  ) {
    return NextResponse.json(
      {
        success: false,
        error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await unflagTile({ userId, matchId, cellIndex });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Same realtime contract as pick/flag: a bare refetch hint, no board data.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      matchDeadline: result.match?.matchDeadline ?? null,
      p1Score: Number(result.match?.p1Score) || 0,
      p2Score: Number(result.match?.p2Score) || 0,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseUnflagResult(result.match, userId),
        unflagged: true,
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match/unflag] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
