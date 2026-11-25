// src/lib/streakTitles.js
//
// Daily streak title mapping.
// A player's streak advances when they FINISH A GAME — one credit per
// calendar day, never a page visit. The title is the highest milestone the
// current streak has reached.
//
//   Days  | Title
//   ------|-------------------
//   1     | Daily Visitor
//   3     | Loyal Player
//   5     | Card Collector
//   7     | Weekly Winner
//   10    | Streak Starter
//   14    | Lucky Regular
//   21    | Dedicated Roller
//   30    | Monthly Champion
//   45    | Prize Chaser
//   60    | Veteran
//   75    | Lucky Legend
//   100   | Streak Master
//   150   | Vault Elite
//   200   | Milestone Grinder
//   365   | King

// ONE LADDER. The title thresholds are derived from the shared streak schedule
// (src/lib/streaks/schedule.js), so a title day and a reward day can never drift
// apart again.
import {
  STREAK_MILESTONES,
  STREAK_TITLE_MILESTONES,
  nextMilestone as nextScheduleMilestone,
  titleForDay,
} from "./streaks/schedule";

const STREAK_TITLES = [...STREAK_TITLE_MILESTONES].sort((a, b) => a.days - b.days);

/**
 * Given a streak count (consecutive days with a finished game),
 * return the highest title the player qualifies for.
 * Returns null if the streak is 0.
 */
export function getStreakTitle(streakCount) {
  if (!streakCount || streakCount < 1) return null;

  let best = null;
  for (const entry of STREAK_TITLES) {
    if (streakCount >= entry.days) {
      best = entry.title;
    } else {
      break;
    }
  }
  return best;
}

/**
 * Get the next streak milestone a user is working toward.
 * Returns { days, title } or null if all milestones reached.
 */
export function getNextStreakMilestone(streakCount) {
  if (!streakCount || streakCount < 1) {
    return STREAK_TITLES[0];
  }

  for (const entry of STREAK_TITLES) {
    if (streakCount < entry.days) {
      return entry;
    }
  }

  return null; // All milestones reached!
}

/**
 * Get all streak title entries (for seeding / display).
 */
export function getAllStreakTitles() {
  return STREAK_TITLES;
}

/**
 * Everything a streak surface needs, derived from the streak count alone.
 *
 * This is the ONE place milestone progress is calculated, so the widget, the
 * /rewards card and the read API can never disagree about the current title,
 * the next milestone or how far away it is.
 *
 * @param {number} streakCount The current daily streak (0 before the first
 *   completed game).
 * @returns {{
 *   current: number,
 *   title: string|null,
 *   nextMilestone: { days: number, title: string }|null,
 *   daysRemaining: number,
 *   progress: number,
 *   milestones: Array<{ days: number, title: string|null, achieved: boolean, isNext: boolean }>,
 * }}
 *
 * `rewardLadder` is for the rewards surface only: it returns every threshold in
 * the canonical schedule (including reward-only days 180 and 275), while the
 * default remains the title-only ladder the compact streak widget expects.
 */
export function getStreakMilestoneState(streakCount, { rewardLadder = false } = {}) {
  const current = Math.max(0, Math.floor(Number(streakCount) || 0));
  const scheduledNext = rewardLadder ? nextScheduleMilestone(current) : null;
  const nextMilestone = rewardLadder
    ? scheduledNext
      ? {
          days: scheduledNext.day,
          title: titleForDay(scheduledNext.day),
          items: scheduledNext.items,
        }
      : null
    : getNextStreakMilestone(current);

  const milestones = rewardLadder
    ? STREAK_MILESTONES.map((entry) => ({
        days: entry.day,
        title: entry.title ?? null,
        items: [...entry.items],
        achieved: current >= entry.day,
        isNext: nextMilestone ? entry.day === nextMilestone.days : false,
      }))
    : STREAK_TITLES.map((entry) => ({
        ...entry,
        achieved: current >= entry.days,
        isNext: nextMilestone ? entry.days === nextMilestone.days : false,
      }));

  return {
    current,
    title: getStreakTitle(current),
    nextMilestone,
    daysRemaining: nextMilestone ? Math.max(0, nextMilestone.days - current) : 0,
    progress: nextMilestone ? Math.min(1, current / nextMilestone.days) : 1,
    milestones,
  };
}

/**
 * Compute the equipped streak title for a user.
 *
 * @param {object} user - must have { dailyStreakCurrent?, dailyStreakBest?, selectedStreakType? }
 * @returns {{ title: string|null, streakCount: number, streakType: string|null }}
 */
export function computeEquippedStreakTitle(user) {
  if (!user || !user.selectedStreakType) {
    return { title: null, streakCount: 0, streakType: null };
  }

  const streakCount =
    user.selectedStreakType === "best"
      ? Number(user.dailyStreakBest || 0)
      : Number(user.dailyStreakCurrent || 0);

  return {
    title: getStreakTitle(streakCount),
    streakCount,
    streakType: user.selectedStreakType,
  };
}
