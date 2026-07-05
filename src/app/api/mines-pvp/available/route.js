// src/app/api/mines-pvp/available/route.js
//
// GET — list open Mines Duel lobbies (one open row per match that's
// waiting for an opponent). Public read; mirrors the blackjack-pvp /
// roulette-pvp `available` route. Adds the host-picked `minesCount`
// to the payload so the joiner knows what they're agreeing to
// before they click.

import { NextResponse } from "next/server";
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
    });
  } catch (error) {
    console.error("[mines-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
