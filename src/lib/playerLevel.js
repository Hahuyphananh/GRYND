// src/lib/playerLevel.js
//
// PURE PLAYER LEVEL + RANK MATH — no database, no I/O.
//
// THE ONE SOURCE OF TRUTH for a player's level and rank. The level is derived
// from TOTAL TROPHIES (the sum of `player_trophies.trophies`), never from a
// separate XP currency. `users.level` / `users.xp` are retired Battle Pass
// counters and are deliberately NOT read here.
//
// THE RULE
//   100 trophies = one level.
//   Level 1 starts at 0 trophies.
//   Level 100 is the top of the ladder and its band ends at 10,000 trophies.
//   Trophies beyond 10,000 never move the level (the count itself is still
//   unbounded and keeps ranking the trophy boards).
//
//   level = min(100, floor(trophies / 100) + 1)
//
// PERMANENT PROGRESSION
//   A level is derived from the player's TROPHY HIGH-WATER MARK, not from the
//   current count, so losing a ranked match can never take an earned badge
//   away. The high-water mark is `users.peak_total_trophies`, maintained
//   server-side by the `player_trophies_sync_peak_total` trigger (migration
//   0247) and backfilled for existing players from their current total at
//   migration time. Progress is always computed from
//   max(currentTrophies, peakTrophies), so an account whose peak row has not
//   caught up yet still shows the level its current total has earned.
//
//   This module cannot write anything. Every API surface computes its values
//   from server-read trophy rows; no client-submitted level, rank or peak is
//   ever accepted.
//
// RANKS
//   Seven tiers, each a pure function of the level. The badge artwork lives in
//   src/components/player-level/PlayerLevelBadge.tsx and reads its material
//   colours from RANK_TIERS below, so the ladder and its visuals cannot drift.

/** Trophies required for one level. */
export const TROPHIES_PER_LEVEL = 100;

/** The maximum player level. */
export const MAX_PLAYER_LEVEL = 100;

/** The trophy total at which the level ladder is complete. */
export const MAX_LEVEL_TROPHIES = TROPHIES_PER_LEVEL * MAX_PLAYER_LEVEL; // 10,000

/**
 * The seven rank tiers. `accent` / `metal` / `glow` are the shared visual
 * identity used by the SVG emblems, so all seven badges read as one collection.
 */
export const RANK_TIERS = Object.freeze([
  {
    key: "rookie",
    minLevel: 1,
    maxLevel: 14,
    accent: "#c98a4b",
    metal: "#f0b27a",
    deep: "#5a3218",
    glow: "rgba(201, 138, 75, 0.45)",
  },
  {
    key: "contender",
    minLevel: 15,
    maxLevel: 29,
    accent: "#c4d3e6",
    metal: "#f4f9ff",
    deep: "#436078",
    glow: "rgba(196, 211, 230, 0.45)",
  },
  {
    key: "challenger",
    minLevel: 30,
    maxLevel: 44,
    accent: "#f2c14e",
    metal: "#ffe6a1",
    deep: "#6b4a10",
    glow: "rgba(242, 193, 78, 0.45)",
  },
  {
    key: "elite",
    minLevel: 45,
    maxLevel: 59,
    accent: "#6fe7ff",
    metal: "#d6fbff",
    deep: "#0b5566",
    glow: "rgba(111, 231, 255, 0.5)",
  },
  {
    key: "master",
    minLevel: 60,
    maxLevel: 74,
    accent: "#5b8cff",
    metal: "#bcd4ff",
    deep: "#1b2f78",
    glow: "rgba(91, 140, 255, 0.5)",
  },
  {
    key: "grandmaster",
    minLevel: 75,
    maxLevel: 89,
    accent: "#ff5d5d",
    metal: "#ffd166",
    deep: "#6b1717",
    glow: "rgba(255, 93, 93, 0.5)",
  },
  {
    key: "legend",
    minLevel: 90,
    maxLevel: 100,
    accent: "#b98cff",
    metal: "#e6d4ff",
    deep: "#3b1d6b",
    glow: "rgba(185, 140, 255, 0.55)",
  },
]);

/** The rank keys in ladder order. */
export const RANK_KEYS = RANK_TIERS.map((tier) => tier.key);

