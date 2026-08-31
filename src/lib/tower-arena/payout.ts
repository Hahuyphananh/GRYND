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
// Payouts are placement-based (placement 1 = winner). Weights are given
// per seat count; integer payouts are computed with floor + remainder
// granted to the winner so the allocation ALWAYS sums exactly to the
// prize pool (never exceeds it). The 6-player config reproduces the
// intended economics from the spec (e.g. ~300/160/110 on a 570 pool at a
// 100 entry). For 2 players the winner takes the entire prize pool.

import { PVP_RAKE_PCT } from "../games/economy";

export type TowerArenaPlacement = 1 | 2 | 3 | 4 | 5 | 6;

/** Relative payout weights per placement, by seat count (index = placement-1). */
export const PAYOUT_WEIGHTS: Record<number, number[]> = {
  2: [1, 0],
  3: [3, 2, 0],
  4: [4, 2, 1, 0],
  5: [4, 3, 2, 0, 0],
  // Ratios approximate the spec's 300/160/110 for a 570 pool (@100 entry).
  6: [300, 160, 110, 0, 0, 0],
};

export interface TowerArenaPayoutConfig {
  /** 2..6 seats. */
  maxPlayers: number;
  wager: number;
  pot: number;
  houseFee: number;
  prizePool: number;
}

/** Total pot, house fee and prize pool for a match. Pure & server-side. */
export function computePotPrize(config: {
  maxPlayers: number;
  wager: number;
}): TowerArenaPayoutConfig {
  const maxPlayers = clampPlayers(config.maxPlayers);
  const wager = Math.max(0, Math.floor(Number(config.wager) || 0));
  const pot = maxPlayers * wager;
  const houseFee = Math.floor(pot * PVP_RAKE_PCT);
  const prizePool = pot - houseFee;
  return { maxPlayers, wager, pot, houseFee, prizePool };
}

function clampPlayers(n: number): number {
  if (!Number.isInteger(n)) return 2;
  return Math.max(2, Math.min(6, n));
}

/**
 * Integer token payout for every placement (1-indexed array; element 0 is
 * placement 1 = winner). Payouts sum exactly to `prizePool`. Works for
 * 2–6 players.
 */
export function payoutsByPlacement(config: {
  maxPlayers: number;
  wager: number;
  prizePool: number;
}): number[] {
  const maxPlayers = clampPlayers(config.maxPlayers);
  const prizePool = Math.max(0, Math.floor(Number(config.prizePool) || 0));
  const weights = PAYOUT_WEIGHTS[maxPlayers] ?? PAYOUT_WEIGHTS[2];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return new Array<number>(maxPlayers).fill(0);

  const per: number[] = weights.map((w) =>
    totalWeight === 0 ? 0 : Math.floor((prizePool * w) / totalWeight),
  );
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
  maxPlayers: number;
  wager: number;
  prizePool: number;
  placement: TowerArenaPlacement;
}): number {
  const p = clampPlayers(config.maxPlayers);
  const payouts = payoutsByPlacement({
    maxPlayers: p,
    wager: config.wager,
    prizePool: config.prizePool,
  });
  const idx = Math.max(0, Math.min(p - 1, (config.placement || 1) - 1));
  return payouts[idx];
}

/** Net profit for a placement (payout − wager); negative = loss. */
export function netForPlacement(config: {
  maxPlayers: number;
  wager: number;
  prizePool: number;
  placement: TowerArenaPlacement;
}): number {
  return payoutForPlacement({
    ...config,
    placement: config.placement,
  }) - config.wager;
}