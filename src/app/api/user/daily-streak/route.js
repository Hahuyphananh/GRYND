// app/api/user/daily-streak/route.js
//
// GET /api/user/daily-streak  → the signed-in player's CURRENT streak state:
//                               current/best counts, the shared title ladder,
//                               the next milestone and the full milestone list.
//
// READ-ONLY. The streak is credited by FINISHING A GAME — the authoritative
// completion routes call `recordStreakCompletion` in src/lib/streaks/server.ts.
// Opening the site, refreshing a page or reading this endpoint must never
// advance it, so there is no POST here; a page visit cannot move the day.
//
// THE CANONICAL SOURCE IS `user_streaks` (the UTC play streak). The legacy
// local-time counters on `users` are the fallback for an account the backfill
// has not covered yet, so a profile never renders 0 just because the new row is
// missing. `source` tells the client which one answered.
//
// Auth is required: there is no streak without a player.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users, userStreaks } from "../../../../db/schema";
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

    const [canonical] = await db
      .select({
        currentStreak: userStreaks.currentStreak,
        longestStreak: userStreaks.longestStreak,
        lastCompletedUtcDate: userStreaks.lastCompletedUtcDate,
      })
      .from(userStreaks)
      .where(eq(userStreaks.userId, user.id))
      .limit(1);

    const canonicalCurrent = Math.max(0, Math.floor(Number(canonical?.currentStreak) || 0));
    const canonicalBest = Math.max(0, Math.floor(Number(canonical?.longestStreak) || 0));
    const source = canonical && (canonicalCurrent > 0 || canonicalBest > 0)
      ? "canonical"
      : "legacy";

    const current = source === "canonical"
      ? canonicalCurrent
      : Math.max(0, Math.floor(Number(user.current) || 0));
    const best = source === "canonical"
      ? canonicalBest
      : Math.max(0, Math.floor(Number(user.best) || 0));

    // `milestones` remains the title-only ladder the compact widget and its
    // popup expect. The rewards card consumes `rewardMilestones`, which keeps
    // the reward-only days 180 and 275 in the same canonical ladder.
    const state = getStreakMilestoneState(current);
    const rewardState = getStreakMilestoneState(current, { rewardLadder: true });

    // A streak shield belongs to the LEGACY local streak only. It is reported
    // for compatibility; the UTC streak has no shields.
    let shieldAvailable = false;
    try {
      shieldAvailable = source === "legacy" && (await hasItem(user.id, "streak_shield", 1));
    } catch {
      shieldAvailable = false;
    }

    return NextResponse.json(
      {
        success: true,
        source,
        current: state.current,
        best,
        weeklyCurrent: Math.max(0, Math.floor(Number(user.weeklyCurrent) || 0)),
        weeklyBest: Math.max(0, Math.floor(Number(user.weeklyBest) || 0)),
        title: state.title,
        nextMilestone: rewardState.nextMilestone,
        daysRemaining: rewardState.daysRemaining,
        progress: rewardState.progress,
        milestones: state.milestones,
        rewardMilestones: rewardState.milestones,
        lastCompletedDate: source === "canonical"
          ? toDateStr(canonical?.lastCompletedUtcDate)
          : toDateStr(user.lastLoginDate),
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
