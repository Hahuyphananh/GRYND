// src/app/api/plinko-pvp/available/route.js
//
// GET — list open plinko-pvp lobbies (one row per match that's
// waiting for an opponent). Public read; the project also exposes
// many other /api endpoints without explicit auth so unauthenticated
// GETs return an empty list rather than failing.

import { NextResponse } from "next/server";
import {
  listOpenMatches,
  enrichMatchesWithUsers,
} from "../../../../lib/plinko-pvp/serverStore";

export async function GET() {
  try {
    const openMatches = await listOpenMatches({ limit: 30 });
    const enriched = await enrichMatchesWithUsers(openMatches);
    return NextResponse.json({
      success: true,
      data: {
        matches: enriched.map((m) => ({
          id: m.id,
          player1Id: m.player1Id,
          stakeAmount: Number(m.stakeAmount),
          createdAt: m.createdAt,
          // Surface host display name so the lobby can render proper
          // player heads (e.g. "Host: Alice") instead of truncation.
          hostName: m.players?.p1?.displayName ?? m.player1Id,
          hostProfileImageUrl: m.players?.p1?.profileImageUrl ?? null,
        })),
      },
    });
  } catch (error) {
    console.error("[plinko-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
