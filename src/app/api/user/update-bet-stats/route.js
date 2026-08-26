// src/app/api/user/update-bet-stats/route.js
//
// POST — SECURITY HARDENED: direct client-driven stat updates are DISABLED.
// This endpoint previously let any authenticated user self-report an
// arbitrary betAmount/payout, which forged leaderboard stats (total_wagered,
// total_won, biggest_win, streaks, big_wins entries, XP/level) with no
// server-side verification at all.
//
// Stats can only be updated server-side by game-settlement code that derives
// bet/payout from authoritative game state:
//   * server-authoritative game routes (play-plinko, crash arena settle,
//     chess end-game, dice-duel submit-turn, dice-flush, hex-duel, uno
//     determine-winner, ...),
//   * all of which funnel through lib/leaderboardCounters.applyLeaderboardCounters
//     with server-verified amounts.
//
// This endpoint now only exists so legacy clients get a clear, explicit
// error instead of silently failing — it never mutates a stat.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { auditLog } from "../../../../lib/security/auditLog";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  auditLog("update_bet_stats_blocked", { userId });

  return NextResponse.json(
    {
      success: false,
      error:
        "Direct stat updates are disabled. Stats are only recorded by " +
        "server-authoritative game settlement.",
    },
    { status: 403 },
  );
}
