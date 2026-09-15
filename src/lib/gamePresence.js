// src/lib/gamePresence.js
//
// The single source of truth for GRYND's per-game ACTIVE PLAYER presence
// (the casino lobby's "12 playing" badge).
//
// WHAT IT OWNS
//   1. The game identifier space used for presence — the CANONICAL game ids
//      (the lobby's `leaderboardKey`, the same ids src/lib/gameTags.js exports
//      and /casino/classement already links with). Nothing here invents a new
//      id: GAME_CATALOG is reused directly.
//   2. The map from the label each game page already passes to
//      <CreatorModeHost gameLabel="…"> / useRecordPlayedGame("…") onto that
//      canonical id. Game pages never need to change for this feature, and a
//      label that is not in this map is rejected by the API, so no request can
//      ever create a presence row for a game that does not exist.
//   3. The activity window and heartbeat cadence, so the client beat and the
//      server's expiration predicate can never drift apart.
//
// USED BY
//   * src/lib/gamePresenceStore.ts  (writes + aggregate)
//   * src/app/api/presence/active-game/**  (heartbeat / leave)
//   * src/app/api/casino/active-players/** (aggregate read)
//   * src/app/casino/PageClient.jsx      (the lobby's "N playing" badge)
//   * src/hooks/useActiveGamePresence.js (the shared heartbeat hook)
//   * tests/game-presence.test.mjs
//
// Plain JS on purpose — the header comment of src/lib/gameTags.js explains the
// same choice for the recommendation engine: it must import cleanly from
// client components, server routes and plain-Node test runners alike.

import { GAME_CATALOG } from "./gameTags";

/**
 * How long a presence row stays ACTIVE after its last heartbeat.
 *
 * 180s = 3 minutes, chosen against the heartbeat cadence below (60s, i.e.
 * three beats per window): two dropped beats still leave a player counted,
 * while a closed tab or crashed browser disappears within ~3 minutes — the
 * "users who close the page eventually disappear automatically" requirement.
 * Shortening the window would make the count flap; lengthening it would leave
 * ghosts on the lobby.
 *
 * This mirrors the two in-game windows already in the codebase: the game
 * heartbeat writes every 120s (src/hooks/useGamePresence.js) and the friends
 * feed treats anything older than 6 minutes as offline
 * (src/app/api/friends/game-presence/route.js). We take the tighter of the
 * two because a lobby badge is "playing right now", not "recently online".
 */
export const ACTIVE_PLAYER_WINDOW_SECONDS = 180;

/**
 * Client heartbeat cadence, in ms: 60s.
 *
 * Deliberately shorter than the existing in-game beat in
 * src/hooks/useGamePresence.js (120s), for one reason: with a 180s window this
 * gives THREE beats of tolerance, so two consecutive missed beats (a
 * backgrounded tab, a sleeping phone, a bad network moment) still can't blink a
 * genuinely playing user out of the count. The cost is one small UPSERT per
 * active player per minute — the same order as the app-wide presence heartbeat
 * the repo already runs for every signed-in tab, and far cheaper than the
 * per-round writes every game already does.
 */
export const PRESENCE_HEARTBEAT_MS = 60000;

/** `session_id` column width (one tab / one client session). */
export const PRESENCE_SESSION_MAX_LENGTH = 128;

/** Every canonical game id, straight from the centralized catalog. */
export const PRESENCE_GAME_IDS = GAME_CATALOG.map((game) => game.id);

/**
 * Which gameLabel belongs to which canonical game id.
 *
 * The LEFT side is every value that already exists in the repo: the 21
 * `gameLabel="…"` props on game pages plus the 4 labels passed to
 * useRecordPlayedGame. The RIGHT side is the lobby's leaderboardKey, so /casino
 * can render a count with a plain `counts[game.leaderboardKey]` lookup.
 *
 * Two labels intentionally share a game id: playing Chess vs the AI
 * (`chess-ai`) and a Chess duel (`chess`) are both "Chess" on the lobby, and
 * the same goes for Neon Flush / UNO multiplayer, RPS vs AI, Four in a Row vs
 * AI — a player choosing the AI opponent is still playing that game. The
 * tutorial's RPS match is a real player playing a real game, so it counts too.
 *
 * `precision-test` is deliberately ABSENT: it is a developer harness route,
 * not a shipped game surface, and counting it would fake traffic. Presence
 * helpers return false for it, so nothing is ever sent for that page.
 */
export const GAME_LABEL_TO_GAME_ID = {
  // ── lobby playsKey / gameLabel values ──────────────────────────────
  roulette: "roulette",
  blackjack: "blackjack",
  "mines-duel": "mines-pvp",
  "memory-grid": "memory-grid",
  "plinko-duel": "plinko",
  poker: "poker",
  "crash-arena": "crash",
  chess: "chess",
  keno: "keno",
  "uno-multiplayer": "uno",
  "rock-paper-scissors": "rps",
  "tower-arena": "tower-arena",
  "four-in-a-row": "four-in-a-row",
  "lane-rush-duel": "lane-runner",
  "pool-masters": "pool-masters",
  "hex-duel": "hex-duel",
  "dice-flush": "yahtzee",
  odds: "odds",
  precision: "precision",
  "dots-and-boxes": "dots-and-boxes",

  // ── alternate labels on the same game (AI / other play surface) ────
  "chess-ai": "chess",
  "four-in-a-row-ai": "four-in-a-row",
  "neon-flush": "uno",
  "rock-paper-scissors-ai": "rps",
};

