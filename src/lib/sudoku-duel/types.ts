// src/lib/sudoku-duel/types.ts
//
// The shared type vocabulary for the Sudoku Duel puzzle engine. Deliberately
// free of imports so there is no runtime cycle — `constants.ts` and the rest of
// the engine import from here.
//
// THREE SHAPES, AND WHY THEY ARE DIFFERENT:
//
//   Grid        — a flat, row-major array of 81 integers. `0` is empty; 1..9 are
//                 the placed values. Index `i` is row `Math.floor(i / 9)`,
//                 column `i % 9`.
//                 Kept flat rather than 9×9 so the authoritative state is a
//                 single immutable value that copies with one `slice()` and
//                 compares with one `every()`.
//
//   SudokuPuzzle — the SERVER's record. It carries the givens AND the
//                 authoritative solution. It is NEVER sent to a client: the
//                 client is told the givens (which it can see anyway) and its own
//                 entries, never the solution it must derive.
//
//   SudokuView  — the client-facing projection. Givens, the viewer's own
//                 entries, the conflicts DEDUCIBLE from the visible board, and
//                 verified progress. No solution, no opponent board.

/** Puzzle difficulty — how many clues the generator aims for. */
export type SudokuDifficulty = "easy" | "normal" | "hard";

/** A placed value (1..9) or `EMPTY` (0). */
export type CellValue = number;

/** A row-major 9x9 board as 81 integers. */
export type Grid = number[];

/** The two seats. Seat ids are row-level (`player1` is the host). */
export type Seat = "player1" | "player2";

/** Why an action was refused. Mirrors `ACTION_CODES` in ./constants.ts. */
export type SudokuActionCode =
  | "BAD_ACTION"
  | "OUT_OF_RANGE"
  | "GIVEN_CELL"
  | "CONFLICT"
  | "ALREADY_PLACED"
  | "NOTHING_TO_CLEAR";

/**
 * The ONLY thing a client may author: a cell to write and the value to write,
 * or a cell to clear. It can never name a grid, a solution, a score, a
 * completion, a winner or a rating.
 */
export type SudokuAction =
  | { kind: "place"; index: number; value: number }
  | { kind: "clear"; index: number };

/**
 * A generated puzzle plus its authoritative solution.
 *
 * `puzzle` and `solution` are two DISTINCT grids: `puzzle` has `0` wherever the
 * clue is hidden, `solution` is the unique completion. The givens are exactly
 * the non-zero cells of `puzzle`, and they always agree with `solution` on those
 * cells.
 */
export type SudokuPuzzle = {
  variant: string;
  variantVersion: number;
  difficulty: SudokuDifficulty;
  /** The unsigned 32-bit seed that generated it, for reproducibility. */
  seed: number;
  /** The clues: non-zero where a clue is shown, 0 where the player must fill. */
  puzzle: Grid;
  /** The unique completion. SERVER-ONLY — never send this to a client. */
  solution: Grid;
  /** How many clues `puzzle` actually carries. */
  givens: number;
};

/** One seat's mutable board. Starts as the puzzle; `ply` counts accepted actions. */
export type SudokuBoardState = {
  grid: Grid;
  ply: number;
};

/**
 * Verified progress, computed ENTIRELY from the server's own grids.
 *
 * `correctEntries` is the competitive metric: the number of NON-given cells the
 * seat has filled correctly. It excludes clues (both seats start level on those)
 * and excludes wrong entries (which never advance the metric).
 */
export type SudokuProgress = {
  /** Every cell matching the solution, including clues. 0..81. */
  correctCells: number;
  /** Non-given cells matching the solution — THE competitive metric. */
  correctEntries: number;
  /** Non-given cells with any value written. */
  filledEntries: number;
  /** Non-given cells filled with a wrong value. */
  incorrectEntries: number;
  /** Non-given cells left empty. */
  emptyEntries: number;
  /** Non-given cells in total (`81 - givens`). */
  totalEntries: number;
  /** `correctEntries / totalEntries`, rounded to a whole percent. */
  progressPercent: number;
  /** True only when every cell equals the solution. */
  completed: boolean;
};

