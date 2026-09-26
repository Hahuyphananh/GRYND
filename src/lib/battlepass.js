// src/lib/battlepass.js
//
// Battlepass EXP system — replaces the wager-based VIP levels
// (src/lib/vipLevels.js) with a 100-level EXP track.
//
//   XP to advance from level N → N+1 : 150 + 10 * (N - 1)   (150, 160, 170, …)
//   Cumulative XP to REACH level N   : 5 * (N - 1) * (N + 28)
//   Inverse (level from XP)          : floor((sqrt(21025 + 20 * xp) - 135) / 10)
//
// The formulas above are the closed forms of the ramp, so the level can be
// derived from XP in both JS and SQL (the counters pipeline recomputes it
// inside a single UPDATE).

import { getNeonSql } from "../db/neon";
import { getActiveXpMultiplier } from "./shopItems";
import { OVERALL_TROPHY_MAX } from "./trophies";

export const MAX_LEVEL = 100;

// ── Trophy-driven progression ─────────────────────────────────────────────
//
// The Battle Pass level is DERIVED from trophies, not from XP. OVERALL_TROPHY_MAX
// (every rated game capped: 1,000 × TROPHY_GAMES.length) is the maximum, spread
// across 100 levels — so the per-level cost follows the size of the rated game
// space automatically and the pass stays completable. Nothing is stored — the
// level is computed on read from the player's trophy total, so it can never
// drift from the trophy ladder.

/** Trophies required per Battle Pass level (OVERALL_TROPHY_MAX ÷ 100). */
export const TROPHIES_PER_LEVEL = OVERALL_TROPHY_MAX / MAX_LEVEL;

/** Total trophies required to REACH a level (level 1 = 0). */
export function trophiesToReachLevel(level) {
  const n = Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(level) || 1)));
  return (n - 1) * TROPHIES_PER_LEVEL;
}

/**
 * Battle Pass level for a total trophy count. Level 1 at 0 trophies, level 100
 * at the OVERALL_TROPHY_MAX cap. Clamped to 1..MAX_LEVEL.
 */
export function getLevelFromTrophies(totalTrophies = 0) {
  const total = Math.max(0, Math.floor(Number(totalTrophies) || 0));
  return Math.min(MAX_LEVEL, Math.max(1, Math.floor(total / TROPHIES_PER_LEVEL) + 1));
}

/**
 * Full progress object for the battlepass page / profile card, derived from
 * TROPHIES. Mirrors the shape of `getBattlepassProgress` (which is now the
 * legacy XP view) so existing UI keeps working.
 */
export function getBattlepassProgressFromTrophies(totalTrophies = 0) {
  const total = Math.max(0, Math.floor(Number(totalTrophies) || 0));
  const level = getLevelFromTrophies(total);
  const currentLevelTrophies = trophiesToReachLevel(level);
  const nextLevelTrophies =
    level >= MAX_LEVEL
      ? currentLevelTrophies
      : trophiesToReachLevel(level + 1);
  const range = Math.max(1, nextLevelTrophies - currentLevelTrophies);
  return {
    level,
    trophies: total,
    currentLevelTrophies,
    nextLevelTrophies,
    prevLevelRequired: currentLevelTrophies,
    nextLevelRequired: nextLevelTrophies,
    progressPercent:
      level >= MAX_LEVEL
        ? 100
        : Math.min(100, Math.round(((total - currentLevelTrophies) / range) * 100)),
    remainingToNext: Math.max(0, nextLevelTrophies - total),
    maxLevel: MAX_LEVEL,
    trophiesPerLevel: TROPHIES_PER_LEVEL,
  };
}

// ── Legacy XP track (no longer drives the level) ──────────────────────────

