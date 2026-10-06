// src/app/api/mines-pvp/match/[matchId]/resign/route.js
//
// POST — resign from an active Mines Duel match. The resigner forfeits
// (the opponent is named the winner) via the shared `resolveMatch` path
// in the server store. Stakes are retired, so no tokens change hands.
// Mirrors the auth / async-params / error pattern of `cancel/route.js`.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { resignMatch } from "../../../../../../lib/mines-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

export async function POST(req, { params }) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;

  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await resignMatch({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push to the match room so the resign propagates
    // without waiting for the next poll.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      resigned: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match?.status,
        resigned: true,
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match/resign] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
