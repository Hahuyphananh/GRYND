// src/lib/dailyStreak.js
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { users, userStats } from "../db/schema";

/**
 * Updates a user's daily login streak AND weekly streak.
 *
 * **Daily Streak:**
 * - Same day → no-op (idempotent).
 * - Consecutive day → increment current streak, update best if needed.
 * - Missed day → reset current streak to 1, keep all-time best.
 *
 * **Weekly Streak:**
 * - Same day → no-op (idempotent).
 * - New week (Monday) → reset weekly streak to 1.
 * - Same week, consecutive day → increment weekly streak, update weekly best.
 * - Same week, missed day → weekly streak resets to 1, keep weekly best.
 * - The week key format is "YYYY_WW" (ISO week number).
 */
export async function updateDailyStreak(clerkId) {
  if (!clerkId) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: {
      id: true,
      lastLoginDate: true,
      dailyStreakCurrent: true,
      dailyStreakBest: true,
      weeklyStreakCurrent: true,
      weeklyStreakBest: true,
      weekKey: true,
    },
  });

  if (!user) return null;

  const today = new Date();
  const todayStr = toDateStr(today);
  const currentWeekKey = getWeekKey(today);
  const userId = user.id;

  // If already logged in today → no-op
  if (user.lastLoginDate === todayStr) {
    return {
      dailyStreakCurrent: user.dailyStreakCurrent,
      dailyStreakBest: user.dailyStreakBest,
      weeklyStreakCurrent: user.weeklyStreakCurrent,
      weeklyStreakBest: user.weeklyStreakBest,
      updated: false,
    };
  }

  // --- Daily Streak ---
  let newDailyCurrent;
  let newDailyBest;

  if (!user.lastLoginDate) {
    // First login ever
    newDailyCurrent = 1;
    newDailyBest = 1;
  } else {
    const lastDate = new Date(user.lastLoginDate);
    const daysSinceLastLogin = Math.floor(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
        Date.UTC(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate())) /
        (1000 * 60 * 60 * 24),
    );

    if (daysSinceLastLogin === 1) {
      newDailyCurrent = user.dailyStreakCurrent + 1;
      newDailyBest = Math.max(user.dailyStreakBest, newDailyCurrent);
    } else {
      newDailyCurrent = 1;
      newDailyBest = user.dailyStreakBest;
    }
  }

  // --- Weekly Streak ---
  let newWeeklyCurrent;
  let newWeeklyBest;

  if (!user.lastLoginDate) {
    // First login ever
    newWeeklyCurrent = 1;
    newWeeklyBest = 1;
  } else if (user.weekKey !== currentWeekKey) {
    // New week → reset weekly streak
    newWeeklyCurrent = 1;
    newWeeklyBest = user.weeklyStreakBest;
  } else {
    // Same week — check consecutive day
    const lastDate = new Date(user.lastLoginDate);
    const daysSinceLastLogin = Math.floor(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
        Date.UTC(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate())) /
        (1000 * 60 * 60 * 24),
    );

    if (daysSinceLastLogin === 1) {
      newWeeklyCurrent = user.weeklyStreakCurrent + 1;
      newWeeklyBest = Math.max(user.weeklyStreakBest, newWeeklyCurrent);
    } else {
      // Missed a day within the same week → weekly streak broken
      newWeeklyCurrent = 1;
      newWeeklyBest = user.weeklyStreakBest;
    }
  }

  // Update users table
  await db
    .update(users)
    .set({
      dailyStreakCurrent: newDailyCurrent,
      dailyStreakBest: newDailyBest,
      weeklyStreakCurrent: newWeeklyCurrent,
      weeklyStreakBest: newWeeklyBest,
      weekKey: currentWeekKey,
      lastLoginDate: todayStr,
    })
    .where(eq(users.id, userId));

  // Upsert user_stats
  const existingStats = await db.query.userStats.findFirst({
    where: eq(userStats.userId, userId),
    columns: {
      userId: true,
      dailyStreakCurrent: true,
      dailyStreakBest: true,
      weeklyStreakCurrent: true,
      weeklyStreakBest: true,
    },
  });

  if (existingStats) {
    await db
      .update(userStats)
      .set({
        dailyStreakCurrent: newDailyCurrent,
        dailyStreakBest: Math.max(existingStats.dailyStreakBest, newDailyBest),
        weeklyStreakCurrent: newWeeklyCurrent,
        weeklyStreakBest: Math.max(existingStats.weeklyStreakBest, newWeeklyBest),
      })
      .where(eq(userStats.userId, userId));
  } else {
    await db
      .insert(userStats)
      .values({
        userId,
        dailyStreakCurrent: newDailyCurrent,
        dailyStreakBest: newDailyBest,
        weeklyStreakCurrent: newWeeklyCurrent,
        weeklyStreakBest: newWeeklyBest,
      })
      .onConflictDoUpdate({
        target: userStats.userId,
        set: {
          dailyStreakCurrent: newDailyCurrent,
          dailyStreakBest: sql`GREATEST(${userStats.dailyStreakBest}, ${newDailyBest})`,
          weeklyStreakCurrent: newWeeklyCurrent,
          weeklyStreakBest: sql`GREATEST(${userStats.weeklyStreakBest}, ${newWeeklyBest})`,
        },
      });
  }

  return {
    dailyStreakCurrent: newDailyCurrent,
    dailyStreakBest: newDailyBest,
    weeklyStreakCurrent: newWeeklyCurrent,
    weeklyStreakBest: newWeeklyBest,
    updated: true,
  };
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Get ISO week key in "YYYY_WW" format (e.g., "2025_21").
 * Weeks start on Monday.
 */
function getWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Monday=1, Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}_${String(weekNo).padStart(2, "0")}`;
}
