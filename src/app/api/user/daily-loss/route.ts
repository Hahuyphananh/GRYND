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
//   2. ONE crash-arena query for parity. Crash Poker settles with real
//      table balances but outside the counters funnel, and settled rounds
//      feed bet-history — so it's still summed here directly, mirroring
//      the bet-history formatter's math (won → pot − 5% rake; lost /
//      folded → −table wager; pot = players × wager).
//
// The client hook (src/lib/useDailyLoss.js) dedupes + caches the result
// for 60s, so page navigations and the navbar + guard mounting together
// cost a single request.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../../../db";
import {
  crashArenaEntries,
  crashArenaRounds,
  crashArenaTables,
  users,
} from "../../../../db/schema";

function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

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

    // ── 1. Counter net (casino / funnel games + mines/keno/memory-grid/
    //       lane-rush PvP — the games settled through the counters paths). ──
    let net = Number(user.won) - Number(user.wagered);

    // ── 2. Crash Poker today — settled rounds only, same math as the
    //       bet-history formatter (pot = players × wager, 5% rake). ────────
    const crashRows = await db
      .select({
        result: crashArenaEntries.result,
        wager: crashArenaTables.wagerAmount,
        players: sql<number>`(
          select count(*)::int
          from crash_arena_entries e2
          where e2.round_id = ${crashArenaEntries.roundId}
        )`,
      })
      .from(crashArenaEntries)
      .innerJoin(
        crashArenaRounds,
        eq(crashArenaEntries.roundId, crashArenaRounds.id),
      )
      .innerJoin(
        crashArenaTables,
        eq(crashArenaRounds.tableId, crashArenaTables.id),
      )
      .where(
        and(
          eq(crashArenaEntries.userId, user.id),
          eq(crashArenaRounds.status, "settled"),
          gte(crashArenaRounds.createdAt, startOfTodayUtc()),
        ),
      );

    for (const row of crashRows) {
      const wager = Number(row.wager ?? 0);
      if (!Number.isFinite(wager) || wager <= 0) continue;
      if (row.result === "won") {
        const players = Number(row.players ?? 0) || 1;
        const pot = players * wager;
        const payout = pot - Math.floor(pot * 0.05);
        net += payout - wager;
      } else {
        net -= wager;
      }
    }

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