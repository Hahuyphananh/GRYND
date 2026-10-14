// src/lib/games/economy.ts
//
// Canonical token-economy constants shared across every game.
//
// Single source of truth for the platform-wide numbers behind the balanced
// coin economy. Coins behave like an energy currency: a small starting
// balance, a strictly bounded daily top-up, tight per-bet caps and hard
// ceilings on a single win and on a wallet — so no account can ever reach
// millions by playing.
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
//   * WALLET_HARD_CAP           — balance ceiling no credit may cross.
//   * DAILY_REWARD_CYCLE        — the curated 7-day login-reward curve.
//   * ZERO_BALANCE_RESCUE       — the one-last-game top-up for an empty wallet.
//   * PVP_RAKE_PCT              — every 1v1 match takes 5% of the pot
//                                 (winner gets 95%: 1.9x on a 2x pot).
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
 * Balance ceiling no credit may cross (tokens). `creditUserBalance` / the
 * settlement payout path must clamp a credit so `balance` never exceeds this,
 * which is the final guarantee that an account cannot reach millions.
 */
export const WALLET_HARD_CAP = 100_000;

/**
 * The daily login reward paid for each day of a 7-day cycle (tokens), indexed
 * by `cycleDay - 1`. Curated deliberately — see the note below.
 *
 * The cycle pays 725 tokens over a full week (≈104/day), which is:
 *   * enough to be worth opening the app for — day 1 already funds a real
 *     wager, and day 7 (250) is a payday worth ~2.5 max bets;
 *   * far too little to out-earn playing — a single `GLOBAL_MAX_BET` wager is
 *     100, and the whole week pays under one `ENERGY_GRANT_FLOOR` top-up, so
 *     the reward nudges a player back into a game instead of replacing it;
 *   * safe to hand out to every player who shows up and plays one game, which
 *     is exactly what it is gated on.
 *
 * The curve escalates so a returning streak is visibly worth more, and day 7
 * is the payoff that makes completing the cycle the goal.
 */
export const DAILY_REWARD_CYCLE = [30, 45, 60, 80, 110, 150, 250];

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

/** Shared PvP rake: 5% of the pot, winner keeps 95% (payout = 1.9x wager). */
export const PVP_RAKE_PCT = 0.05;

/** Winner's share of the pot after rake (1 - PVP_RAKE_PCT). */
export const PVP_WINNER_SHARE = 1 - PVP_RAKE_PCT; // 0.95
