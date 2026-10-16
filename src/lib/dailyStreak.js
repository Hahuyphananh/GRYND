// src/lib/dailyStreak.js
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { users, userStats } from "../db/schema";
import { consumeItem } from "./shopItems";

/**
 * `YYYY-MM-DD` for a Date (or an already-stringified date column), in LOCAL
 * time — the same calendar day the streak columns are keyed on.
 */
export function toDateStr(date) {
  if (date instanceof Date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof date === "string") return date.slice(0, 10);
  return null;
}

/** Whole days from `fromStr` to `toStr`, both `YYYY-MM-DD`. UTC-normalised so
 *  a DST boundary can never turn "yesterday" into 0 or 2 days. */
export function daysBetween(fromStr, toStr) {
  const parse = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toStr) - parse(fromStr)) / 86400000);
}

/**
 * The daily streak day a claim would land on RIGHT NOW, computed without
 * writing anything.
 *
 * This exists so the daily reward's STATUS read and the CLAIM it previews can
 * never disagree about the amount: both derive the streak day through this one
 * function, so the number on the button is the number that gets paid. (The bug
 * it fixes: the status read used the STORED streak, which is stale until
 * something advances it — a player who missed a day was shown "Claim 250" and
 * then paid day 1.)
 *
 * It mirrors `updateDailyStreak`'s daily arithmetic exactly:
 *   * never logged in            → day 1;
 *   * already logged in today    → the stored streak (already advanced today);
 *   * logged in yesterday        → the next day;
 *   * any longer gap             → day 1, unless a streak shield absorbs the
 *                                  missed day, in which case the streak holds.
 *
 * The weekly streak, the all-time best and shields' CONSUMPTION stay in
 * `updateDailyStreak`; this is only the read-side projection.
 *
 * @param {object} [state]
 * @param {string|Date|null} [state.lastLoginDate] The stored `users.last_login_date`.
 * @param {number|null} [state.current] The stored `users.daily_streak_current`.
 * @param {boolean} [state.shieldAvailable] Whether a streak shield is there to
 *   absorb the missed day (the caller consumes it; this only reports).
 * @param {Date} [today]
 * @returns {number} The 1-based streak day a claim made now would land on.
 */
export function projectDailyStreakDay(
  { lastLoginDate, current, shieldAvailable = false } = {},
  today = new Date()
) {
  const current_ = Math.max(1, Math.floor(Number(current)) || 1);
  const last = toDateStr(lastLoginDate);
  if (!last) return 1;

  const todayStr = toDateStr(today);
  if (last === todayStr) return current_;

  // A date in the future (clock skew) falls through to the missed-day branch,
  // exactly as it does in `updateDailyStreak`.
  if (daysBetween(last, todayStr) === 1) return current_ + 1;
  return shieldAvailable ? current_ : 1;
}

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
  //
  // The day the streak lands on is decided in ONE place —
  // `projectDailyStreakDay` — so the daily reward's status read (which calls the
  // same function) can never advertise an amount this write would not pay.
  //
  // A Daily Streak Shield (consumable) absorbs exactly one missed day. It is
  // CONSUMED first and its result feeds the projection, so the shield is spent
  // exactly when it is honoured and a concurrent consume cannot be
  // double-counted.
  const lastLoginStr = toDateStr(user.lastLoginDate);
  const missedADay = Boolean(lastLoginStr) && daysBetween(lastLoginStr, todayStr) !== 1;
  const shieldAvailable = missedADay ? await consumeItem(user.id, "streak_shield", 1) : false;

  const newDailyCurrent = projectDailyStreakDay(
    {
      lastLoginDate: user.lastLoginDate,
      current: user.dailyStreakCurrent,
      shieldAvailable,
    },
    today
  );
  const newDailyBest = Math.max(Number(user.dailyStreakBest) || 0, newDailyCurrent);

  // --- Weekly Streak ---
  let newWeeklyCurrent;
  let newWeeklyBest;

  if (!user.lastLoginDate) {
    // First login ever
    newWeeklyCurrent = 1;
    newWeeklyBest = 1;
  } else if (user.weekKey !== currentWeekKey) {
    // New week → reset weekly streak (a Daily Streak Shield only protects
    // the daily login streak, so the weekly reset is unaffected).
    newWeeklyCurrent = 1;
    newWeeklyBest = user.weeklyStreakBest;
  } else {
    // Same week — check consecutive day
    const daysSinceLastLogin = daysBetween(toDateStr(user.lastLoginDate), todayStr);

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
