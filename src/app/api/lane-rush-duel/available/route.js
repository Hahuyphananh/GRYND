// src/app/api/lane-rush-duel/available/route.js
//
// GET — list open (waiting) Lane Rush Duel lobbies for the casino
// lobby page.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { listOpenMatches } from "../../../../lib/lane-rush-duel/serverStore";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const matches = await listOpenMatches({ limit: 30 });
    return NextResponse.json({
      success: true,
      data: {
        matches: matches.map((m) => ({
          id: m.id,
          player1Id: m.player1Id,
          stakeAmount: Number(m.stakeAmount),
          difficulty: m.difficulty,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/available] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
