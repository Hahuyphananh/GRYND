// src/lib/defaultWagers.js
//
// Catalog of stake-based games and their built-in default wager (tokens).
// The Settings page lists these so players can set a per-game default; the
// /api/user/default-wagers route validates against the same key set; and
// each game page's wager state initializes through src/hooks/useDefaultWager.js
// with these exact keys.
//
// Dice Flush was retired from the public catalogue and its key removed here, so
// its stake is no longer configurable. Existing `default_wagers` blobs that
// still carry a "dice-flush" value are left untouched (the route MERGES into
// the stored object and never rewrites it), and every other game's key and
// fallback are unchanged.

export const WAGER_GAMES = [];

export const WAGER_GAME_KEYS = WAGER_GAMES.map((g) => g.key);

export const WAGER_BY_KEY = Object.fromEntries(
  WAGER_GAMES.map((g) => [g.key, g.fallback]),
);