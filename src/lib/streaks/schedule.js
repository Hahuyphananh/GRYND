// src/lib/streaks/schedule.js
//
// THE UTC STREAK SCHEDULE — pure, shared by the server engine and the UI.
//
// Every rule here is arithmetic on calendar days, not on instants, so it can be
// tested without a database and so the number the client previews ("next
// milestone in 4 days") is produced by the same function that decides the real
// unlock. Nothing in this file reads the clock unless it is handed a date.
//
// THE RULES (product copy, implemented once):
//   * the day key is the UTC calendar date (the deterministic Daily Challenge
//     reset — no local timezone anywhere);
//   * a second completion on the same UTC day credits nothing;
//   * a completion on the following UTC day extends the streak;
//   * any longer gap resets it to 1 on the next completion (no shields);
//   * unlocks are earned at the milestone day and kept forever;
//   * after Day 365 every completed 30-day loop adds one prestige pip and a
//     2-day PRO trial when the account is not already a paying member.

/** The milestone schedule. Order matters; it is also the UI's display order. */
export const STREAK_MILESTONES = Object.freeze([
  { day: 3, items: ["felt_slate"] },
  { day: 7, items: ["card_back_carbon"], proTrialDays: 3 },
  { day: 14, items: ["badge_flame_14"] },
  { day: 30, items: ["felt_royal_emerald", "card_back_emerald_gold"] },
  { day: 60, items: ["felt_midnight_navy"] },
  { day: 100, items: ["title_centurion", "card_back_centurion"] },
  { day: 180, items: ["deck_grandmaster", "badge_flame_blue"] },
  { day: 275, items: ["felt_crimson_velvet", "card_back_crimson_monogram"] },
  {
    day: 365,
    items: ["felt_eternal_obsidian", "card_back_eternal", "frame_eternal", "badge_365_plus"],
  },
]);

/** The last bespoke milestone; the evergreen loop starts after it. */
export const MAX_BESPOKE_DAY = 365;
/** The evergreen loop's length, in days, after Day 365. */
export const POST_365_INTERVAL = 30;
/** The automatic PRO trial granted on each completed post-365 loop. */
export const POST_365_TRIAL_DAYS = 2;

/** Every item the streak can grant, in milestone order. */
export const STREAK_ITEM_IDS = Object.freeze(
  STREAK_MILESTONES.flatMap((milestone) => milestone.items),
);

/** `YYYY-MM-DD` in UTC. The one day key the whole system uses. */
export function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Whole UTC days from one `YYYY-MM-DD` to another. */
export function daysBetween(fromKey, toKey) {
  const parse = (value) => {
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toKey) - parse(fromKey)) / 86_400_000);
}

/** Milliseconds until the next `00:00 UTC` — the navbar countdown. */
export function msUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(0, next - now.getTime());
}

/**
 * The streak after a credited completion — the CLIENT-visible arithmetic of
 * the server engine, pure so both can agree.
 *
 * `lastDate` is the stored UTC day (`YYYY-MM-DD`) or null for a first game.
 */
export function advanceStreak({ current = 0, longest = 0, lastDate = null } = {}, todayKey) {
  const currentStreak = Math.max(0, Math.floor(Number(current)) || 0);
  const longestStreak = Math.max(0, Math.floor(Number(longest)) || 0);

  // Already credited today: nothing moves, nothing unlocks.
  if (lastDate === todayKey) {
    return { current: currentStreak, longest: longestStreak, credited: false };
  }

  const consecutive = lastDate != null && daysBetween(lastDate, todayKey) === 1;
  const next = consecutive ? Math.max(1, currentStreak) + 1 : 1;
  return {
    current: next,
    longest: Math.max(longestStreak, next),
    credited: true,
  };
}

/** The items a milestone day awards (empty for a non-milestone day). */
export function itemsForDay(day) {
  return STREAK_MILESTONES.find((milestone) => milestone.day === day)?.items ?? [];
}

/** The milestone at a streak length, or null. */
export function milestoneForDay(day) {
  return STREAK_MILESTONES.find((milestone) => milestone.day === day) ?? null;
}

/**
 * The items earned by moving from `previousStreak` to `nextStreak`.
 *
 * A reset starts the new streak at 1, so no milestone is crossed and nothing is
 * granted twice; every item is permanent in `user_unlocks`, so re-crossing a
 * milestone later is simply a no-op.
 */
export function unlocksForRange(previousStreak, nextStreak) {
  const from = Math.max(0, Math.floor(Number(previousStreak)) || 0);
  const to = Math.max(0, Math.floor(Number(nextStreak)) || 0);
  if (to <= from) return [];
  const items = [];
  for (const milestone of STREAK_MILESTONES) {
    if (milestone.day > from && milestone.day <= to) items.push(...milestone.items);
  }
  return [...new Set(items)];
}

/** The next milestone ahead of `currentStreak`, or null past Day 365. */
export function nextMilestone(currentStreak) {
  const current = Math.max(0, Math.floor(Number(currentStreak)) || 0);
  for (const milestone of STREAK_MILESTONES) {
    if (milestone.day > current) {
      return { day: milestone.day, items: [...milestone.items] };
    }
  }
  return null;
}

/** Days remaining until the next milestone (null when none is left). */
export function daysToNextMilestone(currentStreak) {
  const next = nextMilestone(currentStreak);
  if (!next) return null;
  return Math.max(0, next.day - Math.max(0, Math.floor(Number(currentStreak)) || 0));
}

/** True on every completed 30-day loop after Day 365. */
export function isPrestigeHit(currentStreak) {
  const current = Math.floor(Number(currentStreak)) || 0;
  return (
    current > MAX_BESPOKE_DAY &&
    (current - MAX_BESPOKE_DAY) % POST_365_INTERVAL === 0
  );
}

/** The prestige pips a streak length has earned (monotonic, never negative). */
export function prestigeFor(currentStreak) {
  const current = Math.floor(Number(currentStreak)) || 0;
  if (current <= MAX_BESPOKE_DAY) return 0;
  return Math.floor((current - MAX_BESPOKE_DAY) / POST_365_INTERVAL);
}

/** `365+ ★3` — the leaderboard/profile rendering of a prestige streak. */
export function prestigeBadgeLabel(currentStreak, pips) {
  const count = Math.max(0, Math.floor(Number(pips)) || 0);
  if (!count) return `${MAX_BESPOKE_DAY}+`;
  return `${MAX_BESPOKE_DAY}+ ★${count}`;
}

/** The milestone day an item is earned at, or null for an always-owned item. */
export function streakDayForItem(itemId) {
  for (const milestone of STREAK_MILESTONES) {
    if (milestone.items.includes(itemId)) return milestone.day;
  }
  return null;
}
