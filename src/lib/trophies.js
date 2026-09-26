// src/lib/trophies.js
//
// PURE TROPHY MATH — no database, no I/O.
//
// Every trophy number that can ever move a player's trophy count is produced
// here so the rule lives in exactly one place and is trivially unit-testable
// (`tests/trophy-system.test.mjs`). The server-authoritative caller is
// src/lib/trophyStore.js, which owns the transactional read → compute → write
// flow; this module only answers "given this player's trophies and this
// outcome, what is the new count?".
//
// THE RULE (Phase 1 of the trophy system):
//
//   Ranked win  = +30 trophies
//   Ranked loss = −30 trophies
//   Draw        =   0 trophies
//
//   * Trophies are PER GAME and INDEPENDENT — a Chess count and a Precision
//     count are separate rows and are never combined.
//   * The count can never fall below TROPHY_MIN (0).
//   * The count is capped at TROPHY_MAX (10,000). Reaching the cap completes
//     trophy progression for that game; Elo then becomes the primary signal.
//   * Trophies are the primary visible competitive progression and the primary
//     matchmaking signal below the cap.
//
// WHAT IS DELIBERATELY ABSENT
//   Nothing about tokens, winnings, XP, Battle Pass, streaks, cosmetics or
//   membership may influence a trophy change. The only inputs are the player's
//   current trophies and the authoritative outcome. Trophies are a result
//   measure, never an economy.
//
// GAME ELIGIBILITY
//   Trophies use EXACTLY the Elo registry (`RATED_GAMES` in src/lib/rating.js)
//   as their single source of truth, so the two systems can never disagree
//   about which games are competitive and server-authoritative. There is
//   deliberately no second game list here that could drift.
//
// PRESTIGE (derived, never stored)
//   Prestige is the endgame representation of Elo progress once a game's
//   trophies reach the cap: `prestige = max(0, elo − STARTING_RATING)`. It is a
//   pure read of the existing Elo value — no column, no writer, no history —
//   so it cannot duplicate or move a rating.

import { STARTING_RATING } from "./elo";
import {
  RATED_GAMES,
  RATING_GAME_LABELS,
  getRatingGameLabel,
  isRatedGame,
  normalizeRatingGameKey,
} from "./rating";

// ── Configurable constants ────────────────────────────────────────────────
//
// These are the ONLY tunables in the trophy system. Change them here; never
// hardcode a trophy value anywhere else.

/** Trophies a player starts with in every game (rows are created lazily). */
export const TROPHY_START = 0;

/** Trophies awarded for a ranked win. */
export const TROPHY_WIN = 30;

/** Trophies removed for a ranked loss (a negative number). */
export const TROPHY_LOSS = -30;

/** Trophies moved by a draw — deliberately zero. */
export const TROPHY_DRAW = 0;

/** Floor: a trophy count can never go below this. */
export const TROPHY_MIN = 0;

/**
 * Cap: the maximum trophy progression for one game. At the cap, trophy
 * progression is complete for that game and Elo becomes the primary
 * matchmaking/endgame signal.
 */
export const TROPHY_MAX = 10000;

/**
 * The eligible games — EXACTLY the Elo registry, re-exported so every trophy
 * surface reads one list and cannot drift from the rating system.
 */
export const TROPHY_GAMES = RATED_GAMES;

/** Display labels, shared with the rating boards. */
export const TROPHY_GAME_LABELS = RATING_GAME_LABELS;

/** True when a game key is eligible for trophies (i.e. is a rated game). */
export function isTrophyGame(gameKey) {
  return isRatedGame(gameKey);
}

/** Coerce a ?game= value to a trophy game key (defaults to the first). */
export function normalizeTrophyGameKey(value) {
  return normalizeRatingGameKey(value);
}

/** Display label for a trophy game key. */
export function getTrophyGameLabel(gameKey) {
  return getRatingGameLabel(gameKey);
}

/** The three valid outcome tokens. Anything else is rejected. */
export const TROPHY_OUTCOMES = Object.freeze(["win", "loss", "draw"]);

/** True when the outcome token is one of win/loss/draw. */
export function isValidTrophyOutcome(outcome) {
  return TROPHY_OUTCOMES.includes(outcome);
}

// ── Small numeric helpers ──────────────────────────────────────────────────

