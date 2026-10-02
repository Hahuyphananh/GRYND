// src/lib/sudoku-duel/constants.ts
//
// The single source of truth for the Sudoku Duel puzzle engine. The pure rules
// (`./rules.ts`), the deterministic generator (`./generator.ts`) and the future
// authoritative store all import from here, so there is exactly one place to
// change a value.
//
// WHAT THIS GAME IS (the contract this engine serves):
//   * 1v1, simultaneous, both seats solve the EXACT SAME puzzle, generated once
//     by the SERVER from one committed seed
//   * standard 9x9 Sudoku — fill every row, column and 3x3 box with 1..9
//   * the first seat to fill its board correctly wins immediately; if neither
//     finishes before the match limit, the greater VERIFIED progress wins
//   * NO wagers, NO tokens, NO balances, NO payouts — a purely skill-based duel
//
// This module is deliberately free of any match lifecycle vocabulary (no
// statuses, no timers, no seeds-from-crypto): those belong to the store and the
// seed system, which are a later step. Only the puzzle's geometry, vocabulary
// and difficulty tuning live here.

/**
 * The frozen ruleset for a puzzle. Part of a puzzle's identity, so a future
 * rules change can never silently reinterpret a puzzle generated under an older
 * variant.
 */
export const VARIANT = "classic-9" as const;

/**
 * The variant's version, and part of the puzzle digest.
 *
 * Bumping it changes every puzzle derived from the same server seed, so old
 * matches stay reproducible and interpretable.
 */
export const VARIANT_VERSION = 1;

/** 9x9. */
export const SIZE = 9;

/** 3x3 boxes. */
export const BOX = 3;

/** 81 cells. Grids are stored row-major, so this is also the index bound. */
export const CELL_COUNT = SIZE * SIZE;

/** An empty cell. `0` is never a legal placed value (values are 1..9). */
export const EMPTY = 0;

/** Legal cell values, inclusive. */
export const MIN_VALUE = 1;
export const MAX_VALUE = 9;

/** Every legal placed value, ascending — for enumeration in tests/UI. */
export const VALUES: readonly number[] = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9,
]);

/**
 * How many clues (givens) the generator aims for, per difficulty.
 *
 * Lower = fewer clues = harder. These are TARGETS, not guarantees: the
 * generator only ever removes a clue while the puzzle keeps exactly one
 * solution, so a puzzle can legitimately end up with a few more clues than its
 * target (never fewer). See `carvePuzzle` in ./generator.ts.
 */
export const GIVENS_BY_DIFFICULTY = Object.freeze({
  easy: 46,
  normal: 34,
  hard: 26,
});

/**
 * The GAVIN minimum: no 9x9 Sudoku can have a unique solution with fewer than
 * 17 clues. Used as a hard floor so a difficulty target can never be set to an
 * impossible value.
 */
export const MIN_GIVENS = 17;

/**
 * Canonical difficulty tiers, weakest → strongest, exactly as the rest of the
 * platform spells them (see `src/lib/aiDifficulty.ts`). Sudoku difficulty here
 * describes the PUZZLE, not an opponent.
 */
export const DIFFICULTIES: readonly string[] = Object.freeze([
  "easy",
  "normal",
  "hard",
]);

/** What a puzzle defaults to when nothing was chosen. */
export const DEFAULT_DIFFICULTY = "normal" as const;

/**
 * Rejection codes. Business codes are the contract the routes will surface, so
 * they are stable strings rather than bare integers.
 */
export const ACTION_CODES = Object.freeze({
  /** The envelope is not even an action object. */
  BAD_ACTION: "BAD_ACTION",
  /** The cell index or the value is out of range / not an integer. */
  OUT_OF_RANGE: "OUT_OF_RANGE",
  /** The target cell is a fixed clue and can never be edited. */
  GIVEN_CELL: "GIVEN_CELL",
  /** The placement would break a row/column/box constraint on the VISIBLE board. */
  CONFLICT: "CONFLICT",
  /** The cell already holds its correct value — nothing to do. */
  ALREADY_PLACED: "ALREADY_PLACED",
  /** A `clear` of an already-empty cell — nothing to do. */
  NOTHING_TO_CLEAR: "NOTHING_TO_CLEAR",
});

// ─────────────────────────────────────────────────────────────────────────────
// Match lifecycle — the shared house vocabulary
// ─────────────────────────────────────────────────────────────────────────────
//
// Sudoku Duel is 1v1 and SIMULTANEOUS: both seats solve the exact same server
// puzzle from their own independent board, and the first to fill it correctly
// (by adjusted competitive time) wins. More than any other duel, the seam here
// is "the client may only name a cell and a value": the solution, the correct
// count, the mistakes, the penalty, the completion instant, the winner and the
// settlement are all derived by the server from its own state.

/** The canonical game key, shared by every registry the platform keeps. */
export const GAME_KEY = "sudoku-duel" as const;

/** Display name, exactly as the lobby and the rating boards render it. */
export const GAME_DISPLAY_NAME = "Sudoku Duel" as const;

