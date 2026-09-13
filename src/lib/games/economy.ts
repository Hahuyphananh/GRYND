// src/lib/games/economy.ts
//
// Canonical token-economy constants shared across every game.
//
// Single source of truth for the platform-wide numbers that the audit
// (economy rebalance) introduced:
//
//   * GLOBAL_MAX_BET            — the maximum wager any player may place in
//                                 any game (~$100 at ~1,000 tokens/$).
//   * HIGH_VARIANCE_MAX_BET     — tighter cap for games whose payouts can
//                                 spike (roulette 35:1, plinko up to 120x),
//                                 so a single lucky roll can't mint millions.
//   * PVP_RAKE_PCT              — every 1v1 match takes 5% of the pot
//                                 (winner gets 95%: 1.9x on a 2x pot).
//
// IMPORTANT: the plain-JS constants files under src/lib/*-pvp/constants.js
// (which are imported by the `node --test` engine tests WITHOUT tsx) keep
// their own inlined copies of these values with a "must match" comment —
// the same convention crash-poker uses for its shared pieces (see the
// crash multiplier curve, mirrored between src/lib/crash-poker/constants.js
// and src/lib/games/crash/constants.ts). Keep them in lockstep with this
// file.

/** Hard ceiling for any single wager (tokens). ~$100 at 1,000 tokens/$. */
export const GLOBAL_MAX_BET = 100_000;

/** Ceiling for high-variance games (roulette / plinko style payouts). */
export const HIGH_VARIANCE_MAX_BET = 10_000;

/**
 * Daily net-loss soft-warning threshold (tokens, ~$50 at 1,000 tokens/$).
 * When a player is down more than this in one day, the lobby shows a
 * responsible-play warning they must acknowledge before continuing.
 */
export const DAILY_LOSS_WARNING_THRESHOLD = 50_000;

/** Below this daily loss, the lobby shows a subtle "down today" chip. */
export const DAILY_LOSS_CHIP_THRESHOLD = 5_000;

/** Shared PvP rake: 5% of the pot, winner keeps 95% (payout = 1.9x wager). */
export const PVP_RAKE_PCT = 0.05;

/** Winner's share of the pot after rake (1 - PVP_RAKE_PCT). */
export const PVP_WINNER_SHARE = 1 - PVP_RAKE_PCT; // 0.95