/** Coerce anything to a finite integer, falling back when unusable. */
function toFiniteInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Clamp a trophy count into the legal band [TROPHY_MIN, TROPHY_MAX].
 * Non-finite input falls back to TROPHY_START (never NaN).
 */
export function clampTrophies(value) {
  const n = toFiniteInt(value, TROPHY_START);
  return Math.min(TROPHY_MAX, Math.max(TROPHY_MIN, n));
}

// ── The rule ───────────────────────────────────────────────────────────────

/**
 * The trophy delta for one authoritative outcome, from that player's point of
 * view. A draw moves nothing; an unknown outcome is a defensive no-op (callers
 * validate before reaching here).
 */
export function trophyDeltaForOutcome(outcome) {
  if (outcome === "win") return TROPHY_WIN;
  if (outcome === "loss") return TROPHY_LOSS;
  if (outcome === "draw") return TROPHY_DRAW;
  return 0;
}

/**
 * Apply one outcome to a player's current trophy count.
 *
 * Returns the pre/post count and the delta ACTUALLY applied — which differs
 * from the nominal ±30 at the bounds (a loss at 0 applies 0; a win at the cap
 * applies 0). `clamped` flags that the nominal delta was cut short.
 *
 * @param {number} current
 * @param {"win"|"loss"|"draw"} outcome
 * @returns {{ before: number, delta: number, after: number, nominalDelta: number, clamped: boolean }}
 */
export function applyTrophyDelta(current, outcome) {
  const before = clampTrophies(current);
  const nominalDelta = trophyDeltaForOutcome(outcome);
  const after = clampTrophies(before + nominalDelta);
  return {
    before,
    after,
    delta: after - before,
    nominalDelta,
    clamped: after - before !== nominalDelta,
  };
}

/**
 * Compute the full trophy result of one two-player ranked match.
 *
 * `result` is `"win"` when the `winner` seat genuinely won, or `"draw"` when
 * the game ended level (neither side moves). In a draw there is no winner/loser
 * distinction beyond seating, so pass either player as `winner`.
 *
 * This is the single function the trophy writer calls. Nothing about tokens,
 * wagers, XP or cosmetics can reach it.
 *
 * @param {object} params
 * @param {number} params.winnerTrophies   winner's (or seat-A's) current count
 * @param {number} params.loserTrophies    loser's (or seat-B's) current count
 * @param {"win"|"draw"} [params.result]   "win" (default) or "draw"
 * @returns {{
 *   result: "win"|"draw",
 *   winner: { before: number, delta: number, after: number, nominalDelta: number, clamped: boolean },
 *   loser:  { before: number, delta: number, after: number, nominalDelta: number, clamped: boolean },
 * }}
 */
export function computeMatchTrophies({
  winnerTrophies,
  loserTrophies,
  result = "win",
}) {
  const isDraw = result === "draw";
  return {
    result: isDraw ? "draw" : "win",
    winner: applyTrophyDelta(winnerTrophies, isDraw ? "draw" : "win"),
    loser: applyTrophyDelta(loserTrophies, isDraw ? "draw" : "loss"),
  };
}

// ── Progression phase + Prestige (derived) ────────────────────────────────

/** True once a game's trophy progression is complete (at the cap). */
export function isTrophyComplete(trophies) {
  return clampTrophies(trophies) >= TROPHY_MAX;
}

/**
 * The player's competitive phase for one game:
 *   * "trophies" — below the cap; trophies are the primary progression and the
 *      primary matchmaking signal.
 *   * "elo"      — at the cap; Elo (and its derived Prestige) take over.
 */
export function trophyPhase(trophies) {
  return isTrophyComplete(trophies) ? "elo" : "trophies";
}

/**
 * Prestige for one game — a PURE, derived view of Elo progress after the
 * trophy cap. It is NOT a rating: it is never stored, never written, and never
 * fed back into the Elo calculation. `prestige = max(0, elo − 1000)`.
 *
 * Returns 0 for a non-finite rating. This is a display helper only; it does
 * not gate on trophies (callers show it only once the game is complete).
 */
export function prestigeFromRating(rating) {
  const value = toFiniteInt(rating, STARTING_RATING);
  return Math.max(0, value - STARTING_RATING);
}

