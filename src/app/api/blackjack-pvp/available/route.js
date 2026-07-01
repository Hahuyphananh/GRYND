// src/app/api/blackjack-pvp/available/route.js
//
// GET — list open blackjack PvP lobbies (one open row per match
// that's waiting for an opponent). Public read; mirrors the
// roulette-pvp `available` route.

import { NextResponse } from "next/server";
import { listOpenMatches } from "../../../../lib/blackjack-pvp/serverStore";

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
    console.error("[blackjack-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
