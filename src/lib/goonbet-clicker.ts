export const CLICKER_GROWTH_RATE = 0.005;
export const CLICKER_SYNC_INTERVAL_MS = 8000;
export const CLICKER_MAX_CLICKS_PER_SECOND = 120;

export function multiplierFromClicks(clicks: number): number {
  const safeClicks = Math.max(0, Math.floor(clicks));
  return Number((1 * (1 + safeClicks * CLICKER_GROWTH_RATE)).toFixed(8));
}

export function maxAllowedClicks(durationMs: number): number {
  const seconds = Math.max(0, durationMs) / 1000;
  return Math.ceil(seconds * CLICKER_MAX_CLICKS_PER_SECOND);
}

export function payoutFrom(betAmount: bigint, multiplier: number): bigint {
  const scaled = Math.floor(multiplier * 1_000_000);
  return (betAmount * BigInt(scaled)) / BigInt(1000000);
}
