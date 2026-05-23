// src/lib/streakTitles.js
//
// Daily login streak title mapping.
// A user's streak title is determined by the number of consecutive days
// they have logged in. The title is the highest milestone they have reached.
//
//   Days  | Title
//   ------|-------------------
//   1     | Daily Visitor
//   3     | Loyal Player
//   5     | Token Collector
//   7     | Weekly Winner
//   10    | Streak Starter
//   14    | Lucky Regular
//   21    | Dedicated Roller
//   30    | Monthly High Roller
//   45    | Fortune Chaser
//   60    | Casino Veteran
//   75    | Lucky Legend
//   100   | Streak Master
//   150   | Vault Elite
//   200   | Jackpot Grinder
//   365   | Casino King

const STREAK_TITLES = [
  { days: 1, title: "Daily Visitor" },
  { days: 3, title: "Loyal Player" },
  { days: 5, title: "Token Collector" },
  { days: 7, title: "Weekly Winner" },
  { days: 10, title: "Streak Starter" },
  { days: 14, title: "Lucky Regular" },
  { days: 21, title: "Dedicated Roller" },
  { days: 30, title: "Monthly High Roller" },
  { days: 45, title: "Fortune Chaser" },
  { days: 60, title: "Casino Veteran" },
  { days: 75, title: "Lucky Legend" },
  { days: 100, title: "Streak Master" },
  { days: 150, title: "Vault Elite" },
  { days: 200, title: "Jackpot Grinder" },
  { days: 365, title: "Casino King" },
].sort((a, b) => a.days - b.days);

/**
 * Given a streak count (number of consecutive login days),
 * return the highest title the user qualifies for.
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
