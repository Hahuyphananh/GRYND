// src/lib/tic-tac-toe/constants.ts
//
// Single source of truth for Tic-Tac-Toe Duel. The pure engine, the server
// store and the renderer all import from here so there is exactly one place to
// change a value.
//
// There is deliberately NO tuning block: tic-tac-toe has no physics, no
// difficulty curve and no randomness, so unlike `src/lib/mini-golf/constants.ts`
// this file holds only the board geometry, the win lines and the shared
// platform vocabulary.

import type { Seat } from "./types";

// ──────────────────────────────────────────────────────────────────────────
// Board
// ──────────────────────────────────────────────────────────────────────────

/** 3x3. The board is stored row-major, so this is both the side and the root. */
export const BOARD_SIZE = 3;

/** Nine playable cells. */
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/**
 * The eight winning lines, as board indices (row-major).
 *
 * Three horizontal rows, three vertical columns, two diagonals. Frozen and
 * enumerated explicitly rather than generated, so a reader can verify at a
 * glance that all eight — and only those eight — are covered.
 */
export const WINNING_LINES = Object.freeze([
  // rows
  Object.freeze([0, 1, 2]),
  Object.freeze([3, 4, 5]),
  Object.freeze([6, 7, 8]),
  // columns
  Object.freeze([0, 3, 6]),
  Object.freeze([1, 4, 7]),
  Object.freeze([2, 5, 8]),
  // diagonals
  Object.freeze([0, 4, 8]),
  Object.freeze([2, 4, 6]),
]);

/** The mark each seat plays. player1 is X and therefore moves first. */
export const MARKS: Readonly<Record<Seat, string>> = Object.freeze({
  player1: "X",
  player2: "O",
});

/** The seat that moves first (X). */
export const FIRST_SEAT: Seat = "player1";

// ──────────────────────────────────────────────────────────────────────────
// Mega Tic-Tac-Toe — the expansion stages
// ──────────────────────────────────────────────────────────────────────────
//
// A Mega match grows through three stages. Stage 1 is one ordinary 3x3 board; a
// DRAW on it expands the match to stage 2 (four boards) and, when stage 2 fully
// resolves with no Mega line, to stage 3 (nine boards — the maximum, there is
// deliberately no stage 4).
//
// Boards live on a FIXED 3x3 lattice of slots (indices 0..8, row-major), so an
// expansion only ever MATERIALISES empty slots — it never moves a board and
// never re-indexes one. That is what lets every earlier board keep its exact
// state, and it makes the Mega win-lines one fixed list instead of one list per
// stage.
//
//   stage 1 — slot 0            (the lattice's top-left corner)
//   stage 2 — slots 0, 1, 3, 4  (the lattice's top-left 2x2 block)
//   stage 3 — slots 0..8        (the whole 3x3 lattice)
//
// A Mega line needs THREE collinear controlled boards, so stage 2 — with only
// four slots — can never complete one. Stage 2 therefore always expands to
// stage 3 once all four of its boards have resolved.

/** Side of the board lattice at full expansion. */
export const MEGA_SIZE = 3;

/** Nine slots is the hard maximum — there is no fourth stage. */
export const MAX_BOARDS = MEGA_SIZE * MEGA_SIZE;

/** The highest reachable stage. */
export const MAX_MEGA_STAGE = 3;

/**
 * The slot indices in play at each stage. Membership only grows, and the
 * original Round-1 board always keeps slot 0.
 */
export const STAGE_BOARD_SLOTS: Readonly<Record<1 | 2 | 3, readonly number[]>> = Object.freeze({
  1: Object.freeze([0]),
  2: Object.freeze([0, 1, 3, 4]),
  3: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]),
});

/**
 * The eight Mega lines (three collinear SLOTS), over the 3x3 lattice.
 *
 * Deliberately the same shape as `WINNING_LINES`: a line is only live when all
 * of its slots exist in the current stage (see `megaLinesForStage` in rules.ts).
 */
export const MEGA_WINNING_LINES: readonly (readonly number[])[] = Object.freeze([
  // rows
  Object.freeze([0, 1, 2]),
  Object.freeze([3, 4, 5]),
  Object.freeze([6, 7, 8]),
  // columns
  Object.freeze([0, 3, 6]),
  Object.freeze([1, 4, 7]),
  Object.freeze([2, 5, 8]),
  // diagonals
  Object.freeze([0, 4, 8]),
  Object.freeze([2, 4, 6]),
]);

/**
 * Sentinel `boardIndex` addressing the CURRENT sudden-death board.
 *
 * Sudden death only exists after the stage-3 tiebreaker is itself a tie; it is
 * played on a fresh ordinary 3x3 board that lives outside the slot lattice, so
 * it needs an address that can never collide with a real slot (0..8).
 */
export const SUDDEN_DEATH_BOARD_INDEX = -1;

// ──────────────────────────────────────────────────────────────────────────
// Match status
// ──────────────────────────────────────────────────────────────────────────
//
// Mirrors the shape used by the other PvP games (ready → playing → terminal)
// so the shared lobby/queue/retention conventions carry over unchanged.
//
// `READY` is part of the vocabulary but never entered: joining takes the match
// straight to `playing`, because tic-tac-toe has no ready-banner or countdown
// (there is no timers requirement, and the first move is available immediately).

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

/**
 * Advisory-lock namespace for the Tic-Tac-Toe matchmaking lock (the ASCII
 * bytes "TICT"). Scoped per-game so a Tic-Tac-Toe transaction can never contend
 * with another game's lobby lock.
 */
export const TIC_TAC_TOE_LOCK_NAMESPACE = 0x54494354; // "TICT"

/**
 * Result vocabulary persisted in `tic_tac_toe_matches.result`. `player1` /
 * `player2` mirror the seat names; `tie` is the nine-move draw.
 */
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  TIE: "tie",
});

/**
 * Stable internal identity for a free human-vs-AI match.
 *
 * Unused while no practice bot ships (see the store's `createAiMatch` note),
 * but declared alongside the shared vocabulary so a future bot needs no
 * constant to be invented — mirroring MINI_GOLF_AI_PLAYER_ID.
 */
export const TIC_TAC_TOE_AI_PLAYER_ID = "tic_tac_toe_ai_bot";