/** Every label that may be reported (sorted, for tests/docs readability). */
export const PRESENCE_GAME_LABELS = Object.keys(GAME_LABEL_TO_GAME_ID).sort();

/**
 * Resolve any accepted identifier to a canonical game id.
 *
 * Accepts either a gameLabel ("mines-duel") or a canonical id ("mines-pvp") so
 * server-side callers and future clients can both work in one space. Returns
 * null for anything unknown — the caller decides whether that is a 400.
 */
export function resolveGameId(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  // hasOwnProperty, not a truthiness check: "constructor", "__proto__" and
  // friends are inherited object properties, and returning one of those would
  // hand a function to the insert instead of a game id.
  if (Object.prototype.hasOwnProperty.call(GAME_LABEL_TO_GAME_ID, key)) {
    return GAME_LABEL_TO_GAME_ID[key];
  }
  if (PRESENCE_GAME_IDS.includes(key)) return key;
  return null;
}

/** True when this label/id may be reported. Client-side gate, so a page the
 *  server would reject simply never sends a heartbeat. */
export function isPresenceGame(value) {
  return resolveGameId(value) !== null;
}

/** True for a canonical game id (what is actually stored in game_key). */
export function isCanonicalGameId(value) {
  return typeof value === "string" && PRESENCE_GAME_IDS.includes(value);
}

/**
 * The instant before which a row is stale: everything with
 * `last_seen_at <= presenceCutoff(now)` is NOT playing.
 *
 * Computed in JS (and passed to SQL as a parameter) rather than as
 * `NOW() - INTERVAL`, so the expiration rule is a pure function the tests can
 * exercise directly instead of a predicate hidden inside a query string.
 * Index-friendly either way: the comparison is a plain range scan on
 * (game_key, last_seen_at).
 */
export function presenceCutoff(now = Date.now()) {
  return new Date(now - ACTIVE_PLAYER_WINDOW_SECONDS * 1000);
}

/** True while a heartbeat timestamp is still inside the activity window. */
export function isPresenceActive(lastSeenAt, now = Date.now()) {
  if (!lastSeenAt) return false;
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return seen > presenceCutoff(now).getTime();
}

/**
 * Turn aggregate rows ({ gameId, players }) into the response's counts object.
 *
 * Pure, so "grouped correctly by game", "zero is never reported" and "only
 * real games are surfaced" are unit-tested rules rather than a side effect of
 * a SQL query. Defensive on purpose: rows come from the database, but a legacy
 * or manually inserted key must never reach the lobby, and a game nobody is
 * playing must be ABSENT (the UI hides zeroes rather than printing them).
 *
 * Duplicate rows for one game are summed — COUNT(*) GROUP BY already prevents
 * that, so this only makes the function total.
 *
 * @param {{ gameId?: unknown, players?: unknown }[] | null | undefined} rows
 *   rows as returned by the aggregate query (`{ gameId, players }`)
 * @returns {Record<string, number>} counts keyed by canonical game id
 */
export function toActivePlayerCounts(rows) {
  const counts = {};
  for (const row of rows ?? []) {
    const gameId = row?.gameId;
    if (!isCanonicalGameId(gameId)) continue;
    const players = Number(row?.players);
    if (!Number.isFinite(players) || players <= 0) continue;
    counts[gameId] = (counts[gameId] ?? 0) + Math.trunc(players);
  }
  return counts;
}

// ── Lobby badge presentation ──────────────────────────────────────────────
//
// The lobby card's "N playing" line renders three states — nobody, playing,
// hot. Both rules below are pure so the badge is a tested contract rather than
// a condition buried in JSX (the same reason toActivePlayerCounts() exists).

/**
 * The count at which the badge switches from the ordinary "playing" dot to the
 * "hot" treatment (🔥). 50 is well above what a handful of concurrent duels
 * produce, so the hot state stays meaningful instead of decorating an empty
 * lobby on day one.
 */
export const HOT_PLAYER_THRESHOLD = 50;

/**
 * Which badge a count earns: "none" (nobody is playing this game),
 * "playing" (1 … HOT_PLAYER_THRESHOLD - 1) or "hot" (HOT_PLAYER_THRESHOLD+).
 *
 * Missing, negative and non-numeric counts are "none" — a lobby badge must
 * never invent a player. The COUNT IS NOT FORMATTED HERE: the caller renders
 * the number, because "none" is the only state that replaces the number with
 * words ("No players right now").
 */
export function activePlayerTier(count) {
  const players = Number(count);
  if (!Number.isFinite(players) || players <= 0) return "none";
  return players >= HOT_PLAYER_THRESHOLD ? "hot" : "playing";
}

/**
 * A count as the lobby prints it: localized thousands separators, never a
 * negative or fractional number, and a plain "0" rather than a throw when the
 * locale is missing or unknown (Intl rejects a malformed tag).
 */
export function formatPlayerCount(count, locale = "en") {
  const players = Number(count);
  const safe = Number.isFinite(players) && players > 0 ? Math.trunc(players) : 0;
  try {
    return safe.toLocaleString(locale || "en");
  } catch {
    return String(safe);
  }
}

/** Normalize a client-supplied session id: trimmed, capped, or null. */
export function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PRESENCE_SESSION_MAX_LENGTH);
}
