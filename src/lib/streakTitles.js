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

const STREAK_TITLES = [
  { days: 1, title: "Daily Visitor" },
  { days: 3, title: "Loyal Player" },
  { days: 5, title: "Card Collector" },
  { days: 7, title: "Weekly Winner" },
  { days: 10, title: "Streak Starter" },
  { days: 14, title: "Lucky Regular" },
  { days: 21, title: "Dedicated Roller" },
  { days: 30, title: "Monthly Champion" },
  { days: 45, title: "Prize Chaser" },
  { days: 60, title: "Veteran" },
  { days: 75, title: "Lucky Legend" },
  { days: 100, title: "Streak Master" },
  { days: 150, title: "Vault Elite" },
  { days: 200, title: "Milestone Grinder" },
  { days: 365, title: "King" },
].sort((a, b) => a.days - b.days);

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
 *   milestones: Array<{ days: number, title: string, achieved: boolean, isNext: boolean }>,
 * }}
 */
export function getStreakMilestoneState(streakCount) {
  const current = Math.max(0, Math.floor(Number(streakCount) || 0));
  const nextMilestone = getNextStreakMilestone(current);

  return {
    current,
    title: getStreakTitle(current),
    nextMilestone,
    daysRemaining: nextMilestone ? Math.max(0, nextMilestone.days - current) : 0,
    progress: nextMilestone ? Math.min(1, current / nextMilestone.days) : 1,
    milestones: STREAK_TITLES.map((entry) => ({
      ...entry,
      achieved: current >= entry.days,
      isNext: nextMilestone ? entry.days === nextMilestone.days : false,
    })),
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
