// src/lib/prestige.js
//
// DERIVED PRESTIGE — the GATED, endgame view of Elo, per game.
//
// Elo is tracked SILENTLY from a player's first rated match, but it is not
// shown anywhere until that game's trophies reach the cap (TROPHY_MAX, 1,000).
// At the cap, that game's Elo becomes visible as the game's PRESTIGE — and it
// IS the Elo value: it starts at STARTING_RATING (1000) and moves like chess
// Elo from there. Higher is better.
//
//   per-game Prestige = the game's Elo value, once trophies >= TROPHY_MAX
//   Overall Prestige  = the AVERAGE of every game's Prestige, shown only once
//                       the player has capped EVERY rated game
//
// Trophies stay ADDITIVE (overall trophies = the sum of per-game counts) — only
// Prestige is averaged.
//
// Everything here is a pure function of already-loaded read shapes, so it can
// never duplicate, drift from, or move a rating:
//   * `ratings`  — the `gameKey → { rating, ... }` map from `getRatingsForUser`
//     (src/lib/rating.js),
//   * `trophies` — the `gameKey → { trophies, ... }` map from
//     `getTrophiesForUser` (src/lib/trophyStore.js).
//
// Nothing here can be set by a client: there is no write path at all.

import { STARTING_RATING } from "./elo";
import { TROPHY_MAX, TROPHY_GAMES } from "./trophies";

/**
 * Prestige for a single rating: the Elo VALUE itself (starts at 1000).
 * Pure and unbounded above (a 2400 rating is Prestige 2400).
 */
export function prestigeFromRating(rating) {
  const value = Math.round(Number(rating));
  if (!Number.isFinite(value)) return STARTING_RATING;
  return value;
}

/** True once a game's trophies reach the cap — i.e. its Prestige is unlocked. */
export function isPrestigeUnlocked(trophies) {
  const value = Number(trophies);
  return Number.isFinite(value) && value >= TROPHY_MAX;
}

/**
 * Prestige for ONE game, gated on the trophy cap. Returns `null` until the
 * player has capped that game's trophies; thereafter it is the player's Elo
 * value for that game.
 */
export function prestigeForGame({ trophies, rating } = {}) {
  if (!isPrestigeUnlocked(trophies)) return null;
  return prestigeFromRating(rating);
}

/**
 * The per-game Prestige map for a player: `gameKey → number | null`, where a
 * number is a capped game's Elo and `null` is a game that is not capped yet.
 * Every rated game is present so the UI never has to hardcode the list.
 */
export function perGamePrestige(ratings, trophies) {
  const out = {};
  for (const gameKey of TROPHY_GAMES) {
    out[gameKey] = prestigeForGame({
      trophies: trophies?.[gameKey]?.trophies,
      rating: ratings?.[gameKey]?.rating,
    });
  }
  return out;
}

/**
 * How many rated games the player has capped (Prestige unlocked for).
 * @returns {{ unlocked: number, total: number, all: boolean }}
 */
export function prestigeCoverage(trophies) {
  const total = TROPHY_GAMES.length;
  let unlocked = 0;
  for (const gameKey of TROPHY_GAMES) {
    if (isPrestigeUnlocked(trophies?.[gameKey]?.trophies)) unlocked += 1;
  }
  return { unlocked, total, all: total > 0 && unlocked >= total };
}

/**
 * The player's headline Prestige: the HIGHEST per-game Prestige among the games
 * they have capped, or null when none are capped.
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
    if (prestige !== null && (!best || prestige > best.prestige)) {
      best = { gameKey, prestige, rating: Number(rating) || STARTING_RATING };
    }
  }
  return best;
}

/**
 * Overall Prestige: the AVERAGE of every rated game's Prestige. It exists ONLY
 * once the player has capped EVERY rated game (each game contributes its own
 * Elo, so the average starts at 1000). Returns `null` (and `unlocked: false`)
 * until then.
 *
 * @returns {{ overallPrestige: number|null, unlocked: boolean, unlockedGames: number, totalGames: number }}
 */
export function overallPrestige(ratings, trophies) {
  const coverage = prestigeCoverage(trophies);
  if (!coverage.all) {
    return {
      overallPrestige: null,
      unlocked: false,
      unlockedGames: coverage.unlocked,
      totalGames: coverage.total,
    };
  }
  const perGame = perGamePrestige(ratings, trophies);
  const values = TROPHY_GAMES.map((gameKey) => perGame[gameKey]).filter(
    (value) => value !== null,
  );
  const average = Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
  return {
    overallPrestige: average,
    unlocked: true,
    unlockedGames: coverage.unlocked,
    totalGames: coverage.total,
  };
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
  const overall = overallPrestige(ratings, trophies);
  const coverage = prestigeCoverage(trophies);
  return {
    // Headline = the player's best single-game Prestige (0 when none capped).
    prestige: best?.prestige ?? 0,
    // Which game earned the headline Prestige (a per-game concept, so the
    // badge/UI always names the game it belongs to).
    prestigeGameKey: best?.gameKey ?? null,
    // True once the player has capped at least one game.
    prestigeUnlocked: Boolean(best),
    // Per-game prestige map (gameKey → Elo value | null), like per-game trophies.
    perGame: perGamePrestige(ratings, trophies),
    gamesPrestigeUnlocked: coverage.unlocked,
    gamesTotal: coverage.total,
    // Overall Prestige (average) — null until EVERY game is capped.
    overallPrestige: overall.overallPrestige,
    overallPrestigeUnlocked: overall.unlocked,
    overallPrestigeUnlockedGames: overall.unlockedGames,
    overallPrestigeTotalGames: overall.totalGames,
    // Legacy zero fields (kept so older consumers keep rendering).
    prestigeNetWins: 0,
    nextPrestigeRequirement: 0,
    prestigeProgressPercent: 0,
    maxPrestige: 0,
  };
}

/**
 * Server-authoritative resolution of the equippable "Prestige N" badge.
 *
 * Requires the player to have opted in (`showPrestigeBadge`) AND to have capped
 * at least one game (so Prestige exists). The badge shows the player's highest
 * per-game Prestige, which starts at 1000. Any client-supplied value is
 * ignored — the badge is resolved from the server-loaded ratings + trophies.
 *
 * @param {{ showPrestigeBadge?: boolean, ratings?: object, trophies?: object }} input
 * @returns {string|null} e.g. "Prestige 1243", or null
 */
export function resolvePrestigeBadge({
  showPrestigeBadge = false,
  ratings,
  trophies,
} = {}) {
  if (!showPrestigeBadge) return null;
  const best = bestPrestige(ratings, trophies);
  if (!best) return null;
  return `Prestige ${best.prestige}`;
}
