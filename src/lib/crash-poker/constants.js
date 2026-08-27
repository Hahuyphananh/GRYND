// src/lib/crash-poker/constants.js
//
// Crash Poker — shared game constants.
//
// The multiplier starts at 1.00x and the first meaningful betting checkpoint
// is 1.25x. From there a betting decision happens every +0.25x: 1.25x,
// 1.50x, 1.75x, 2.00x, ... The crash can land anywhere, including between
// checkpoints, so the engine never assumes a checkpoint was reached — it
// derives which checkpoints actually opened from the server-authoritative
// crash point at settle time.

/** First betting checkpoint multiplier. */
export const FIRST_BETTING_CHECKPOINT = 1.25;

/** Distance between betting checkpoints. */
export const CHECKPOINT_STEP = 0.25;

/**
 * Small Blind as a fraction of the Big Blind (the table wager).
 * This is the DEFAULT used when a table is created; the resolved value is
 * persisted on crash_arena_tables.small_blind so each table's blinds are
 * configurable without touching code.
 */
export const SMALL_BLIND_RATIO = 0.5;

/** Absolute floor for the Small Blind (and any ante derived from it). */
export const MIN_SMALL_BLIND = 0.01;

/**
 * Minimum raise: a raise must set the required bet to at least
 * `requiredBet + bigBlind` (one big-blind increment, standard poker).
 */
export const MIN_RAISE_UNITS = 1;

/**
 * How long an unmatched player has to act once a betting checkpoint window
 * opens (or re-opens after a raise). When the deadline passes, the server
 * auto-folds every active non-all-in player who still owes a call — the
 * stall guard that keeps one player from freezing betting for the table.
 * When every player acts before the deadline the game continues immediately
 * (the checkpoint resolves on the last action — no waiting for the timer).
 */
export const CHECKPOINT_ACTION_DEADLINE_MS = 30_000;

/**
 * How long the "next round" countdown lasts once a hand settles. The
 * settle writes an absolute `next_round_at` deadline on the table row so
 * every client counts down to the SAME wall-clock moment and the round
 * starts exactly on schedule (no per-client drift that could start a hand
 * before a slow client's countdown ends).
 */
export const NEXT_ROUND_COUNTDOWN_MS = 12_000;

/**
 * Exponential growth rate of the crash curve: multiplier = e^(rate·t).
 * MUST match `CRASH_GROWTH_RATE` in src/lib/games/crash/constants.ts (the
 * server routes import that one; the pure engine keeps a copy so it stays
 * importable by the plain-JS test runner).
 */
export const CRASH_GROWTH_RATE = 0.33;

/** Platform fee applied to a won pot (same rake as Crash Arena). */
export const PLATFORM_FEE = 0.05;

/** Valid betting actions at a checkpoint. */
export const BETTING_ACTIONS = ["fold", "call", "raise"];

/** Entry result values used by Crash Poker hands. */
export const RESULT_WON = "won";
export const RESULT_LOST = "lost";
export const RESULT_FOLDED = "folded";
export const RESULT_PENDING = "pending";

/**
 * Round money to 2 decimals (cent precision for all chip math).
 * @param {number} n
 * @returns {number}
 */
export function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Multiplier of a betting checkpoint by 0-based index.
 * index 0 → 1.25x, index 1 → 1.50x, ... Uses integer math so floats never
 * drift (125 + 25·index over 100).
 *
 * @param {number} index
 * @returns {number}
 */
export function checkpointMultiplier(index) {
  return (125 + 25 * Math.max(0, Math.floor(index || 0))) / 100;
}

/**
 * Highest checkpoint index whose multiplier is <= the given multiplier.
 * Returns -1 when the multiplier is below the first checkpoint (1.25x).
 *
 * @param {number} multiplier
 * @returns {number}
 */
export function checkpointIndexAtOrBelow(multiplier) {
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m < FIRST_BETTING_CHECKPOINT) return -1;
  return Math.floor((m - FIRST_BETTING_CHECKPOINT) / CHECKPOINT_STEP + 1e-9);
}

/**
 * The multiplier the crash curve shows at the START of a flight segment.
 * Index -1 (no checkpoint opened yet) means the flight starts at 1.00x.
 *
 * @param {number} checkpointIndex
 * @returns {number}
 */
export function segmentStartMultiplier(checkpointIndex) {
  const idx = Math.floor(Number(checkpointIndex) || 0);
  if (idx < 0) return 1.0;
  return checkpointMultiplier(idx);
}
