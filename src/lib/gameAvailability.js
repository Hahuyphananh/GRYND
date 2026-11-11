// src/lib/gameAvailability.js
//
// THE CENTRAL GAME AVAILABILITY REGISTRY.
//
// GRYND is now a Solitaire-first platform. Solitaire Duel is the only game the
// public product discovers, serves or matches. Every other shipped game is
// TEMPORARILY ARCHIVED: its source, assets, database tables, API routes and
// match history all stay exactly where they are, and reactivating one means
// removing its entry below — nothing else.
//
// ── Why a family, not a single id ─────────────────────────────────────────
//
// GRYND games carry several ids: the lobby `leaderboardKey`, the public page
// slug, the rating/trophy key, the presence label and the quick-queue key.
// Each archived game lists every alias it is known by, so no caller can bypass
// the setting by using a different id for the same game. This is a lookup
// table, NOT a feature-flag system.
//
// ── Invariants ────────────────────────────────────────────────────────────
//
//   * Unknown ids are ACTIVE. A typo must never hide a real game, and this
//     module must stay inert for every game it does not name.
//   * Catalogs (GAME_CATALOG, GAME_LANDING_PAGES, RATED_GAMES) keep their
//     archived entries — historical data and future reactivation depend on
//     them. Discovery surfaces filter with `isGameAvailable`.
//   * This module is plain JS with no imports so it can be used from client
//     components, server routes, middleware and plain-Node tests alike.

/** The two lifecycle values a game can have. */
export const GAME_STATUS = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived",
});

/** The one game the public product currently offers. */
export const PUBLIC_GAMES = Object.freeze([
  { id: "solitaire-duel", name: "Solitaire Duel", aliases: ["solitaire-duel"] },
]);

/**
 * The archived games, by family.
 *
 * `id`      the id the registry reports (the game's canonical public id)
 * `name`    the player-facing name (diagnostics only — never rendered)
 * `aliases` every id the game is known by across the platform
 */
export const ARCHIVED_GAMES = Object.freeze([
  { id: "mines-pvp", name: "Mines Duel", aliases: ["mines-pvp"] },
  { id: "memory-grid", name: "Memory Grid", aliases: ["memory-grid"] },
  { id: "chess", name: "Chess", aliases: ["chess"] },
  { id: "keno", name: "Keno", aliases: ["keno", "keno-pvp"] },
  { id: "uno", name: "Neon Flush", aliases: ["uno", "neon-flush"] },
  {
    id: "rps",
    name: "Rock Paper Scissors",
    aliases: ["rps", "rps-pvp", "rock-paper-scissors", "rock-paper-scissors-ai"],
  },
  { id: "tower-arena", name: "Tower Arena", aliases: ["tower-arena"] },
  { id: "four-in-a-row", name: "Four In A Row", aliases: ["four-in-a-row"] },
  {
    id: "lane-runner",
    name: "Lane Rush",
    aliases: ["lane-runner", "lane-rush", "lane-rush-duel"],
  },
  { id: "pool-masters", name: "Pool Masters", aliases: ["pool-masters", "pool"] },
  { id: "hex-duel", name: "Hex Duel", aliases: ["hex-duel"] },
  { id: "odds", name: "Odds", aliases: ["odds", "odds-pvp"] },
  { id: "precision", name: "Precision", aliases: ["precision"] },
  { id: "dots-and-boxes", name: "Dots & Boxes", aliases: ["dots-and-boxes"] },
  { id: "mini-golf", name: "Mini Golf", aliases: ["mini-golf"] },
  { id: "speed-typing", name: "Speed Typing", aliases: ["speed-typing"] },
  { id: "tic-tac-toe", name: "Tic-Tac-Toe", aliases: ["tic-tac-toe"] },
  { id: "sudoku-duel", name: "Sudoku Duel", aliases: ["sudoku-duel"] },
  { id: "barricade", name: "Barrier Blitz", aliases: ["barricade", "barrier-blitz"] },
  { id: "dominoes", name: "Dominoes", aliases: ["dominoes"] },
  { id: "hillstrike", name: "Hillstrike", aliases: ["hillstrike"] },
  { id: "battleship", name: "Battleship", aliases: ["battleship"] },
  { id: "dice-flush", name: "Dice Flush", aliases: ["dice-flush"] },
]);

