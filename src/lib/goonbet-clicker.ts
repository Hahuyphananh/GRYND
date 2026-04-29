export const CLICKER_GROWTH_RATE = 0.005;
export const CLICKER_SYNC_INTERVAL_MS = 8000;
export const CLICKER_MAX_CLICKS_PER_SECOND = 120;

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
  const chance = CLICKER_BASE_BUST_CHANCE * Math.exp(CLICKER_BUST_EXP_GROWTH * (safeClick - 1));
  return Math.min(chance, 0.95);
}

export function maxAllowedClicks(durationMs: number): number {
  const seconds = Math.max(0, durationMs) / 1000;
  return Math.ceil(seconds * CLICKER_MAX_CLICKS_PER_SECOND);
}

function deterministicRoll(seed: string): number {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 13), 16);
  return bucket / 0x1fffffffffffff;
}

export function didBustByClick(seed: string, clicks: number): boolean {
  const roll = deterministicRoll(seed);
  let survive = 1;
  for (let i = 1; i <= Math.max(0, Math.floor(clicks)); i += 1) {
    survive *= 1 - bustChanceAtClick(i);
    if (roll > survive) return true;
  }
  return false;
}

export function payoutFrom(betAmount: bigint, multiplier: number): bigint {
  const scaled = Math.floor(multiplier * 1_000_000);
  return (betAmount * BigInt(scaled)) / BigInt(1000000);
}