/** `/casino/*` is the app route; `/games/*` is its canonical 308 alias. */
export const GAME_ROUTE = "/casino/sudoku-duel" as const;

/**
 * `pg_advisory_xact_lock` namespace for matchmaking.
 *
 * Per-game, so "find an open lobby, else open one" is atomic under one lock and
 * two concurrent callers can never each create a row. Taken inside the
 * matchmaking transaction only (xact-scoped), so no lock survives a request.
 * ASCII "SUDU" masked positive, matching every other PvP store.
 */
export const SUDOKU_DUEL_LOCK_NAMESPACE = 0x53554455 & 0x7fffffff;

/** Seats in a Sudoku Duel match. Strictly 1v1 — there is no other format. */
export const SEAT_COUNT = 2;

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  /**
   * Part of the shared vocabulary but never entered: joining takes the match
   * straight to `playing`, with a countdown window before the first legal move.
   */
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

/** Terminal statuses — nothing settles or transitions out of these. */
export const TERMINAL_STATUSES: readonly string[] = Object.freeze([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

/** The only terminal outcomes a settled match can carry. */
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

/** The two seats, as the store keys them (player1 is the host). */
export const SEAT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
});

/**
 * Stable internal identity for the free human-vs-AI practice seat.
 *
 * It occupies `player2` of an `is_ai` row exactly as a real joiner would, so
 * every seat-based read (the per-seat board, the move log, the race facts)
 * works unchanged — no token ever authenticates as this id, and the row is
 * excluded from rating/trophies. Mirrors SOLITAIRE_DUEL_AI_PLAYER_ID.
 */
export const SUDOKU_DUEL_AI_PLAYER_ID = "sudoku_duel_ai_bot";

/** How the server ended the match. Persisted in `resolution_reason`. */
export const RESOLUTION = Object.freeze({
  /** A seat filled the final required cell correctly. */
  FINISH: "finish",
  /** A seat left, conceded, disconnected or went inactive. */
  FORFEIT: "forfeit",
  /** The race ended level. */
  DRAW: "draw",
});

export const RESOLUTION_REASONS: readonly string[] = Object.freeze([
  RESOLUTION.FINISH,
  RESOLUTION.FORFEIT,
  RESOLUTION.DRAW,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Timers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The synchronized countdown between "second seat joined" and GO: 3 → 2 → 1 →
 * GO.
 *
 * The GO instant is written to the row as an ABSOLUTE server timestamp
 * (`go_at`), not as a delay each client applies locally, so both seats count to
 * one clock and a slower connection costs nobody anything. NO move is accepted
 * before `go_at`, so the window is pure planning time.
 */
export const READY_COUNTDOWN_MS = 3_000;

/** The countdown is rendered as this many ticks before GO (3, 2, 1). */
export const COUNTDOWN_STEPS = 3;

/**
 * Inactivity alarm: with no accepted action from a seat for this long, that
 * seat's match view raises the "play now or you forfeit" alarm.
 *
 * Measured against the seat's OWN last accepted action (or GO when it has not
 * acted yet), so one player cannot alarm the other. Fifteen minutes.
 */
export const INACTIVITY_ALARM_MS = 900_000;

/**
 * Inactivity forfeit: with no accepted action for this long, the seat forfeits
 * and the opponent wins, with the standard settlement.
 *
 * The match is UNTIMED apart from this — there is no match clock, so a match
 * only ends by a completion, a concession, a long disconnect, or this
 * inactivity rule. Twenty minutes.
 */
export const INACTIVITY_FORFEIT_MS = 1_200_000;

/**
 * When the match clock switches from the UP-counting stopwatch to the forfeit
 * countdown: the last five minutes before the inactivity forfeit.
 *
 * The match is untimed, so the honest readout for almost all of it is elapsed
 * time counting UP; only in the final stretch does the time LEFT matter enough
 * to count down. This equals `INACTIVITY_FORFEIT_MS - INACTIVITY_ALARM_MS`.
 */
export const INACTIVITY_COUNTDOWN_MS = 300_000;

/**
 * The competitive-time penalty for one incorrect placement.
 *
 * A mistake never advances progress, and it is what makes guess-and-check a
 * losing strategy: the winner is decided by ADJUSTED completion time, so each
 * wrong value costs a full second against an opponent who answers carefully.
 */
export const MISTAKE_PENALTY_MS = 1_000;

/**
 * The maximum accepted actions for one seat.
 *
 * A solved board is 81 placements, and honest play adds a handful of mistakes,
 * so this bound is unreachable except by a scripted client trying to turn one
 * match into unbounded row writes. Per seat, so one player's spam can never
 * truncate the other's game.
 */
export const MAX_MOVES_PER_SEAT = 2_000;

/**
 * Minimum spacing between opponent-progress emissions (ms).
 *
 * Progress is broadcast when a correct placement lands, so this only coalesces
 * bursts (a fast solver placing several cells a second). A client that misses an
 * emission is never stale: every snapshot carries the authoritative numbers.
 */
export const PROGRESS_BROADCAST_MIN_MS = 1_000;
