// src/app/api/keno-pvp/match/[matchId]/resign/route.js
//
// POST — resign a live Keno Duel. This is the same settlement the realtime
// server performs when a seat stays disconnected past its grace window
// (`forfeitMatch`), but authorised by the caller's own session instead of a
// socket token. The seat is resolved from the store's own columns, so a caller
// can only ever forfeit their own side.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { forfeitMatch } from "../../../../../../lib/keno-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/keno-pvp/rooms";

export const dynamic = "force-dynamic";

export async function POST(_req, { params }) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  const resolved = (await params) || {};
  const matchId = Number(resolved?.matchId);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await forfeitMatch({ loserClerkId: userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: result.forfeited === true,
      cancelled: result.cancelled === true,
      reason: "resign",
    });

    return NextResponse.json({
      success: true,
      data: {
        forfeited: result.forfeited === true,
        cancelled: result.cancelled === true,
      },
    });
  } catch (error) {
    console.error("[keno-pvp/resign] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