/** Coerce anything to a finite, non-negative integer trophy count. */
export function normalizeTrophies(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * The level a trophy total has earned.
 * 0–99 → 1, 100–199 → 2, … 9,900+ → 100.
 */
export function levelFromTrophies(totalTrophies) {
  const total = normalizeTrophies(totalTrophies);
  return Math.min(MAX_PLAYER_LEVEL, Math.floor(total / TROPHIES_PER_LEVEL) + 1);
}

/** The rank tier for a level. Out-of-range input is clamped to the ladder. */
export function rankForLevel(level) {
  const normalized = Number.isFinite(Number(level))
    ? Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.trunc(Number(level))))
    : 1;
  return (
    RANK_TIERS.find(
      (tier) => normalized >= tier.minLevel && normalized <= tier.maxLevel,
    ) ?? RANK_TIERS[RANK_TIERS.length - 1]
  );
}

/** The rank tier for a rank key, falling back to Rookie. */
export function rankForRankKey(rankKey) {
  return RANK_TIERS.find((tier) => tier.key === rankKey) ?? RANK_TIERS[0];
}

/**
 * The full, UI-ready progression for one player.
 *
 * `totalTrophies` is the current sum of the player's per-game counts;
 * `peakTrophies` is the permanent high-water mark. The level is derived from
 * max(current, peak), so it can never regress after a losing run.
 *
 * At level 100 `nextLevelTrophies` is null, `trophiesToNext` is 0 and the bar
 * reads 100%.
 *
 * @param {{ totalTrophies?: number, peakTrophies?: number }} [params]
 */
export function getPlayerProgression({
  totalTrophies = 0,
  peakTrophies = 0,
} = {}) {
  const current = normalizeTrophies(totalTrophies);
  const peak = normalizeTrophies(peakTrophies);
  const progressTrophies = Math.max(current, peak);
  const level = levelFromTrophies(progressTrophies);
  const rank = rankForLevel(level);
  const complete = level >= MAX_PLAYER_LEVEL;

  const currentLevelTrophies = (level - 1) * TROPHIES_PER_LEVEL;
  const nextLevelTrophies = complete ? null : level * TROPHIES_PER_LEVEL;
  const trophiesIntoLevel = Math.max(
    0,
    Math.min(
      TROPHIES_PER_LEVEL,
      progressTrophies - currentLevelTrophies,
    ),
  );
  const progressPercent = complete
    ? 100
    : Math.min(
        100,
        Math.max(
          0,
          Math.round((trophiesIntoLevel / TROPHIES_PER_LEVEL) * 100),
        ),
      );
  const trophiesToNext = complete
    ? 0
    : Math.max(0, nextLevelTrophies - progressTrophies);

  return {
    level,
    rankKey: rank.key,
    rankNameKey: `playerLevel.ranks.${rank.key}`,
    maxLevel: MAX_PLAYER_LEVEL,
    maxLevelTrophies: MAX_LEVEL_TROPHIES,
    complete,
    currentTrophies: current,
    peakTrophies: Math.max(current, peak),
    progressTrophies,
    // Level standing never drops: true when the badge is being defended by
    // the recorded peak rather than the current count.
    protected: progressTrophies > current,
    currentLevelTrophies,
    nextLevelTrophies,
    trophiesIntoLevel,
    trophiesPerLevel: TROPHIES_PER_LEVEL,
    progressPercent,
    trophiesToNext,
    accent: rank.accent,
    metal: rank.metal,
    glow: rank.glow,
  };
}

/**
 * The compact level/rank payload attached to every leaderboard row. Only the
 * permanent values travel — no player identity, no client input.
 *
 * @param {number} peakTrophies
 * @param {number} [currentTrophies]
 */
export function toPlayerLevelShape(peakTrophies, currentTrophies = peakTrophies) {
  const progression = getPlayerProgression({
    totalTrophies: currentTrophies,
    peakTrophies,
  });
  return {
    level: progression.level,
    rankKey: progression.rankKey,
    rankNameKey: progression.rankNameKey,
    maxLevel: progression.maxLevel,
    progressPercent: progression.progressPercent,
    complete: progression.complete,
  };
}

/** Config snapshot for tests and future admin surfaces. */
export const PLAYER_LEVEL_CONFIG = Object.freeze({
  trophiesPerLevel: TROPHIES_PER_LEVEL,
  maxLevel: MAX_PLAYER_LEVEL,
  maxLevelTrophies: MAX_LEVEL_TROPHIES,
  ranks: RANK_TIERS,
});
