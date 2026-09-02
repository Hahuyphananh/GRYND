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
import { grantBattlepassBanners } from "./banners";

export const MAX_LEVEL = 100;

// EXP sources.
export const WAGER_EXP_DIVISOR = 10; // 1 XP per 10 tokens wagered
export const QUEST_EXP_MULTIPLIER = 2; // quest XP = token reward × 2

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

// XP granted for claiming a quest with the given token reward.
export function expForQuest(reward = 0) {
  return Math.max(0, Math.floor(Number(reward) || 0)) * QUEST_EXP_MULTIPLIER;
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
export async function addExp(userId, amount) {
  const xp = Math.max(0, Math.floor(Number(amount) || 0));
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

  const result = rows[0] || null;
  if (result) {
    // Reconciliation is idempotent and also repairs rewards for users whose
    // XP was already above a newly-added reward level.
    await grantBattlepassBanners(userId, result.level).catch((error) => {
      console.error("[BATTLEPASS_BANNER_GRANT_ERROR]", error);
    });
  }
  return result;
}
