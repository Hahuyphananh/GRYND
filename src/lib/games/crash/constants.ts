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

/** Standard Crash Arena table wagers (lobby quick-pick presets). */
export const CRASH_WAGERS = [1, 5, 10, 25, 50, 100];

/** Minimum wager allowed when creating a table. */
export const CRASH_MIN_WAGER = 1;

/** Minimum buy-in is always 5× the round wager. */
export const CRASH_MIN_BUYIN_MULTIPLIER = 5;

/**
 * Hard cap on a single Crash Arena buy-in (tokens).
 *
 * A player can theoretically put their whole balance in, so every buy-in
 * (initial join or top-up) is clamped to 10,000,000 tokens.
 */
export const CRASH_MAX_BUYIN = 10_000_000;

/**
 * Hard cap on a Crash Arena table's round wager (tokens), applied in the
 * lobby's Create Table wager input. Prevents runaway wagers (e.g. the full
 * balance) when creating a table.
 */
export const CRASH_MAX_WAGER = 1_000_000;