/**
 * The client-facing projection of one seat's board.
 *
 * There is deliberately no `solution` field and no opponent field: hidden
 * information cannot be leaked by forgetting to strip something, because it was
 * never put in the object.
 */
export type SudokuView = {
  variant: string;
  variantVersion: number;
  difficulty: SudokuDifficulty;
  /** The clues (public — the player can see them on their own board). */
  puzzle: Grid;
  /** The viewer's own entries, including the clues at their indices. */
  entries: Grid;
  /** Indices of the viewer's entries that break a row/column/box constraint. */
  conflicts: number[];
  progress: SudokuProgress;
  completed: boolean;
  ply: number;
};

// ── Seats and per-seat authoritative state ────────────────────────────────

export type Seats = { player1Id: string; player2Id: string | null };

/**
 * One seat's authoritative board (server-only, persisted as JSONB).
 *
 * The board holds ONLY the givens and the cells the seat has filled CORRECTLY:
 * an incorrect value is never written (it is counted as a mistake and otherwise
 * discarded), so `grid` is a subset of the solution intersected with the clues.
 * That makes "correctly completed cells" a direct read of the board rather than
 * a recomputation, and means the board the opponent could ever reconstruct
 * (counts only) is never a copyable answer key.
 *
 * The time facts are all SERVER instants, written by the store, never by a
 * client: `completedAtMs` decides a photo finish, and `progressAtMs` is the
 * instant the competitive metric last increased — the deterministic tiebreak at
 * the deadline.
 */
export type SudokuSeatState = {
  /** Givens + correctly placed values; `EMPTY` everywhere else. */
  grid: Grid;
  /** Accepted actions by this seat — the per-seat idempotency cursor. */
  ply: number;
  /** Incorrect placements this seat has made. Monotone. */
  mistakes: number;
  /** Accumulated competitive-time penalty in ms (`mistakes * penalty`). */
  penaltyMs: number;
  /** True once every cell matches the solution. Stamped by the store. */
  completed: boolean;
  /** Server instant the seat completed, or null. */
  completedAtMs: number | null;
  /** Server instant the correct-cell count last increased, or null. */
  progressAtMs: number | null;
};

/**
 * The closed opponent shape.
 *
 * Counts and status only: no grid, no entries, no move list. It is insufficient
 * to reconstruct the opponent's board (and therefore to copy their answers).
 */
export type OpponentProgress = {
  seatKey: Seat;
  /** Correctly completed NON-given cells — the competitive metric. */
  correctCells: number;
  mistakes: number;
  progressPercent: number;
  completed: boolean;
  completedAtMs: number | null;
};

// ── The verified progress a client is shown about ITSELF ──────────────────

/**
 * The viewer's own live figures, derived by the server.
 *
 * Distinct from `SudokuProgress` (which is the engine's full breakdown) in that
 * this is the small, stable shape the store puts on the wire: the same metric
 * the opponent sees, plus the seat's own penalty.
 */
export type SeatProgress = {
  correctCells: number;
  mistakes: number;
  penaltyMs: number;
  progressPercent: number;
};

// ── Race resolution (pure) ────────────────────────────────────────────────

/** The per-seat facts the settlement ladder needs. No grid, no entries. */
export type SudokuSeatRace = {
  userId: string | null;
  ply: number;
  correctCells: number;
  mistakes: number;
  penaltyMs: number;
  completedAtMs: number | null;
  /** The instant the seat last increased `correctCells`, for the tiebreak. */
  progressAtMs: number | null;
  forfeited: boolean;
};

export type SudokuRaceResult = "player1" | "player2" | "draw";

export type SudokuRaceResolution = "finish" | "deadline" | "forfeit" | "draw";

export type SudokuRaceOutcome = {
  result: SudokuRaceResult;
  resolution: SudokuRaceResolution;
};

/** What the server decided about one submitted action. */
export type SudokuVerdict = "correct" | "incorrect" | "cleared";

/** Why an ACTION was refused by the store (distinct from a play decision). */
export type SudokuMoveCode =
  | SudokuActionCode
  | "ALREADY_COMPLETE"
  | "MOVE_LIMIT_REACHED";
