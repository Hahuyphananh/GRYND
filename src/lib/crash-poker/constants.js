// src/lib/crash-poker/constants.js
//
// Crash Arena v2 — shared game constants.
//
// The multiplier starts at 1.00x and climbs continuously (no betting
// checkpoints): every player posts the table wager as a flat ante, anyone
// can fold at ANY moment, and the hand settles by fold-order ranking —
// the last player to fold (or the sole survivor) takes the biggest share
// of the pot, with linear rank weights and crash victims getting nothing.

/**
 * Exponential growth rate of the crash curve: multiplier = e^(rate·t).
 * MUST match `CRASH_GROWTH_RATE` in src/lib/games/crash/constants.ts (the
 * server routes import that one; the pure engine keeps a copy so it stays
 * importable by the plain-JS test runner). Set slower (0.22, was 0.33) so
 * the curve climbs gently and players have a real window to decide when
 * to fold.
 */
export const CRASH_GROWTH_RATE = 0.22;

/**
 * Crash multiplier bounds (mirror of src/lib/games/crash/constants.ts —
 * kept here so the plain-JS client-safe modules and tests can import them
 * without a bundler). The seed-based generator picks a crash point in
 * [CRASH_MIN, CRASH_MAX].
 */
export const CRASH_MIN = 1.2;
export const CRASH_MAX = 9.2;

/** Platform fee applied to the pot (same rake as before). */
export const PLATFORM_FEE = 0.05;

/**
 * How long the "next round" countdown lasts once a hand settles. The
 * settle writes an absolute `next_round_at` deadline on the table row so
 * every client counts down to the SAME wall-clock moment and the round
 * starts exactly on schedule (no per-client drift that could start a hand
 * before a slow client's countdown ends).
 */
export const NEXT_ROUND_COUNTDOWN_MS = 12_000;

/** Entry result values used by Crash Arena hands. */
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