/** The public landing-page slugs that belong to archived games. */
export const ARCHIVED_LANDING_SLUGS = Object.freeze([
  "mines-pvp",
  "memory-grid",
  "chess",
  "keno",
  "neon-flush",
  "rps",
  "tower-arena",
  "four-in-a-row",
  "lane-runner",
  "pool-masters",
  "precision",
  "dots-and-boxes",
  "mini-golf",
  "speed-typing",
  "tic-tac-toe",
  "sudoku-duel",
  "odds",
  "hex-duel",
  "uno",
  "barrier-blitz",
  "dominoes",
  "hillstrike",
  "battleship",
]);

/** Every archived alias, flattened — the membership set the helpers use. */
const ARCHIVED_ALIASES = new Set(
  ARCHIVED_GAMES.flatMap((game) => [game.id, ...game.aliases]),
);

/** The player-facing message for an archived game. Deliberately says nothing
 *  about why it was removed or what it was implemented with. */
export const GAME_UNAVAILABLE_MESSAGE =
  "That game is not available right now. GRYND is currently focused on Solitaire Duel.";

/** Normalize an id (trim + lowercase) without throwing on odd input. */
function normalizeGameKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** True when this game family is archived. Accepts any known alias. */
export function isGameArchived(value) {
  const key = normalizeGameKey(value);
  return key.length > 0 && ARCHIVED_ALIASES.has(key);
}

/**
 * True when a game may be shown/served/matched right now.
 *
 * Unknown ids are ACTIVE by design (see the invariants above), so adding a new
 * game never requires touching this file.
 */
export function isGameAvailable(value) {
  const key = normalizeGameKey(value);
  return key.length > 0 && !ARCHIVED_ALIASES.has(key);
}

/**
 * Filter a list of games down to the available ones.
 *
 * @param {Iterable<T>} games
 * @param {(game: T) => unknown} [getId]  defaults to the item itself
 * @returns {T[]}
 */
export function filterAvailableGames(games, getId = (game) => game) {
  return [...(games ?? [])].filter((game) => isGameAvailable(getId(game)));
}

// ── Route classification (used by src/proxy.ts) ──────────────────────────
//
// Both URL prefixes are covered because next.config.js rewrites /games/* to
// /casino/* (middleware runs before the rewrite) and 308s /casino/* back to
// /games/*, so a request can arrive with either. `/uno` is the one top-level
// alias page. `/games/solitaire-duel` and `/casino/solitaire-duel` are absent
// from this list on purpose.
const ARCHIVED_PAGE_PATH =
  /^\/(?:games|casino)\/(?:mines-pvp|memory-grid|chess|keno-pvp|keno|uno|neon-flush|rps|tower-arena|four-in-a-row|lane-runner|lane-rush-duel|pool-masters|pool|precision|dots-and-boxes|mini-golf|speed-typing|tic-tac-toe|sudoku-duel|odds|hex-duel|barrier-blitz|barricade|dominoes|hillstrike|battleship|dice-flush)(?:\/|$)/;

/** True for a public/game URL belonging to an archived game (and its subpaths). */
export function isArchivedGamePath(pathname) {
  const path = normalizeGameKey(pathname);
  return ARCHIVED_PAGE_PATH.test(path) || /^\/uno(?:\/|$)/.test(path);
}

// Game-specific API namespaces. Shared endpoints (presence, quick queue,
// leaderboards, bet history, user stats) are deliberately NOT listed: they
// keep serving historical data and the Solitaire catalogue.
const ARCHIVED_API_PATH =
  /^\/api\/(?:barricade|battleship|chess|create-game|dice-flush|dominoes|dots-and-boxes|four-in-a-row|hex-duel|hillstrike|keno-pvp|lane-rush-duel|memory-grid|mines-pvp|mini-golf|odds|pool|practice|precision|rps|speed-typing|sudoku-duel|tic-tac-toe|tower-arena|uno)(?:\/|$)/;

/** True for a game-specific API request that belongs to an archived game. */
export function isArchivedGameApiPath(pathname) {
  const path = normalizeGameKey(pathname);
  // The vs-AI pause route is shared by EVERY practice surface, including
  // Solitaire Duel, and does not belong to any one archived game's namespace.
  // Leaving it in the archived `practice` group made Pause a silent 404 on
  // every live practice page.
  if (path === "/api/practice/pause") return false;
  return ARCHIVED_API_PATH.test(path);
}
