// src/app/api/keno-pvp/available/route.js
//
// GET — list open Keno Duel lobbies (one open row per match that's
// waiting for an opponent). Public read; mirrors the slots-pvp /
// mines-pvp `available` route.

import { NextResponse } from "next/server";
import { listOpenMatches } from "../../../../lib/keno-pvp/serverStore";

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
    console.error("[keno-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
