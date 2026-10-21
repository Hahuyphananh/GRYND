// src/lib/games/stakes.js
//
// THE wager policy: the ONE place that decides whether a match may move coins,
// and what a legal wager looks like. Every entry point, store and settlement
// path reads this module instead of policing a wager itself.
//
// Coins are the energy currency. A brand-new account opens with
// `STARTING_COINS`, a bounded daily grant tops a low balance back up to
// `ENERGY_GRANT_FLOOR`, a single wager is capped by the game's class, and a
// single match can pay out at most `MAX_WIN_PER_MATCH` (all in
// src/lib/games/economy.ts). Together those bound what one match can add —
// there is no ceiling on a wallet's total balance.
//
// A wager of 0 is LEGAL and means "no stake" — a practice / bot / free match.
// Any positive wager must be a whole number inside `[MIN_STAKE,
// maxStakeFor(game)]`. Keeping free play legal at this seam is deliberate: the
// lobby UI (which makes a coin wager the normal path) and the escrow helper
// (which actually debits/credits) build on top of it, so no game is ever
// unplayable in between.
//
// WHAT THIS MODULE IS NOT: it does not move coins. `validateWager` decides
// whether a wager is legal and `maxStakeFor` decides its ceiling; the debit and
// the payout live in src/lib/tokens/wager.ts so there is exactly one way a
// balance changes for a match.

import { GLOBAL_MAX_BET } from "./economy";

/**
 * True: a match may move coins again. Named as a fact rather than a feature
 * flag — there is no supported mode in which ranked play is free.
 */
export const WAGERING_ENABLED = true;

/** The stake a match carries when no wager was requested: none. */
export const FREE_STAKE = 0;

/** Smallest positive wager (coins). */
export const MIN_STAKE = 1;

/** Ceiling for any game that is not listed as high-variance (coins). */
export const MAX_STAKE = GLOBAL_MAX_BET;

/**
 * Per-game ceiling overrides. Empty today: every game in the catalogue is 1v1
 * (fixed 1.8x after rake) or single-player with a bounded payout, so the
 * global ceiling already applies. The house multiplier games that DID spike
 * (roulette 35:1, plinko ~120x) were retired; if one returns, add it here with
 * `HIGH_VARIANCE_MAX_BET` from ./economy — no per-game wager arithmetic lives
 * anywhere else.
 */
export const WAGER_CAPS = Object.freeze({});

/**
 * The largest legal wager for a game (coins). Unknown / missing game keys get
 * the global ceiling.
 */
export function maxStakeFor(gameKey) {
  const cap = WAGER_CAPS[String(gameKey || "").toLowerCase()];
  return Number.isFinite(cap) ? cap : MAX_STAKE;
}

/**
 * Validate a requested wager for a game.
 *
 * Returns `{ ok: true, stake }` where `stake` is the normalised whole number of
 * coins (0 for an absent / explicit "no wager"), or
 * `{ ok: false, error, status: 400 }` for a request that must be rejected —
 * so an entry point can answer `error` with `status` without inventing its own
 * message or its own range.
 */
export function validateWager(requested, gameKey) {
  const max = maxStakeFor(gameKey);
  // Absent / explicitly free is legal: a free match is never an error.
  if (requested === undefined || requested === null || requested === "") {
    return { ok: true, stake: FREE_STAKE };
  }
  const stake = Number(requested);
  if (!Number.isFinite(stake)) {
    return { ok: false, error: "Wager must be a number of coins", status: 400 };
  }
  if (stake < 0) {
    return { ok: false, error: "Wager cannot be negative", status: 400 };
  }
  if (stake === 0) return { ok: true, stake: FREE_STAKE };
  if (!Number.isInteger(stake)) {
    return { ok: false, error: "Wager must be a whole number of coins", status: 400 };
  }
  if (stake < MIN_STAKE) {
    return { ok: false, error: `Minimum wager is ${MIN_STAKE} coin`, status: 400 };
  }
  if (stake > max) {
    return { ok: false, error: `Maximum wager is ${max} coins`, status: 400 };
  }
  return { ok: true, stake };
}

/**
 * The wager the platform will honour, given whatever the client sent (a number,
 * a numeric string, a legacy field, or nothing at all). Finite positive values
 * are truncated to whole coins and clamped to the game's ceiling; anything
 * unusable becomes `FREE_STAKE`.
 *
 * This is the permissive companion to `validateWager`: legacy callers keep
 * their signature and can never store an illegal wager, while entry points that
 * must REJECT a bad request call `validateWager` instead.
 */
export function normalizeStake(requested, gameKey) {
  const stake = Number(requested);
  if (!Number.isFinite(stake) || stake <= 0) return FREE_STAKE;
  return Math.min(Math.trunc(stake), maxStakeFor(gameKey));
}

/** True when a match may move coins. */
export function tokensMoveForMatches() {
  return WAGERING_ENABLED;
}

/**
 * The wager a PvP ENTRY POINT requires: online ranked play always plays for
 * coins, so an entry that does not name a legal positive wager is refused
 * instead of silently opening a free match (
 * `validateWager` still treats an absent stake as legal FREE PLAY at the store
 * seam, which is what keeps practice / bot / AI matches free).
 *
 * Returns `{ ok: true, stake }` or `{ ok: false, error, status: 400, code }`,
 * so an entry point can answer `error` with `status` without inventing its own
 * message.
 */
export function requireStake(requested, gameKey) {
  const result = validateWager(requested, gameKey);
  if (!result.ok) return result;
  if (result.stake < MIN_STAKE) {
    return {
      ok: false,
      error: `A stake of at least ${MIN_STAKE} coin is required to play for coins`,
      status: 400,
      code: "STAKE_REQUIRED",
    };
  }
  return result;
}

/**
 * True when a non-zero stake is a legal entry value for the game. A zero /
 * absent stake is *valid* (free play) but not an accepted wager, so this stays
 * false for it.
 */
export function isStakeAccepted(requested, gameKey) {
  if (!tokensMoveForMatches()) return false;
  const result = validateWager(requested, gameKey);
  return result.ok && result.stake > 0;
}

/** How a coin wager is labelled in the UI. */
export const STAKE_LABEL = "Coins";
