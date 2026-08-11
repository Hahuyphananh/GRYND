// src/app/api/slots-pvp/available/route.js
//
// GET — list open slots-pvp lobbies (one row per match that's waiting
// for an opponent). Public read; unauthenticated GETs return an empty
// list rather than failing (same convention as the other PvP games).

import { NextResponse } from "next/server";
import {
  listOpenMatches,
  enrichMatchesWithUsers,
} from "../../../../lib/slots-pvp/serverStore.js";

export async function GET() {
  try {
    const openMatches = await listOpenMatches({ limit: 30 });
    const enriched = await enrichMatchesWithUsers(openMatches);
    return NextResponse.json({
      success: true,
      data: {
        matches: (Array.isArray(enriched) ? enriched : []).map((m) => ({
          id: m.id,
          player1Id: m.player1Id,
          stakeAmount: Number(m.stakeAmount),
          theme: m.theme || "fruit",
          createdAt: m.createdAt,
          // Surface host display name so the lobby can render proper
          // player heads instead of clerkId truncation.
          hostName: m.players?.p1?.displayName ?? m.player1Id,
          hostProfileImageUrl: m.players?.p1?.profileImageUrl ?? null,
        })),
      },
    });
  } catch (error) {
    console.error("[slots-pvp/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
