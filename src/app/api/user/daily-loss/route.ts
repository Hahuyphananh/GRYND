// src/app/api/user/daily-loss/route.ts
//
// Responsible-play "net today" figure for the DailyLossGuard modal + the
// navbar's home-page chip.
//
// The guard used to compute this by fanning out across every game history
// table (GET /api/get-bet-history?since=… — ~24 queries per request,
// fired twice per lobby page view). This endpoint replaces that with:
//
//   1. The maintained daily counters on `users`
//      (net = daily_won − daily_wagered) — one indexed row read. The
//      counters are bumped on every real-money settlement by
//      applyLeaderboardCounters (the casino / funnel games) and the
//      recordPvPResult helpers in the mines-pvp / keno-pvp / memory-grid /
//      lane-rush-duel server stores, then reset to 0 at midnight UTC by
//      GET /api/jobs/daily-reset.
//
// The client hook (src/lib/useDailyLoss.js) dedupes + caches the result
// for 60s, so page navigations and the navbar + guard mounting together
// cost a single request.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const [user] = await db
      .select({
        id: users.id,
        wagered: users.dailyWagered,
        won: users.dailyWon,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    // ── Counter net (casino / funnel games + mines/keno/memory-grid/
    //    lane-rush PvP — the games settled through the counters paths). ──
    const net = Number(user.won) - Number(user.wagered);

    return NextResponse.json(
      { success: true, net },
      {
        headers: {
          // Private (per-user) — never CDN-cached. The client hook applies
          // its own 60s dedupe/cache, so a short browser TTL is just a
          // backstop for tab reuse.
          "Cache-Control": "private, max-age=30",
        },
      },
    );
  } catch (error) {
    console.error("[api/user/daily-loss] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}