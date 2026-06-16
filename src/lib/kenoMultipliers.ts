// Shared Keno multiplier table — single source of truth for both frontend display and backend payout calculation.
// Payout = betAmount × multiplier[picks][hits]

export const KENO_MULTIPLIER_TABLE: Record<number, Record<number, number>> = {
  1: { 1: 3 },
  2: { 1: 1.5, 2: 6 },
  3: { 1: 1, 2: 3, 3: 10 },
  4: { 2: 2, 3: 6, 4: 20 },
  5: { 2: 1.5, 3: 5, 4: 15, 5: 50 },
  6: { 3: 3, 4: 12, 5: 80, 6: 400 },
  7: { 3: 2, 4: 6, 5: 40, 6: 250, 7: 800 },
  8: { 4: 5, 5: 25, 6: 150, 7: 600, 8: 2500 },
  9: { 4: 3, 5: 12, 6: 75, 7: 300, 8: 1000, 9: 3000 },
  10: { 4: 2, 5: 7, 6: 35, 7: 180, 8: 700, 9: 1800, 10: 5000 },
};

/** Maximum number of picks the multiplier table supports */
export const KENO_MAX_PICKS = 10;

/** Number of numbers to auto-pick (keeps UX manageable) */
export const KENO_AUTO_PICK_COUNT = 5;

/** Total numbers in the Keno grid */
export const KENO_POOL_SIZE = 40;

/** Number of winning numbers drawn each round */
export const KENO_DRAW_COUNT = 10;

/**
 * Calculate the keno payout for a given number of picks, hits, and bet amount.
 * Returns 0 when no multiplier is defined for that pick/hit combination.
 */
export function calcKenoPayout(picks: number, hits: number, betAmount: number): number {
  const mult = KENO_MULTIPLIER_TABLE[picks]?.[hits] || 0;
  return +(betAmount * mult).toFixed(2);
}

/**
 * Get the multiplier for a given picks/hits combo, or 0 if undefined.
 */
export function getKenoMultiplier(picks: number, hits: number): number {
  return KENO_MULTIPLIER_TABLE[picks]?.[hits] || 0;
}
