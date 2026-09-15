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
// TAG VOCABULARY (all eight are used; nothing is tagged arbitrarily)
//   pvp         head-to-head 1v1 duel       — EXACTLY the lobby's pvpMode "1v1"
//   multiplayer 3–6 player shared table     — EXACTLY the lobby's pvpMode "multi"
//   strategy    the match turns on planning / reading the opponent
//   fast_paced  short rounds decided by timing, reflexes or a quick sequence
//   casual      shallow learning curve — jump in and play
//   chance      randomness does most of the work; the player manages it
//   competitive positioned around rank/stake climbing rather than a pick-up game
//   skill       the outcome turns primarily on player ability
//
//   `pvp` and `multiplayer` are not opinions: tests/game-recommendations.test.mjs
//   extracts every `pvpMode` from the lobby's games array and asserts the tags
//   match one-for-one, so a new 1v1 game can't be added without being tagged,
//   and a tag can't drift away from the lobby.
//
//   The remaining six are hand-assigned, one per game, from the game's own
//   shipped description (the `games.*_desc` copy shown on the lobby card) —
//   the rationale for every single game is written out below and in
//   docs/PERSONALIZATION.md. `chance` and `skill` are mutually exclusive: a
//   game whose outcome is primarily luck is not also primarily ability.

import { WAGER_GAME_KEYS } from "./defaultWagers";

/** Every tag the engine understands. A test asserts each tagged game only
 *  uses values from this list. */
