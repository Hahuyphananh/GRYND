/**
 * Crash game constants — shared by the provably-fair Crash Arena.
 *
 * These define the range of possible crash multipliers.
 * The seed-based generator (generateCrashPoint) uses these bounds
 * so payouts are consistent.
 */

/** Minimum crash multiplier. */
export const CRASH_MIN = 1.2;

/** Maximum crash multiplier. */
export const CRASH_MAX = 9.2;

/** Range = MAX − MIN (used for scaling). */
export const CRASH_RANGE = CRASH_MAX - CRASH_MIN; // 8.0

/** Standard Crash Arena table wagers (lobby stake sections). */
export const CRASH_WAGERS = [1, 5, 10, 25, 50, 100];

/** Minimum buy-in is always 5× the round wager. */
export const CRASH_MIN_BUYIN_MULTIPLIER = 5;
