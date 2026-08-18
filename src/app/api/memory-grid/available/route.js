// src/app/api/memory-grid/available/route.js
//
// GET — list open Memory Grid lobbies (one open row per match that's
// waiting for an opponent). Public read; mirrors the mines-pvp /
// blackjack-pvp `available` route.

import { NextResponse } from "next/server";
import {
  listOpenMatches,
  enrichMatchesWithUsers,
} from "../../../../lib/memory-grid/serverStore";

export async function GET() {
  try {
    const openMatches = await listOpenMatches({ limit: 30 });
    // Enrich with host display names + avatars so the shared lobby
    // renders proper player heads instead of raw Clerk-id truncation
    // (mirrors plinko-pvp / keno-pvp available routes).
    const enriched = await enrichMatchesWithUsers(openMatches);
    return NextResponse.json({
      success: true,
      data: {
        matches: enriched.map((m) => ({
          id: m.id,
          player1Id: m.player1Id,
          stakeAmount: Number(m.stakeAmount),
          createdAt: m.createdAt,
          hostName: m.players?.p1?.displayName ?? m.player1Id,
          hostProfileImageUrl: m.players?.p1?.profileImageUrl ?? null,
        })),
      },
    });
  } catch (error) {
    console.error("[memory-grid/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
