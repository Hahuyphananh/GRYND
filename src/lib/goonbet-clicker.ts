export const CLICKER_GROWTH_RATE = 0.005;
export const CLICKER_SYNC_INTERVAL_MS = 8000;
export const CLICKER_MAX_CLICKS_PER_SECOND = 120;
export const CLICKER_BASE_BUST_CHANCE = 0.0025;
export const CLICKER_BUST_EXP_GROWTH = 0.06;

export function multiplierFromClicks(clicks: number): number {
  const safeClicks = Math.max(0, Math.floor(clicks));
  return Number((1 * (1 + safeClicks * CLICKER_GROWTH_RATE)).toFixed(8));
}

export function bustChanceAtClick(clickNumber: number): number {
  const safeClick = Math.max(1, Math.floor(clickNumber));
  const chance =
    CLICKER_BASE_BUST_CHANCE *
    Math.exp(CLICKER_BUST_EXP_GROWTH * (safeClick - 1));
  return Math.min(chance, 0.95);
}

export function maxAllowedClicks(durationMs: number): number {
  const seconds = Math.max(0, durationMs) / 1000;
  return Math.ceil(seconds * CLICKER_MAX_CLICKS_PER_SECOND);
}

export function payoutFrom(betAmount: bigint, multiplier: number): bigint {
  const scaled = Math.floor(multiplier * 1_000_000);
  return (betAmount * BigInt(scaled)) / BigInt(1000000);
}
