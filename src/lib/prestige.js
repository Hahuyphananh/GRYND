// src/lib/prestige.js
//
// DERIVED PRESTIGE — the endgame view of Elo progress, per game.
//
// The legacy XP/net-wins Prestige was retired (it was global and gated on
// Battle Pass XP, which is orthogonal to per-game skill). Prestige is now a
// PURE, DERIVED value with NO column, NO writer and NO history:
//
//   prestige = max(0, elo − 1000)      (per game)
//
// and it only counts once that game's TROPHY progression is complete — i.e. the
// player has reached the 10,000 trophy cap in that game. Before the cap,
// trophies are the progression; after it, Elo (and its Prestige) take over.
//
// Because it reads the Elo value `player_ratings` already maintains, it can
// never duplicate, drift from, or move a rating. Everything here is a pure
// function of already-loaded read shapes:
//   * `ratings`  — the `gameKey → { rating, ... }` map from
//     `getRatingsForUser` (src/lib/rating.js),
//   * `trophies` — the `gameKey → { trophies, ... }` map from
//     `getTrophiesForUser` (src/lib/trophyStore.js).
//
// Nothing here can be set by a client: there is no write path at all.

import { STARTING_RATING } from "./elo";
import { TROPHY_MAX } from "./trophies";

/**
 * Prestige for a single rating: `max(0, elo − 1000)`. Pure and unbounded above
 * (a 2400 rating is Prestige 1400).
 */
export function prestigeFromRating(rating) {
  const value = Math.round(Number(rating));
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value - STARTING_RATING);
}

/**
 * Prestige for ONE game, gated on the trophy cap. Returns 0 until the player
 * has completed trophy progression in that game (trophies >= 10,000).
 */
export function prestigeForGame({ trophies, rating } = {}) {
  const value = Number(trophies);
  if (!Number.isFinite(value) || value < TROPHY_MAX) return 0;
  return prestigeFromRating(rating);
}

/**
 * The player's headline Prestige across games: the highest Prestige among the
 * games they have completed (capped), or null when none are capped.
 *
 * @param {object} ratings   gameKey → rating entry (from getRatingsForUser)
 * @param {object} trophies  gameKey → trophy entry (from getTrophiesForUser)
 * @returns {null | { gameKey: string, prestige: number, rating: number }}
 */
export function bestPrestige(ratings, trophies) {
  let best = null;
  for (const [gameKey, entry] of Object.entries(trophies || {})) {
    const rating = ratings?.[gameKey]?.rating;
    const prestige = prestigeForGame({ trophies: entry?.trophies, rating });
    if (prestige > 0 && (!best || prestige > best.prestige)) {
      best = { gameKey, prestige, rating: Number(rating) || STARTING_RATING };
    }
  }
  return best;
}

/**
 * Read-shape helper for the profile / stats / battlepass APIs. Keeps the
 * historical field names so existing consumers keep working, but every value
 * is derived from the ratings + trophies the caller already loaded.
 *
 * @param {{ ratings?: object, trophies?: object }} input
 */
export function getPrestigeStatus({ ratings, trophies } = {}) {
  const best = bestPrestige(ratings, trophies);
  return {
    prestige: best?.prestige ?? 0,
    // Which game earned the headline Prestige (a per-game concept, so the
    // badge/UI always names the game it belongs to).
    prestigeGameKey: best?.gameKey ?? null,
    prestigeUnlocked: Boolean(best),
    prestigeNetWins: 0,
    nextPrestigeRequirement: 0,
    prestigeProgressPercent: 0,
    maxPrestige: 0,
  };
}

/**
 * Server-authoritative resolution of the equippable "Prestige N" badge.
 *
 * Requires the player to have opted in (`showPrestigeBadge`) AND to have
 * completed trophy progression in at least one game, with a rating above the
 * 1000 start (so a "Prestige 0" is never shown). Any client-supplied value is
 * ignored — the badge is resolved from the server-loaded ratings + trophies.
 *
 * @param {{ showPrestigeBadge?: boolean, ratings?: object, trophies?: object }} input
 * @returns {string|null} e.g. "Prestige 500", or null
 */
export function resolvePrestigeBadge({
  showPrestigeBadge = false,
  ratings,
  trophies,
} = {}) {
  if (!showPrestigeBadge) return null;
  const best = bestPrestige(ratings, trophies);
  if (!best || best.prestige < 1) return null;
  return `Prestige ${best.prestige}`;
}
