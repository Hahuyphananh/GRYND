// src/lib/gameTags.js
//
// The centralized game-tag definition behind GRYND's personalization engine
// (src/lib/gameRecommendations.js).
//
// WHAT THIS IS
//   One entry per game in the casino lobby, in the SAME order as the lobby's
//   `games` array (src/app/casino/PageClient.jsx). That array is the
//   "featured" default order, and the recommendation engine's fallback must be
//   byte-for-byte that order — so this catalog's order IS the default order.
//
// WHAT THIS IS NOT
//   It deliberately does NOT duplicate display metadata. Names, descriptions,
//   images, `playsKey` and `recencyKey` stay where they are (the lobby and
//   src/lib/appTextTranslations.js); the lobby joins on `id`, which is the
//   canonical game id used everywhere else (leaderboardKey — the same key
//   src/app/classement and the lobby's "Newest" sort already use).
//
//   The only game facts an engine needs are: which game, where does it live,
//   and what is it like. That last one is `tags`.
//
// TAG VOCABULARY (all seven are used; nothing is tagged arbitrarily)
//   pvp         head-to-head 1v1 duel       — the lobby's pvpMode "1v1"
//   strategy    the match turns on planning / reading the opponent
//   fast_paced  short rounds decided by timing, reflexes or a quick sequence
//   casual      shallow learning curve — jump in and play
//   chance      randomness does most of the work; the player manages it
//   competitive positioned around rank/stake climbing rather than a pick-up game
//   skill       the outcome turns primarily on player ability
//
//   `pvp` is not an opinion: tests/game-recommendations.test.mjs extracts every
//   `pvpMode` from the lobby's games array and asserts the tags match the
//   lobby exactly, so a game can't be added without being tagged, and a tag
//   can't drift away from the lobby.
//
//   Every GRYND game is 1v1: the shared 3–6 player tables (Crash Arena's
//   six-seat tables, Tower Arena's 2–6 player towers) were retired and the
//   lobby's "Multiplayer" filter went with them, so `pvp` is on the WHOLE
//   catalog. It remains in the vocabulary because it is still literally true
//   and still what the questionnaire's "PvP duels" answer asks for — but it
//   no longer discriminates, so a `pvp` signal alone never reorders the lobby
//   (every game gains the same weight).
//
//   The remaining six are hand-assigned, one per game, from the game's own
//   shipped description (the `games.*_desc` copy shown on the lobby card) —
//   the rationale for every single game is written out below and in
//   docs/PERSONALIZATION.md. `chance` and `skill` are mutually exclusive: a
//   game whose outcome is primarily luck is not also primarily ability.

/** Every tag the engine understands. A test asserts each tagged game only
 *  uses values from this list. */
export const GAME_TAGS = [
  "pvp",
  "strategy",
  "fast_paced",
  "casual",
  "chance",
  "competitive",
  "skill",
];

/**
 * The canonical game catalog, in the lobby's featured order.
 *
 * Each entry:
 *   id    canonical game id (the lobby's leaderboardKey)
 *   href  a link to the game — its PUBLIC landing page (/games/<slug>), the
 *         same URL the hub cards use, which is what consumers render (e.g. a
 *         "For You" strip that has to link a game without importing the
 *         lobby's image/name data). NOT the lobby: /games/<slug>/play is the
 *         authenticated app route. It was /casino/<slug> before, which is the
 *         same URL one 308 redirect later.
 *   tags  the traits above
 */
export const GAME_CATALOG = [
  // Solitaire Duel is a 1v1 race over ONE server-generated Klondike deal: both
  // seats receive the exact same starting position and play it simultaneously,
  // so nothing is drawn during play and the outcome is a pure function of each
  // player's ability and speed (skill, and never `chance`). The first seat to
  // solve the whole puzzle wins immediately, and the greater progress wins if
  // nobody has before the match limit — a duel on the ranked ladder
  // (competitive) built around a race against a clock (fast_paced). It is a
  // ranked duel rather than a pick-up game, so it is not tagged `casual`.
  {
    id: "solitaire-duel",
    href: "/games/solitaire-duel",
    tags: ["pvp", "skill", "fast_paced", "competitive"],
  },
];

/** The default (featured) order — exactly the lobby's order. Returned for any
 *  player the engine has no usable preferences for. */
export const DEFAULT_GAME_ORDER = GAME_CATALOG.map((game) => game.id);

/** id → catalog entry, for lookups by consumers. */
export const GAMES_BY_ID = Object.fromEntries(GAME_CATALOG.map((game) => [game.id, game]));

// ── Token-wager support ────────────────────────────────────────────────────
//
// The coin economy is retired: no game supports a wager, so the "tokens"
// signal can never reorder the lobby. The helper stays (the recommendation
// engine calls it) and answers false for every game.

/** Does this game support a configurable token wager? No game does. */
export function supportsTokenWager() {
  return false;
}
