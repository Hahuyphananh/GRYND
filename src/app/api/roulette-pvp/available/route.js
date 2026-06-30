// src/app/api/roulette-pvp/available/route.js
//
// GET — list open roulette PvP lobbies (one open row per match that's
// waiting for an opponent). Public read; the project also exposes
// many other /api endpoints without explicit auth so unauthenticated
// GETs return an empty list rather than failing.

import { NextResponse } from "next/server";
import { listOpenMatches } from "../../../../lib/roulette-pvp/serverStore";

export async function GET() {
  try {
    const openMatches = await listOpenMatches({ limit: 30 });
    return NextResponse.json({
      success: true,
      data: {
        matches: openMatches.map((m) => ({
          id: m.id,
          player1Id: m.player1Id,
          stakeAmount: Number(m.stakeAmount),
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("[roulette-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
