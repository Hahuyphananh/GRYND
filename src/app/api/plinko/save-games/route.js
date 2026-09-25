// src/app/api/plinko/save-games/route.js
//
// POST — SECURITY HARDENED: direct client-driven game-result recording is
// DISABLED. This endpoint previously let any authenticated user submit an
// arbitrary totalBet / multipliers / totalPayout, which forged game history
// (plinko_games rows) and leaderboard counters with no server-side
// verification. The current plinko page plays through
// /api/plinko-pvp/* (server-authoritative) and solo play through
// /api/play-plinko, so nothing in the app depends on this route.
//
// This endpoint now only exists so legacy clients get a clear, explicit
// error instead of silently failing — it never writes game history.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { auditLog } from "../../../../lib/security/auditLog";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  auditLog("plinko_save_games_blocked", { userId });

  return NextResponse.json(
    {
      success: false,
      error:
        "Direct game-result recording is disabled. Results are only " +
        "recorded by server-authoritative game settlement.",
    },
    { status: 403 },
  );
}
