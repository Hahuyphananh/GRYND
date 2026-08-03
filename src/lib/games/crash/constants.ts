/**
 * Crash game constants — shared by Classic Crash and Crash Arena.
 *
 * These define the range of possible crash multipliers.
 * Both the legacy Math.random() path and the provably-fair
 * crypto path MUST use the same bounds so payouts are consistent.
 */

/** Minimum crash multiplier. */
export const CRASH_MIN = 1.2;

/** Maximum crash multiplier. */
export const CRASH_MAX = 9.2;

/** Range = MAX − MIN (used for scaling). */
export const CRASH_RANGE = CRASH_MAX - CRASH_MIN; // 8.0

/**
 * Generate a crash point using Math.random() (legacy, non-verifiable).
 * Used by Classic Crash API routes that rely on session-based flow.
 *
 * Prefer generateCrashPoint(seed) from ./generateCrashPoint for
 * provably-fair rounds (Crash Arena).
 */
export function randomCrashPoint(): number {
  return Number((Math.random() * CRASH_RANGE + CRASH_MIN).toFixed(2));
}