/**
 * The full read shape for one game's trophy progress, used by APIs and UI.
 *
 * @param {number} trophies
 * @returns {{
 *   trophies: number,
 *   maxTrophies: number,
 *   remaining: number,
 *   progressPercent: number,
 *   complete: boolean,
 *   phase: "trophies"|"elo",
 * }}
 */
export function trophyProgress(trophies) {
  const value = clampTrophies(trophies);
  const complete = value >= TROPHY_MAX;
  return {
    trophies: value,
    maxTrophies: TROPHY_MAX,
    remaining: Math.max(0, TROPHY_MAX - value),
    progressPercent: Math.round((value / TROPHY_MAX) * 100),
    complete,
    phase: complete ? "elo" : "trophies",
  };
}

/**
 * Normalize a raw `player_trophies` row into the shape every surface uses.
 * `gameKey` is always the game the row belongs to; the derived Prestige and
 * progress fields come from this game's own numbers, never a combination.
 *
 * @param {string} gameKey
 * @param {object} row raw row (snake_case or camelCase aliases both accepted)
 */
export function toTrophyShape(gameKey, row) {
  const trophies = clampTrophies(row.trophies);
  const decided = Number(row.wins ?? 0) + Number(row.losses ?? 0);
  return {
    gameKey: String(gameKey),
    label: getTrophyGameLabel(String(gameKey)),
    trophies,
    peakTrophies: clampTrophies(row.peakTrophies ?? row.peak_trophies ?? trophies),
    gamesRated: Number(row.gamesRated ?? row.games_rated ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    draws: Number(row.draws ?? 0),
    winRate:
      decided > 0
        ? Math.round(((Number(row.wins ?? 0) / decided) * 10000)) / 100
        : 0,
    games: decided,
    lastDelta: Number(row.lastDelta ?? row.last_delta ?? 0),
    lastTrophyAt: row.lastTrophyAt ?? row.last_trophy_at ?? null,
    ...trophyProgress(trophies),
  };
}

// ── Overall Trophies (cross-game aggregate, read-only) ────────────────────
//
// Overall Trophies is NOT a trophy count of its own. Like Overall Elo it has
// no row, no writer and no history — it is the SUM of a player's per-game
// trophy counts, computed on read from the same `player_trophies` rows the
// per-game boards rank. A player needs OVERALL_TROPHY_MIN_GAMES played games
// before an Overall Trophies value exists at all, so a one-game specialist
// cannot top the cross-game board.

/** Title of the aggregate cross-game trophy board. */
export const OVERALL_TROPHIES_LABEL = "Overall Trophies";

/**
 * How many different GAMES (played at least once) a player needs before an
 * Overall Trophies value exists. Mirrors OVERALL_MIN_GAMES for Elo.
 */
export const OVERALL_TROPHY_MIN_GAMES = 3;

/**
 * The Overall Trophies for a player, from their per-game trophy entries.
 *
 * A game counts only once the player has completed a ranked match in it
 * (`gamesRated >= 1`); an unplayed game contributes nothing and cannot help
 * a player qualify. The value is the plain SUM of those per-game counts.
 *
 * @param {Array<{ trophies?: number, gamesRated?: number }>} entries
 * @returns {{
 *   overallTrophies: number|null,
 *   gamesPlayed: number,
 *   eligible: boolean,
 * }}
 */
export function overallTrophiesFromCounts(entries) {
  const played = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!entry) return false;
    return Number(entry.gamesRated ?? entry.games_rated ?? 0) > 0;
  });
  if (played.length < OVERALL_TROPHY_MIN_GAMES) {
    return { overallTrophies: null, gamesPlayed: played.length, eligible: false };
  }
  const total = played.reduce(
    (sum, entry) => sum + clampTrophies(entry.trophies),
    0,
  );
  return { overallTrophies: total, gamesPlayed: played.length, eligible: true };
}

/**
 * Config snapshot — exposed so tests can assert the tunables without
 * re-deriving them, and so a future admin surface has one object to read.
 */
export const TROPHY_CONFIG = Object.freeze({
  start: TROPHY_START,
  win: TROPHY_WIN,
  loss: TROPHY_LOSS,
  draw: TROPHY_DRAW,
  min: TROPHY_MIN,
  max: TROPHY_MAX,
  outcomes: TROPHY_OUTCOMES,
  overallMinGames: OVERALL_TROPHY_MIN_GAMES,
});
