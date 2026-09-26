// src/lib/games/stakes.js
//
// STAKES ARE RETIRED — a match costs nothing to enter and moves no tokens.
//
// Every stake-based game used to take a wager from the client, check the
// player's token balance, debit it on entry and credit a payout on settle.
// That is over. Competitive play is now decided by TROPHIES (per-game
// progression) and ELO (Prestige, revealed at the trophy cap) — a result is
// worth the same whether or not anything was at risk, and nothing is.
//
// WHY THIS MODULE EXISTS
//   The wager was never validated in one place: each game had its own
//   `stake > 0` check, its own balance guard, its own debit and its own
//   payout. Retiring them one route at a time is the migration, and this is
//   the ONE place the decision lives while it happens — so the answer to
//   "can a match move tokens?" is identical for every game, and flipping the
//   switch can never leave half the app charging players.
//
//   `normalizeStake()` is applied at each entry point, which makes the
//   downstream money arithmetic operate on 0: a debit of 0, a pot of 0, a
//   payout of 0. Tokens cannot move even before the dead machinery is deleted,
//   and the deletion is then a pure removal instead of a behaviour change.
//
// WHAT REPLACES A WAGER
//   * A match still creates a row (with stake 0) and still counts for the
//     leaderboard counters, trophies and Elo — the *result* is unchanged.
//   * The lobby no longer asks for a stake (see useDefaultWager), so there is
//     nothing to set up before playing.
//
// DELETION ORDER (this module goes away last)
//   1. every entry point reads this seam  → matches stop moving tokens,
//   2. the dead debit/payout/pot machinery is deleted per game,
//   3. the token currency itself is retired (balance, ledger, purchases,
//      rewards) and this file is deleted with it.

/**
 * True while a match is forbidden from moving tokens. Named as a fact rather
 * than a feature flag: there is no supported mode in which a ranked match
 * takes or pays tokens, so no caller may branch on it to re-enable them.
 */
export const STAKES_RETIRED = true;

/** The stake every match is created and joined with: none. */
export const FREE_STAKE = 0;

/**
 * The stake the platform will honour for a match, given whatever the client
 * sent (a number, a string, a legacy field, or nothing at all). Always
 * FREE_STAKE while stakes are retired, so a client can neither raise a stake
 * nor make one required.
 *
 * The argument is accepted and ignored on purpose: removing the parameter
 * would force every caller to change shape at the same time, and the point of
 * the seam is that each game can be migrated independently.
 */
export function normalizeStake(_requested) {
  return STAKES_RETIRED ? FREE_STAKE : Number(_requested) || 0;
}

/**
 * True when a match may move tokens. Never, while stakes are retired — the
 * debit and payout paths guard on this instead of being half-deleted.
 */
export function tokensMoveForMatches() {
  return !STAKES_RETIRED;
}

/**
 * True when a non-zero stake is a legal entry value. Never, while stakes are
 * retired, so an entry point can answer "Invalid stake" for a *charging*
 * request rather than silently accepting one.
 */
export function isStakeAccepted(requested) {
  return tokensMoveForMatches() && Number(requested) > 0;
}

/**
 * The display value for a stake in the UI: nothing, always.
 */
export const STAKE_LABEL = "Free play";