export const GAME_TAGS = [
  "pvp",
  "multiplayer",
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
 *   href  the lobby route the card links to (used by consumers, e.g. a
 *         future "For You" strip that has to render a link without importing
 *         the lobby's image/name data)
 *   tags  the traits above
 */
export const GAME_CATALOG = [
  // Shared wheel, shrinking board: decided by the spin (chance), quick rounds
  // (fast_paced), head-to-head (pvp).
  { id: "roulette", href: "/casino/roulette", tags: ["pvp", "chance", "fast_paced"] },

  // Best-of-3, "read the table, time your swaps": decisions (strategy) and
  // execution (skill) — not the deal.
  { id: "blackjack", href: "/casino/blackjack", tags: ["pvp", "strategy", "skill"] },

  // Staked 1v1 on a hidden 5x5 mine board: the mines are luck (chance), the
  // staked duel is the competitive core.
  { id: "mines-pvp", href: "/casino/mines-pvp", tags: ["pvp", "chance", "competitive"] },

  // Flip pairs on a 4x4 grid: memory is ability (skill), the rules take
  // seconds to learn (casual).
  { id: "memory-grid", href: "/casino/memory-grid", tags: ["pvp", "skill", "casual"] },

  // Same peg field, 3 balls each: the drop is chance, the match is quick
  // (fast_paced).
  { id: "plinko", href: "/casino/plinko", tags: ["pvp", "chance", "fast_paced"] },

  // Multiplayer Texas Hold'em: bluffing/reading is planning (strategy + skill)
  // and the table is the ranked ladder (competitive), 3+ players (multiplayer).
  {
    id: "poker",
    href: "/casino/poker/multi",
    tags: ["multiplayer", "strategy", "skill", "competitive"],
  },

  // Shared-table last-player-standing on a random crash curve: the curve is
  // chance, the rounds are short (fast_paced), the table is competitive.
  {
    id: "crash",
    href: "/casino/crash-arena",
    tags: ["multiplayer", "chance", "fast_paced", "competitive"],
  },

  // "Outthink your opponent move by move": the archetypal strategy/skill game,
  // and the archetypal ranked one.
  { id: "chess", href: "/casino/chess", tags: ["pvp", "strategy", "skill", "competitive"] },

  // Same 10-ball draw for both players (chance) with timed taps (fast_paced);
  // the rules need no teaching (casual).
  { id: "keno", href: "/casino/keno", tags: ["pvp", "chance", "fast_paced", "casual"] },

  // "Fast card duels. Match colors and numbers": fast_paced, instantly
  // readable (casual), 3+ players (multiplayer).
  { id: "uno", href: "/casino/neon-flush", tags: ["multiplayer", "fast_paced", "casual"] },

  // Best-of-7 mind games: a round resolves in a click (fast_paced) and there
  // is nothing to learn (casual).
  { id: "rps", href: "/casino/rps", tags: ["pvp", "fast_paced", "casual"] },

  // Shared-tower survival for 2–6 players: placement planning (strategy) and
  // collapse-risk reading (skill) on a ranked table (competitive).
  {
    id: "tower-arena",
    href: "/casino/tower-arena",
    tags: ["multiplayer", "strategy", "skill", "competitive"],
  },

  // Align 4 discs: pure planning (strategy) against one opponent (skill).
  {
    id: "four-in-a-row",
    href: "/casino/four-in-a-row",
    tags: ["pvp", "strategy", "skill"],
  },

  // "Every safe pick either of you makes narrows the odds": climb-and-bank
  // reads are ability (skill) and the staked race is competitive.
  {
    id: "lane-runner",
    href: "/casino/lane-runner",
    tags: ["pvp", "skill", "competitive", "fast_paced"],
  },

  // Aiming and table planning: ability (skill) over a plan (strategy).
  { id: "pool-masters", href: "/casino/pool-masters", tags: ["pvp", "skill", "strategy"] },

  // Hex-grid territory conquest: capture planning (strategy) decided by play
  // (skill), on the ranked ladder (competitive).
  {
    id: "hex-duel",
    href: "/casino/hex-duel",
    tags: ["pvp", "strategy", "skill", "competitive"],
  },

  // Roll five dice (chance), then lock combos to outscore: the locking is the
  // plan (strategy).
  { id: "yahtzee", href: "/casino/dice-flush", tags: ["pvp", "chance", "strategy"] },

  // Hidden numbers and shrinking ranges: prediction/mind games (strategy) —
  // guessing right is reading the opponent, not the dice (skill).
  { id: "odds", href: "/casino/odds", tags: ["pvp", "strategy", "skill"] },

  // Stop closest to the target: reaction timing (skill + fast_paced) in a
  // staked 1v1 duel (competitive).
  {
    id: "precision",
    href: "/casino/precision",
    tags: ["pvp", "skill", "fast_paced", "competitive"],
  },

  // Take turns claiming boxes: pencil-and-paper planning (strategy) decided by
  // play (skill).
  {
    id: "dots-and-boxes",
    href: "/casino/dots-and-boxes",
    tags: ["pvp", "strategy", "skill"],
  },
];

/** The default (featured) order — exactly the lobby's order. Returned for any
 *  player the engine has no usable preferences for. */
export const DEFAULT_GAME_ORDER = GAME_CATALOG.map((game) => game.id);

/** id → catalog entry, for lookups by consumers. */
export const GAMES_BY_ID = Object.fromEntries(GAME_CATALOG.map((game) => [game.id, game]));

// ── Token-wager support ────────────────────────────────────────────────────
//
// Q1 ("Rewards") and Q4 ("Earning tokens") care about games where a player can
// put tokens at stake — and GRYND already has that fact in one place:
// src/lib/defaultWagers.js (the catalog the Settings page and
// /api/user/default-wagers validate against). Reused rather than re-tagged, so
// adding a wager to a game automatically feeds the engine.
//
// Two catalog ids differ from their wager key (the wager catalog predates the
// lobby rename); everything else matches by id.
const WAGER_KEY_BY_GAME_ID = {
  "mines-pvp": "mines",
  yahtzee: "dice-flush",
};

/** Does this game support a configurable token wager? */
export function supportsTokenWager(gameId) {
  return WAGER_GAME_KEYS.includes(WAGER_KEY_BY_GAME_ID[gameId] ?? gameId);
}
