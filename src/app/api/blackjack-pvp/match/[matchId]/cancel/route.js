// src/app/api/blackjack-pvp/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting match (creator only). Refunds the
// creator's stake and transitions status to 'cancelled'.
// Mirrors `src/app/api/roulette-pvp/match/[matchId]/cancel/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cancelMatch } from "../../../../../../lib/blackjack-pvp/serverStore";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const matchId = Number(params?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await cancelMatch({ userId, matchId });
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
        status: result.match.status,
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/match/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
