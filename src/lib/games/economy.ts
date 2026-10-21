// src/lib/games/economy.ts
//
// Canonical token-economy constants shared across every game.
//
// Single source of truth for the platform-wide numbers behind the balanced
// coin economy. Coins behave like an energy currency: a small starting
// balance, a strictly bounded daily top-up, tight per-bet caps and a hard
// ceiling on what a single win may pay.
//
// There is deliberately NO ceiling on a wallet BALANCE. A balance may grow past
// any round number and every legitimate credit is paid in full; what is bounded
// is what one match can add (`GLOBAL_MAX_BET` / `HIGH_VARIANCE_MAX_BET` bound the
// stake, `MAX_WIN_PER_MATCH` bounds the payout). `users.balance` is
// NUMERIC(30, 2) — ~10^28 with two decimals — which is orders of magnitude
// beyond what those caps and the faucets can produce, so no schema widening is
// needed and credits never clamp against the current balance.
//
//   * STARTING_COINS            — the balance a new account opens with.
//   * DAILY_ENERGY_GRANT        — the most a player is topped up in one UTC
//                                 day.
//   * ENERGY_GRANT_FLOOR        — the balance the daily top-up refills to;
//                                 the grant only applies while a player is
//                                 BELOW this, so it can never be farmed.
//   * GLOBAL_MAX_BET            — the maximum wager any player may place in
//                                 any game.
//   * HIGH_VARIANCE_MAX_BET     — tighter cap for games whose payouts can
//                                 spike, so a single lucky roll can't mint
//                                 millions.
//   * MAX_WIN_PER_MATCH         — absolute ceiling on what ONE match may pay
//                                 out, regardless of wager or multiplier.
//   * HOUSE_RTP                 — return-to-player ceiling for house/PvE
//                                 games (the house keeps at least 1 − RTP).
//   * DAILY_REWARD_CYCLE        — the curated 14-day login-reward curve.
//   * ZERO_BALANCE_RESCUE       — the one-last-game top-up for an empty wallet.
//   * PVP_RAKE_PCT              — every 1v1 match takes 10% of the pot
//                                 (winner gets 90%: 1.8x on a 2x pot).
//
// IMPORTANT: the plain-JS constants files under src/lib/*-pvp/constants.js
// (which are imported by the `node --test` engine tests WITHOUT tsx) keep
// their own inlined copies of these values with a "must match" comment.
// Keep them in lockstep with this file.

/**
 * Balance a brand-new account opens with (tokens). MUST match the
 * `users.balance` default in src/db/schema.ts (1000.00).
 */
export const STARTING_COINS = 1_000;

/**
 * The most a player can be topped up by the daily energy grant in one UTC
 * day (tokens). Cap, not an entitlement: the grant only fires while the
 * balance is below `ENERGY_GRANT_FLOOR`, and only tops it up to the floor.
 */
export const DAILY_ENERGY_GRANT = 500;

/**
 * The balance the daily grant refills to (tokens). A player at or above this
 * floor receives nothing, so the grant can never be farmed above it; a player
 * below it is topped up by at most `DAILY_ENERGY_GRANT`.
 */
export const ENERGY_GRANT_FLOOR = 500;

/**
 * Hard ceiling for any single wager (tokens). Applies to every game unless a
 * tighter per-game cap (e.g. `HIGH_VARIANCE_MAX_BET`) is chosen.
 */
export const GLOBAL_MAX_BET = 100;

/**
 * Ceiling for high-variance games (large-payout style), so one lucky roll
 * cannot mint a disproportionate amount.
 */
export const HIGH_VARIANCE_MAX_BET = 25;

/**
 * Absolute ceiling on the tokens a SINGLE match may pay out (net win, tokens),
 * whatever the wager or multiplier. A backstop on top of the per-bet caps.
 */
export const MAX_WIN_PER_MATCH = 1_000;

/**
 * Return-to-player ceiling for house / PvE games: expected payout per token
 * wagered must not exceed this, so the house keeps at least `1 - HOUSE_RTP`.
 * PvP is zero-sum minus `PVP_RAKE_PCT` and is not governed by this.
 */
export const HOUSE_RTP = 0.9;

/**
 * The daily login reward paid for each day of a 14-day cycle (tokens), indexed
 * by `cycleDay - 1`. Curated deliberately — see the note below.
 *
 * The cycle pays 1,350 tokens over a full fortnight (≈96/day), which is:
 *   * enough to be worth opening the app for — day 1 already funds a real
 *     wager, and the ramp is steep enough that the streak you are on is
 *     visibly worth more than the one you would restart;
 *   * far too little to out-earn playing — a single `GLOBAL_MAX_BET` wager is
 *     100, the payday (200) is under three max bets, and the whole fortnight
 *     is less than three `ENERGY_GRANT_FLOOR` top-ups, so the reward nudges a
 *     player back into a game instead of replacing it;
 *   * safe to hand out to every player who shows up and plays one game, which
 *     is exactly what it is gated on.
 *
 * The curve escalates on EVERY day (never flat, never a dip), so the streak a
 * player is building always reads as progress, and day 14 (200) is the payoff
 * that makes completing the fortnight the goal. Day 15 wraps back to 30: the
 * cycle is a loop, not a ladder into an income.
 */
export const DAILY_REWARD_CYCLE = [30, 35, 45, 50, 60, 70, 80, 90, 105, 120, 135, 155, 175, 200];

/**
 * Tokens handed to a broke player so they always have one more game in them
 * (tokens). Fires only at an empty balance, at most once per UTC day, and only
 * after the day's energy grant has already been spent — so it is a floor of
 * "one last wager", never an income. 10 is a small, honest wager (well under
 * `HIGH_VARIANCE_MAX_BET`), not a restart of the daily allowance.
 */
export const ZERO_BALANCE_RESCUE = 10;

/**
 * Daily net-loss soft-warning threshold (tokens). When a player is down more
 * than this in one day, the lobby shows a responsible-play warning they must
 * acknowledge before continuing. Scaled to the balanced economy (one day's
 * energy grant).
 */
export const DAILY_LOSS_WARNING_THRESHOLD = 500;

/** Below this daily loss, the lobby shows a subtle "down today" chip. */
export const DAILY_LOSS_CHIP_THRESHOLD = 100;

/** Shared PvP rake: 10% of the pot, winner keeps 90% (payout = 1.8x wager). */
export const PVP_RAKE_PCT = 0.10;

/** Winner's share of the pot after rake (1 - PVP_RAKE_PCT). */
export const PVP_WINNER_SHARE = 1 - PVP_RAKE_PCT; // 0.90
