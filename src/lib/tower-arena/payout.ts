// src/lib/tower-arena/payout.ts
//
// Centralized, server-side payout math for Tower Arena. The client NEVER
// computes payouts or authorizes token transfers — every balance mutation
// happens in a DB transaction keyed off the values returned here.
//
// Economics (consistent with the shared 5% PvP rake in
// `src/lib/games/economy.ts`):
//   pot       = maxPlayers × wager
//   houseFee  = floor(pot × PVP_RAKE_PCT)
//   prizePool = pot − houseFee
//
// Tower Arena is strictly 1v1 (two seats), so there is exactly ONE payout
// shape: the winner takes the entire prize pool and the runner-up takes
// nothing. The old per-seat-count weight tables (3–6 seats) went with the
// shared table — a seat count is no longer an input to any function here.
//
// Integer payouts are computed with floor + the remainder granted to the
// winner, so the allocation ALWAYS sums exactly to the prize pool (never
// exceeds it).

import { PVP_RAKE_PCT } from "../games/economy";
import { SEATS } from "./engine";

/** Placement in a 1v1 tower: 1 = winner, 2 = runner-up. */
export type TowerArenaPlacement = 1 | 2;

/**
 * Relative payout weights per placement (index = placement-1). One row only:
 * the winner is paid, the runner-up is not.
 */
export const PAYOUT_WEIGHTS: Record<number, number[]> = {
  [SEATS]: [1, 0],
};

export interface TowerArenaPayoutConfig {
  /** Always 2 — Tower Arena is 1v1. */
  maxPlayers: number;
  wager: number;
  pot: number;
  houseFee: number;
  prizePool: number;
}

/** Total pot, house fee and prize pool for a match. Pure & server-side. */
export function computePotPrize(config: { wager: number }): TowerArenaPayoutConfig {
  const wager = Math.max(0, Math.floor(Number(config.wager) || 0));
  const pot = SEATS * wager;
  const houseFee = Math.floor(pot * PVP_RAKE_PCT);
  const prizePool = pot - houseFee;
  return { maxPlayers: SEATS, wager, pot, houseFee, prizePool };
}

/**
 * How many placements receive a payout (weight > 0). Drives free-play result
 * popups: with no tokens at stake a player "wins" by finishing in the slot
 * that would pay in the equivalent paid game. In 1v1 that is the winner only.
 */
export function paidPlacementsFor(): number {
  const weights = PAYOUT_WEIGHTS[SEATS] ?? [];
  return weights.filter((w) => w > 0).length;
}

/**
 * Integer token payout for every placement (1-indexed array; element 0 is
 * placement 1 = winner). Payouts sum exactly to `prizePool`.
 */
export function payoutsByPlacement(config: { prizePool: number }): number[] {
  const prizePool = Math.max(0, Math.floor(Number(config.prizePool) || 0));
  const weights = PAYOUT_WEIGHTS[SEATS] ?? [1, 0];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return new Array<number>(SEATS).fill(0);

  const per: number[] = weights.map((w) => Math.floor((prizePool * w) / totalWeight));
  let allocated = per.reduce((a, b) => a + b, 0);
  // Grant the rounding remainder to the winner (placement 1) so the sum
  // equals the prize pool exactly. Guarantees payout ≤ prizePool.
  const short = Math.max(0, prizePool - allocated);
  per[0] += short;
  allocated += short;

  // Defensive: any residual we could not attribute goes nowhere.
  return per;
}

/** Convenience payout for one placement. */
export function payoutForPlacement(config: {
  prizePool: number;
  placement: TowerArenaPlacement;
}): number {
  const payouts = payoutsByPlacement({ prizePool: config.prizePool });
  const idx = Math.max(0, Math.min(SEATS - 1, (config.placement || 1) - 1));
  return payouts[idx];
}

/** Net profit for a placement (payout − wager); negative = loss. */
export function netForPlacement(config: {
  wager: number;
  prizePool: number;
  placement: TowerArenaPlacement;
}): number {
  return payoutForPlacement({
    prizePool: config.prizePool,
    placement: config.placement,
  }) - config.wager;
}
