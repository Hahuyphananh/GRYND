// app/api/user/daily-streak/route.js
//
// GET /api/user/daily-streak  → the signed-in player's CURRENT streak state:
//                               current/best/weekly counts, the title the
//                               streak has earned, the next milestone and the
//                               full milestone list.
//
// This endpoint is READ-ONLY on purpose. The streak is credited by FINISHING A
// GAME — `recordStreakCompletion` in src/lib/streaks/server.ts calls the shared
// `updateDailyStreak` writer after the authoritative settlement. Opening the
// site, refreshing a page or reading this endpoint must never advance it, so
// there is no POST here; a page visit cannot move the day.
//
// Auth is required: there is no streak without a player.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { toDateStr } from "../../../../lib/dailyStreak";
import { getStreakMilestoneState } from "../../../../lib/streakTitles";
import { hasItem } from "../../../../lib/shopItems";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const [user] = await db
      .select({
        id: users.id,
        current: users.dailyStreakCurrent,
        best: users.dailyStreakBest,
        weeklyCurrent: users.weeklyStreakCurrent,
        weeklyBest: users.weeklyStreakBest,
        lastLoginDate: users.lastLoginDate,
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

    const state = getStreakMilestoneState(user.current);
    const best = Math.max(0, Math.floor(Number(user.best) || 0));

    // A streak shield is a display-only fact here: the read never consumes it.
    // A missing shop table must not fail the streak read.
    let shieldAvailable = false;
    try {
      shieldAvailable = await hasItem(user.id, "streak_shield", 1);
    } catch {
      shieldAvailable = false;
    }

    return NextResponse.json(
      {
        success: true,
        current: state.current,
        best,
        weeklyCurrent: Math.max(0, Math.floor(Number(user.weeklyCurrent) || 0)),
        weeklyBest: Math.max(0, Math.floor(Number(user.weeklyBest) || 0)),
        title: state.title,
        nextMilestone: state.nextMilestone,
        daysRemaining: state.daysRemaining,
        progress: state.progress,
        milestones: state.milestones,
        lastCompletedDate: toDateStr(user.lastLoginDate),
        shieldAvailable,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[DAILY_STREAK_READ_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
