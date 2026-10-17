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
// Ultimate Tic-Tac-Toe — the nine-board lattice
// ──────────────────────────────────────────────────────────────────────────
//
// An Ultimate match is played on NINE ordinary 3x3 mini-boards, always arranged
// in a fixed 3x3 lattice of slots (indices 0..8, row-major). Unlike the old
// expansion-based match there are no stages: all nine boards exist from move
// one, and nothing is ever materialised later.
//
//   slot 0 1 2
//        3 4 5
//        6 7 8
//
// A mini-board is won by the ordinary three-in-a-line rule; three collinear
// mini-boards owned by the same mark win the whole match.

/** Side of the mini-board lattice. */
export const LATTICE_SIZE = 3;

/** Nine mini-boards: the hard maximum AND the fixed count. */
export const MAX_BOARDS = LATTICE_SIZE * LATTICE_SIZE;

/** Every lattice slot, row-major. Frozen, so no caller can mutate the set. */
export const LATTICE_SLOTS: readonly number[] = Object.freeze(
  Array.from({ length: MAX_BOARDS }, (_, slot) => slot)
);

/**
 * The eight lattice lines (three collinear SLOTS).
 *
 * The same geometry as `WINNING_LINES` — a line is three indices in a 3x3 grid —
 * but over a different space: `WINNING_LINES` reads CELLS inside one mini-board,
 * `LATTICE_LINES` reads BOARDS inside the lattice.
 */
export const LATTICE_LINES: readonly (readonly number[])[] = WINNING_LINES;

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
