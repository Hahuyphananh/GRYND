// src/lib/quests/games.ts
//
// Canonical game identities for quests.
//
// WHY THIS EXISTS
//   A "play matches in N different games" quest must count a GAME once. But the
//   settlement writers report game-specific keys — `keno-pvp`, `rps-pvp`,
//   `lane-rush-duel`, `odds-pvp` — while the rest of the platform (the lobby
//   catalog in src/lib/gameTags.js, the leaderboards, the trophy keys) calls the
//   same games `keno`, `rps`, `lane-runner`, `odds`. Counting raw settlement
//   keys would let one game satisfy two slots of a "different games" quest, and
//   counting display names would break the moment a label is re-worded.
//
//   So quests store CANONICAL ids, and every incoming key is normalized through
//   `canonicalQuestGame` before it can touch progress. Unknown keys are rejected
//   (null) rather than trusted: a quest must never grow from a game the platform
//   does not recognise.
//
// The canonical ids are the lobby's `id`s (the ids `gameTags.js` documents as
// "the canonical game id used everywhere else"), plus `dice-flush`, which is a
// real PvP game in the repo but is not part of the lobby's catalog.

export const QUEST_GAME_IDS = [
  "mines-pvp",
  "memory-grid",
  "chess",
  "keno",
  "uno",
  "rps",
  "tower-arena",
  "four-in-a-row",
  "lane-runner",
  "pool-masters",
  "hex-duel",
  "odds",
  "precision",
  "dots-and-boxes",
  "mini-golf",
  "speed-typing",
  "tic-tac-toe",
  "solitaire-duel",
  "sudoku-duel",
  "barricade",
  "dice-flush",
  // LAST RUN settles through applyRatingResult, whose quest recorder rejects an
  // unknown key (`canonicalQuestGame` → null, `reason: "unknown-game"`). The
  // game is a real 1v1 duel, so it belongs in the catalogue: without this entry
  // a completed match would rate but never advance a quest.
  "last-run",
] as const;

export type QuestGameId = (typeof QUEST_GAME_IDS)[number];

/**
 * Settlement keys that differ from their canonical id. Most games already use
 * the canonical key; only these four need translating.
 *
 * Keep this list in lockstep with the `gameKey` passed to
 * `applyRatingResult` / `applyLeaderboardCounters` by each settle path.
 */
export const QUEST_GAME_ALIASES: Readonly<Record<string, QuestGameId>> = {
  "keno-pvp": "keno",
  "rps-pvp": "rps",
  "lane-rush-duel": "lane-runner",
  "odds-pvp": "odds",
  // The pool settle route (src/app/api/pool/resign/route.ts) reports its result
  // under the rating key "pool", while the lobby — and therefore the quest
  // catalog — calls the same game "pool-masters". Without this alias every
  // Pool Masters match would be rejected as an unknown game and the
  // distinct-games quests would silently never see it.
  pool: "pool-masters",
};

/**
 * Normalize any game key to a canonical quest game id, or `null` when the key is
 * unknown / not a game at all.
 *
 * Unknown is a rejection on purpose: `null` can never advance a quest, so a
 * mistyped or newly added game key cannot silently count towards a
 * distinct-games objective until it is added here deliberately.
 */
export function canonicalQuestGame(gameKey: unknown): QuestGameId | null {
  if (typeof gameKey !== "string") return null;
  const key = gameKey.trim().toLowerCase();
  if (!key) return null;

  const alias = QUEST_GAME_ALIASES[key];
  if (alias) return alias;

  return (QUEST_GAME_IDS as readonly string[]).includes(key)
    ? (key as QuestGameId)
    : null;
}
