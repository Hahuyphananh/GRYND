// src/app/api/mines-pvp/available/route.js
//
// GET — list open Mines Duel lobbies (one open row per match that's
// waiting for an opponent). Public read; mirrors the blackjack-pvp /
// roulette-pvp `available` route. `minesCount` is the fixed server
// constant (10 on the 10×10 board), included for display parity.

import { NextResponse } from "next/server";
import { PUBLIC_LOBBY_CACHE_HEADERS } from "../../../../lib/httpCache";
import { listOpenMatches } from "../../../../lib/mines-pvp/serverStore";

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
          minesCount: m.minesCount,
          createdAt: m.createdAt,
        })),
      },
    }, { headers: PUBLIC_LOBBY_CACHE_HEADERS });
  } catch (error) {
    console.error("[mines-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