// EXP sources.
export const WAGER_EXP_DIVISOR = 10; // 1 XP per 10 staked
// One-time onboarding bonus for finishing the first Free Play vs AI match
// (migration 0143). Free-play matches otherwise award no XP (expForWager(0)
// = 0); this is the single explicit exception, granted once server-side by
// /api/onboarding/first-game-complete and kept fully separate from wagered-
// game rewards. 150 XP from a fresh account lands exactly on Level 2, where
// a reward is waiting to be claimed on the Battle Pass page.
export const FIRST_GAME_BONUS_XP = 150;

// Cumulative XP required to REACH a level (level 1 = 0).
export function expToReachLevel(level) {
  const n = Math.max(1, Math.floor(Number(level) || 1));
  return 5 * (n - 1) * (n + 28);
}

// XP required to advance FROM level N to N+1 (0 at the cap).
export function expForNextLevel(level) {
  const n = Math.max(1, Math.floor(Number(level) || 1));
  if (n >= MAX_LEVEL) return 0;
  return 150 + 10 * (n - 1);
}

// Level for a given amount of total XP (clamped to 1..MAX_LEVEL).
export function getLevelFromXp(xp = 0) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  const level = Math.floor((Math.sqrt(21025 + 20 * total) - 135) / 10);
  return Math.min(MAX_LEVEL, Math.max(1, level));
}

// Full progress object for the battlepass page / profile card.
// `prevLevelRequired` / `nextLevelRequired` mirror the old VIP
// levelProgress shape so existing UI keeps working.
export function getBattlepassProgress(xp = 0) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  const level = getLevelFromXp(total);
  const currentLevelXp = expToReachLevel(level);
  const nextLevelXp = expToReachLevel(Math.min(MAX_LEVEL, level + 1));
  const range = Math.max(1, nextLevelXp - currentLevelXp);
  return {
    level,
    xp: total,
    currentLevelXp,
    nextLevelXp,
    prevLevelRequired: currentLevelXp,
    nextLevelRequired: nextLevelXp,
    progressPercent: Math.min(100, Math.round(((total - currentLevelXp) / range) * 100)),
    remainingToNext: Math.max(0, nextLevelXp - total),
    maxLevel: MAX_LEVEL,
  };
}

// XP earned from a single settled wager.
export function expForWager(betAmount = 0) {
  const bet = Math.max(0, Math.floor(Number(betAmount) || 0));
  return Math.floor(bet / WAGER_EXP_DIVISOR);
}

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error(
      "DATABASE_URL or POSTGRES_URL is not set. Set one in your runtime environment (for example, .env.local for local development).",
    );
  }
  _sql = getNeonSql();
  return _sql;
}

// Atomically credit XP and recompute the battlepass level on both
// `users` and `user_stats` (the two tables the level is read from).
// Returns the new { level, xp } or null.
//
// An active 2× Progress Boost (timed shop item) multiplies the granted XP — the
// multiplier is looked up inside addExp so every XP source (settled wagers,
// onboarding bonuses, any future grant) honors the boost at this single
// chokepoint.
export async function addExp(userId, amount) {
  const xpMultiplier = await getActiveXpMultiplier(userId);
  const xp = Math.max(0, Math.floor(Number(amount) || 0)) * xpMultiplier;
  if (!xp || !userId) return null;

  const rows = await getSql()`
    WITH updated_user AS (
      UPDATE users
      SET xp = LEAST(2147483647, xp + ${xp}),
          level = LEAST(${MAX_LEVEL}, GREATEST(1, FLOOR((SQRT(21025 + 20 * (xp::bigint + ${xp})) - 135) / 10)::int))
      WHERE id = ${userId}
      RETURNING id, level, xp
    )
    INSERT INTO user_stats (user_id, level, xp)
    SELECT id, level, xp FROM updated_user
    ON CONFLICT (user_id) DO UPDATE SET
      level = EXCLUDED.level,
      xp = EXCLUDED.xp,
      updated_at = NOW()
    RETURNING level, xp
  `;

  // Note: rewards are NOT granted here. The player claims battlepass
  // rewards explicitly on the battlepass page (POST /api/battlepass/claim)
  // once they hit the level — see src/lib/battlepassRewards.js.
  return rows[0] || null;
}
