// src/lib/gameAvailability.js
//
// GRYND is a Solitaire-only platform.
//
// Solitaire Duel is the only game the product discovers, serves or matches.
// Every other game has been removed from the repository; the helpers below are
// kept because shared surfaces (navigation, sitemap, structured data, route
// guards) ask the same two questions: is this id a game, and may it be served?
//
// There is no archived-game table any more, and no reactivation switch: adding
// a game means adding it to the catalogue and this registry, not un-archiving
// one. Unknown ids are NOT available — the platform has exactly one game.

/** The one game the public product offers. */
export const PUBLIC_GAMES = Object.freeze([
  { id: "solitaire-duel", name: "Solitaire Duel" },
]);

/** Kept for callers that used to read the archived families. */
export const ARCHIVED_GAMES = Object.freeze([]);

/** Kept for callers that used to read archived landing slugs. */
export const ARCHIVED_LANDING_SLUGS = Object.freeze([]);

/** The ids that identify the Solitaire product across the platform. */
const SOLITAIRE_IDS = new Set(["solitaire-duel", "solitaire", "solitaire-solo"]);

/** The player-facing message for any other game URL. */
export const GAME_UNAVAILABLE_MESSAGE =
  "That game is not available. GRYND is dedicated to Solitaire Duel.";

/** Normalize an id (trim + lowercase) without throwing on odd input. */
function normalizeGameKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** No game is archived — removed games are gone rather than parked. */
export function isGameArchived() {
  return false;
}

/** True only for the Solitaire product ids. */
export function isGameAvailable(value) {
  const key = normalizeGameKey(value);
  return SOLITAIRE_IDS.has(key);
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

/** No public game path is archived; unknown game slugs 404 at routing. */
export function isArchivedGamePath() {
  return false;
}

/** No game-specific API namespace is archived. */
export function isArchivedGameApiPath() {
  return false;
}
