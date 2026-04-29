import crypto from "node:crypto";

export const CLICKER_MULTIPLIER_STEP = 1.001;
export const CLICKER_BUST_CHANCE = 0.0012;
export const CLICKER_CLICK_COOLDOWN_MS = 200;

export type RoundStatus = "active" | "bust" | "cashed_out";

export function getNextMultiplier(current: number): number {
  return Number((current * CLICKER_MULTIPLIER_STEP).toFixed(8));
}

export function isBustRoll(): boolean {
  // 1,000,000 buckets -> exact 0.12% via threshold 1200
  return crypto.randomInt(0, 1_000_000) < 1200;
}

export function payoutFrom(betAmount: bigint, multiplier: number): bigint {
  const scaled = Math.floor(multiplier * 1_000_000);
  return (betAmount * BigInt(scaled)) / BigInt(1000000);
}
