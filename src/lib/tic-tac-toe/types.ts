// src/lib/tic-tac-toe/types.ts
//
// The shared type vocabulary for Mega Tic-Tac-Toe. Deliberately free of imports
// from `./constants` so there is no runtime cycle — `constants.ts` imports the
// `Seat` union from here, exactly as Mini Golf does.
//
// ── THE GAME ──────────────────────────────────────────────────────────────
//
// Mega Tic-Tac-Toe grows a single ordinary 3x3 board into a lattice of boards:
//
//   stage 1  one 3x3 board. A normal line WINS THE MATCH outright; a full-board
//            draw EXPANDS the match to stage 2.
//   stage 2  four boards on the lattice's top-left 2x2. Boards keep playing
//            independently; a Mega line (three collinear controlled boards)
//            wins the match. A 2x2 can never complete a length-3 line, so a
//            fully-resolved stage 2 always EXPANDS to stage 3.
//   stage 3  all nine boards. A Mega line wins the match; if every board
//            resolves with no Mega line, the TIEBREAK decided the match (the
//            board/cell count), or a sudden-death board is played.
//
// Winning ONE small board never ends the match by itself (except in stage 1,
// where that board is the whole match) — it only marks that board as CONTROLLED
// by a mark, which is what the Mega lines read.
//
// All of this is derived by the pure engine in `./rules.ts`; none of it is ever
// accepted from a client.

/** A player's mark. */
export type Mark = "X" | "O";

/** Seat names. Also the suffix of every per-seat field in the match row. */
export type Seat = "player1" | "player2";

/** One cell of a small board: empty, or claimed by a mark. */
export type Cell = Mark | null;

/** The outcome of a match, in the same vocabulary persisted by the schema. */
export type MatchResult = Seat | "tie";

/** Persisted match phase. `playing` accepts a move; `finished` is terminal. */
export type MatchPhase = "playing" | "finished";

/** The expansion stage. 3 is the maximum — there is no stage 4. */
export type MegaStage = 1 | 2 | 3;

/**
 * Who owns a small board.
 *
 *   "active"   — still playable; cells may be claimed
 *   "X" / "O"  — locked: that mark completed a line
 *   "draw"     — locked: the board filled with no line
 *
 * A controlled board is the unit the Mega lines are made of.
 */
export type BoardControl = "active" | "draw" | Mark;

/**
 * One small 3x3 board.
 *
 * `cells` is row-major, length 9. `control` and `winningLine` are DERIVED from
 * `cells` by the engine and stored denormalised so a reader (and the Mega-line
 * check) never has to rescan every cell.
 */
export type SmallBoard = {
  /** Row-major, length 9. Index 0 is the top-left cell. */
  cells: Cell[];
  /** Accepted moves on THIS board (0..9). */
  plies: number;
  /** Who owns this board, or "active" while it can still be played. */
  control: BoardControl;
  /** The three winning cell indices when `control` is X/O, else null. */
  winningLine: number[] | null;
};

/**
 * The most recent accepted move, for the client's highlight + history panel.
 *
 * `boardIndex` is a lattice slot (0..8) — or `SUDDEN_DEATH_BOARD_INDEX` (-1)
 * when the move was played on the sudden-death board. `ply` is the match-wide
 * turn number (0-based across every board).
 */
export type LastMove = {
  seat: Seat;
  boardIndex: number;
  cellIndex: number;
  mark: Mark;
  ply: number;
};

/**
 * The stage-3 tiebreaker, evaluated the moment the last board resolves with no
 * Mega line. Every field is derived server-side from the final boards.
 *
 * `decidedBy` records WHICH rule decided it (the board count, the total cell
 * count, or "it was still tied so sudden death was required"). `winner` is null
 * ONLY for "sudden-death", meaning the match is not over yet.
 */
export type TiebreakSummary = {
  /** Boards the cell count awarded to X (more X cells than O cells). */
  xBoards: number;
  /** Boards the cell count awarded to O. */
  oBoards: number;
  /** Boards with an equal X/O cell count — they count for neither player. */
  neutralBoards: number;
  /** Total X-occupied cells across every board. */
  xCells: number;
  /** Total O-occupied cells across every board. */
  oCells: number;
  decidedBy: "boards" | "cells" | "sudden-death";
  /** The tiebreak winner, or null when sudden death is required. */
  winner: Seat | null;
};

/** The sudden-death sequence: ordinary 3x3 boards played until one is won. */
export type SuddenDeathState = {
  /** Every sudden-death board in order; play continues on the LAST one. */
  boards: SmallBoard[];
};

/**
 * The authoritative match state, stored as `tic_tac_toe_matches.game_state`.
 *
 * Deliberately free of player ids: the seat is the identity the engine reasons
 * about, and the seat→Clerk-id mapping lives in the row's `player1_id` /
 * `player2_id` columns. That keeps this object non-redundant and makes every
 * transition here pure.
 *
 * There is no `seed`: Mega Tic-Tac-Toe contains no randomness, so the boards
 * are a pure function of the move order and need nothing to reproduce them.
 */
export type TicTacToeState = {
  /** Monotonic optimistic-concurrency counter. Incremented on every write. */
  version: number;
  phase: MatchPhase;
  /** 1 | 2 | 3 — which expansion the match is on. Only ever increases. */
  stage: MegaStage;
  /**
   * The lattice, length 9. A `null` slot has NOT been materialised yet (it
   * belongs to a later stage). Slots, once created, never move or reset.
   */
  boards: (SmallBoard | null)[];
  /** Whose turn it is. */
  currentTurn: Seat;
  /** Total accepted moves across every board (0..81). */
  ply: number;
  /** Set only when the match has been decided for a seat. */
  winner: Seat | null;
  /** The three Mega slots that won the match, or null. Drives the highlight. */
  winningBoards: number[] | null;
  /** The stage-3 tiebreak, once it has been evaluated. */
  tiebreak: TiebreakSummary | null;
  /** Set only when the tiebreak was itself tied and sudden death began. */
  suddenDeath: SuddenDeathState | null;
  lastMove: LastMove | null;
};

/** Seat→user id mapping, sourced from the match row. */
export type Seats = { player1Id: string; player2Id: string | null };

/** One accepted move, as persisted in `tic_tac_toe_moves`. */
export type MoveRecord = {
  ply: number;
  playerId: string;
  /** Lattice slot 0..8, or SUDDEN_DEATH_BOARD_INDEX (-1). */
  boardIndex: number;
  /** Cell 0..8 within that board. */
  cellIndex: number;
};
