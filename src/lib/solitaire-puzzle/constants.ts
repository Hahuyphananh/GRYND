// src/lib/solitaire-puzzle/constants.ts
//
// The frozen vocabulary for competitive / AI puzzle sessions. This module is
// deliberately dependency-free so both the server store and any future client
// can name the same states without importing engine data.

export const PUZZLE_SESSION_FORMAT = "puzzle-race-v1" as const;

/**
 * The endless battle format. A session stamped with this format keeps growing
 * its frozen puzzle stream as seats advance, so the match ends on lives, never
 * because a five-puzzle set ran out.
 */
export const PUZZLE_BATTLE_FORMAT = "puzzle-battle-v1" as const;

/** A ranked race's opening set: five puzzles, one per difficulty band. */
export const PUZZLE_SESSION_PUZZLE_COUNT = 5;

/** Three lives per seat. A bad move or a blown puzzle clock costs one. */
export const PUZZLE_SESSION_LIVES = 3;

/** Each puzzle carries its own 60-second clock, reset on a new puzzle. */
export const PUZZLE_SESSION_PUZZLE_MS = 60 * 1000;

/**
 * Absolute safety cap for an abandoned match. Lives decide a live battle; this
 * only stops a row nobody is polling from staying open forever.
 */
export const PUZZLE_SESSION_DEADLINE_MS = 30 * 60 * 1000;

/** Practice sessions are untimed; this is only a cleanup baseline. */
export const PUZZLE_SESSION_AI_INACTIVITY_MS = 20 * 60 * 1000;

/** Stable synthetic seat id for the AI practice opponent. Never authenticates. */
export const SOLITAIRE_PUZZLE_AI_PLAYER_ID = "solitaire_puzzle_ai_bot";

// ── Puzzle Ranked (human vs human) ────────────────────────────────────────

/**
 * The canonical rated game key for Puzzle Ranked.
 *
 * DELIBERATELY NOT `solitaire-duel`: Puzzle Ranked keeps its OWN Elo row, its
 * own trophy row and its own leaderboard, so a puzzle result can never move (or
 * be read as) a normal Solitaire Ranked statistic. The key must be registered
 * in `RATED_GAMES` (src/lib/rating.js) for the shared writers to accept it —
 * that registry IS the trophy registry, so the two can never disagree.
 */
export const PUZZLE_RANKED_GAME_KEY = "solitaire-puzzle" as const;

/** Display name used by the rated-game registries and result surfaces. */
export const PUZZLE_RANKED_DISPLAY_NAME = "Puzzle Ranked" as const;

/**
 * `pg_advisory_xact_lock` namespace for Puzzle Ranked matchmaking.
 *
 * A NAMESPACE OF ITS OWN: a puzzle search can never take the Solitaire Duel
 * lock or pair into a duel lobby. ASCII "PZLE" masked positive.
 */
export const PUZZLE_RANKED_LOCK_NAMESPACE = 0x505a4c45 & 0x7fffffff;

/**
 * How long a waiting search stays joinable.
 *
 * A closed tab leaves an honest `waiting` row behind; past this window it is no
 * longer offered to a joiner (and is cancelled on the next read), so nobody is
 * ever paired with an absent player. The wait itself is never faked: there is
 * NO ghost/bot fallback in a human ranked mode.
 */
export const PUZZLE_RANKED_QUEUE_TTL_MS = 5 * 60 * 1000;

export const PUZZLE_SESSION_MODE = Object.freeze({
  RANKED: "ranked",
  AI: "ai",
} as const);

export type PuzzleSessionMode =
  (typeof PUZZLE_SESSION_MODE)[keyof typeof PUZZLE_SESSION_MODE];

export const PUZZLE_SESSION_STATUS = Object.freeze({
  WAITING: "waiting",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
} as const);

export type PuzzleSessionStatus =
  (typeof PUZZLE_SESSION_STATUS)[keyof typeof PUZZLE_SESSION_STATUS];

export const PUZZLE_SESSION_SEAT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
} as const);

export type PuzzleSessionSeat =
  (typeof PUZZLE_SESSION_SEAT)[keyof typeof PUZZLE_SESSION_SEAT];

export const PUZZLE_SESSION_RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
} as const);

export type PuzzleSessionResult =
  (typeof PUZZLE_SESSION_RESULT)[keyof typeof PUZZLE_SESSION_RESULT];

export const PUZZLE_SESSION_REASON = Object.freeze({
  FINISH: "finish",
  DEADLINE: "deadline",
  FORFEIT: "forfeit",
  DRAW: "draw",
  /** One seat lost its third life to a bad move or a blown puzzle clock. */
  LIVES: "lives",
} as const);

export type PuzzleSessionReason =
  (typeof PUZZLE_SESSION_REASON)[keyof typeof PUZZLE_SESSION_REASON];

/** Terminal states never accept another move. */
export const PUZZLE_SESSION_TERMINAL_STATUSES: readonly PuzzleSessionStatus[] =
  Object.freeze([
    PUZZLE_SESSION_STATUS.FINISHED,
    PUZZLE_SESSION_STATUS.CANCELLED,
  ]);
