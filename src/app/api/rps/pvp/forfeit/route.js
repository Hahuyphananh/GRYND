// src/app/api/rps/pvp/forfeit/route.js
//
// POST — forfeit from an in-progress RPS PvP best-of-7 game. The
// forfeiter loses and the opponent is credited the pot minus the
// shared 5% house rake. Only valid while the match is `matched`
// (both players joined, rounds in progress); a `active` (waiting)
// game is cancelled with a full refund via `/cancel` instead.
// Settlement logic lives in `src/lib/rps-pvp/serverStore.js` so the
// realtime-server disconnect-forfeit route settles identically.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  forfeitRpsPvpGame,
  recordForfeitStats,
} from "../../../../../lib/rps-pvp/serverStore";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { gameId } = await req.json();
  const parsedGameId = Number(gameId);
  if (!Number.isFinite(parsedGameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  try {
    const result = await forfeitRpsPvpGame({
      userId,
      gameId: parsedGameId,
    });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    recordForfeitStats(result);

    return NextResponse.json({
      success: true,
      data: {
        gameId: parsedGameId,
        status: result.game.status,
        winnerId: result.winnerId,
        winnerPayout: result.winnerPayout,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to forfeit game" },
      { status: 400 },
    );
  }
}
