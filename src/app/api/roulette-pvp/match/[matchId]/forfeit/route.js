// src/app/api/roulette-pvp/match/[matchId]/forfeit/route.js
//
// POST — forfeit from an active Roulette PvP match. The forfeiter
// loses and the opponent is credited the pot minus the house fee
// (same `creditWinner` settlement path as a normal finish). Mirrors
// the auth / async-params / error pattern of `cancel/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { forfeitMatch } from "../../../../../../lib/roulette-pvp/serverStore";

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

  try {
    const result = await forfeitMatch({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match?.status,
        forfeited: true,
      },
    });
  } catch (error) {
    console.error("[roulette-pvp/forfeit] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
