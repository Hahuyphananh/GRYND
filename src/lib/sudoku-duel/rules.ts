// src/lib/sudoku-duel/rules.ts
//
// The authoritative Sudoku Duel rules engine. PURE: no database, no clock, no
// I/O, and no randomness at all — every function is a deterministic
// transformation of the grids it is handed, which keeps the whole game
// unit-testable and the future store thin.
//
// ── THE TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The ONLY thing a client may author is an ACTION: "write value V at cell I", or
// "clear cell I". `normalizeAction` shape-checks that envelope WITHOUT coercion
// (the string "3" is not a value, `2.5` is not an index, a missing field is not
// a default) and builds a FRESH object, so every extra property a hostile client
// attaches — a grid, a solution, a correct-cell count, a completion flag, a
// winner, an Elo or trophy value — is simply not read and does not survive.
//
// Every decision is then re-derived here from the SERVER's own `puzzle` and
// `solution`. There is no function in this file that accepts a caller-supplied
// grid, solution, count, completion or result.
//
// ── WHY A WRONG VALUE IS ACCEPTED, NOT REFUSED ───────────────────────────────
//
// `validateAction` refuses a placement only when it breaks a constraint the
// player can ALREADY SEE (same value in the same row / column / box) or when it
// targets a fixed clue. It deliberately ACCEPTS a value that is legal on the
// visible board but WRONG against the hidden solution.
//
// That is a security property, not leniency. If the server rejected every
// incorrect value, a client could recover the solution by trying 1..9 in each
// cell until one was accepted. Accepting wrong values means the accept/reject
// channel carries no information about the solution; correctness is expressed
// only as VERIFIED PROGRESS (`progressOf`), which the server computes and never
// reports as feedback on a single cell.

import {
  ACTION_CODES,
  BOX,
  CELL_COUNT,
  EMPTY,
  MATCH_STATUS,
  MAX_MOVES_PER_SEAT,
  MAX_VALUE,
  MISTAKE_PENALTY_MS,
  MIN_VALUE,
  RESOLUTION,
  SEAT,
  SIZE,
} from "./constants";
import type {
  Grid,
  OpponentProgress,
  Seat,
  SeatProgress,
  Seats,
  SudokuAction,
  SudokuActionCode,
  SudokuPuzzle,
  SudokuProgress,
  SudokuRaceOutcome,
  SudokuSeatRace,
  SudokuSeatState,
  SudokuVerdict,
  SudokuView,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

export function indexToRow(index: number): number {
  return Math.floor(index / SIZE);
}

export function indexToCol(index: number): number {
  return index % SIZE;
}

/** The 0..8 box index of a cell (boxes numbered row-major). */
export function boxOf(index: number): number {
  const row = indexToRow(index);
  const col = indexToCol(index);
  return Math.floor(row / BOX) * BOX + Math.floor(col / BOX);
}

/** The nine indices of the row containing `index`. */
export function rowIndices(index: number): number[] {
  const row = indexToRow(index);
  const out: number[] = [];
  for (let col = 0; col < SIZE; col += 1) out.push(row * SIZE + col);
  return out;
}

/** The nine indices of the column containing `index`. */
export function colIndices(index: number): number[] {
  const col = indexToCol(index);
  const out: number[] = [];
  for (let row = 0; row < SIZE; row += 1) out.push(row * SIZE + col);
  return out;
}

/** The nine indices of the 3x3 box containing `index`. */
export function boxIndices(index: number): number[] {
  const baseRow = Math.floor(indexToRow(index) / BOX) * BOX;
  const baseCol = Math.floor(indexToCol(index) / BOX) * BOX;
  const out: number[] = [];
  for (let dr = 0; dr < BOX; dr += 1) {
    for (let dc = 0; dc < BOX; dc += 1) {
      out.push((baseRow + dr) * SIZE + (baseCol + dc));
    }
  }
  return out;
}

/**
 * Every cell that shares a row, column or box with `index` — excluding `index`
 * itself. Sudoku's "see" relation, and the set a placement must not clash with.
 */
export function peersOf(index: number): number[] {
  const seen = new Set<number>();
  for (const peer of [...rowIndices(index), ...colIndices(index), ...boxIndices(index)]) {
    if (peer !== index) seen.add(peer);
  }
  return [...seen];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape checks (strict, no coercion)
// ─────────────────────────────────────────────────────────────────────────────

/** An empty board: 81 zeros. */
export function emptyGrid(): Grid {
  return new Array(CELL_COUNT).fill(EMPTY);
}

/**
 * True for a well-formed board: an array of exactly 81 INTEGERS, each `0`
 * (empty) or 1..9. Nothing is coerced: `"3"`, `2.5`, `NaN`, `null`, `true` and
 * a negative value are all rejected.
 */
export function isGrid(value: unknown): value is Grid {
  if (!Array.isArray(value) || value.length !== CELL_COUNT) return false;
  for (const cell of value) {
    if (typeof cell !== "number" || !Number.isInteger(cell)) return false;
    if (cell < EMPTY || cell > MAX_VALUE) return false;
  }
  return true;
}

/** True for a playable cell index (integer 0..80). */
export function isCellIndex(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < CELL_COUNT
  );
}

/** True for a legal placed value (integer 1..9). `0` is NOT a value. */
export function isCellValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_VALUE &&
    value <= MAX_VALUE
  );
}

/** Two boards are identical, cell for cell. */
export function gridsEqual(a: unknown, b: unknown): boolean {
  if (!isGrid(a) || !isGrid(b)) return false;
  for (let i = 0; i < CELL_COUNT; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** How many clues a puzzle carries. */
export function givenCount(puzzle: Grid): number {
  if (!isGrid(puzzle)) return 0;
  let count = 0;
  for (const cell of puzzle) if (cell !== EMPTY) count += 1;
  return count;
}

/** True when `index` is a fixed clue in `puzzle`. */
export function isGiven(puzzle: Grid, index: number): boolean {
  return isGrid(puzzle) && isCellIndex(index) && puzzle[index] !== EMPTY;
}

/** The board a seat starts from: the puzzle itself, at ply 0. */
export function initialGrid(puzzle: Grid): Grid {
  return isGrid(puzzle) ? puzzle.slice() : emptyGrid();
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflicts (visible-board legality)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the value at `index` clashes with another cell in its row, column
 * or box.
 *
 * Reads ONLY the board it is given — it never consults a solution, so it is safe
 * to run on a client and safe to use as a server gate.
 */
export function conflictsAt(grid: Grid, index: number): boolean {
  if (!isGrid(grid) || !isCellIndex(index)) return false;
  const value = grid[index];
  if (value === EMPTY) return false;
  for (const peer of peersOf(index)) {
    if (grid[peer] === value) return true;
  }
  return false;
}

/** Every index whose value clashes with a peer, ascending. Empty when legal. */
export function findConflicts(grid: Grid): number[] {
  if (!isGrid(grid)) return [];
  const out: number[] = [];
  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (grid[i] !== EMPTY && conflictsAt(grid, i)) out.push(i);
  }
  return out;
}

/** True when the board breaks no row/column/box constraint. */
export function hasNoConflicts(grid: Grid): boolean {
  return isGrid(grid) && findConflicts(grid).length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Solutions (server-only shapes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `grid` is a COMPLETED, legal Sudoku: every cell filled and no
 * constraint broken. This is what a valid `solution` must be.
 */
export function isCompleteSolution(grid: unknown): boolean {
  if (!isGrid(grid)) return false;
  for (const cell of grid) if (cell === EMPTY) return false;
  return hasNoConflicts(grid);
}

/** True when `grid` matches the authoritative `solution` exactly. */
export function isBoardSolved(grid: unknown, solution: unknown): boolean {
  if (!isCompleteSolution(solution)) return false;
  return gridsEqual(grid, solution);
}

/**
 * True when the value at `index` equals the authoritative solution.
 *
 * The ONLY function that judges a single value against the hidden answer. It is
 * called by `progressOf` (server-side) and never exposed as per-cell feedback to
 * a client.
 */
export function correctAt(solution: Grid, index: number, value: unknown): boolean {
  if (!isGrid(solution) || !isCellIndex(index) || !isCellValue(value)) return false;
  return solution[index] === value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export type RawActionResult =
  | { ok: true; action: SudokuAction }
  | { ok: false; code: SudokuActionCode; error: string };

function reject(code: SudokuActionCode, error: string) {
  return { ok: false as const, code, error };
}

/**
 * Turn an untrusted payload into a typed action, or refuse it.
 *
 * Strict by construction: every field is type- and range-checked as-is, nothing
 * is coerced or defaulted, unknown properties are ignored rather than merged,
 * and the returned object is a FRESH literal carrying only `kind`, `index` and
 * (for `place`) `value`. A payload such as
 *   { kind: "place", index: 4, value: 7, solution: [...], completed: true }
 * becomes exactly `{ kind: "place", index: 4, value: 7 }`.
 */
export function normalizeAction(raw: unknown): RawActionResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return reject(ACTION_CODES.BAD_ACTION, "An action must be an object");
  }
  const value = raw as Record<string, unknown>;
  const kind = value.kind;

  if (kind === "place") {
    if (!isCellIndex(value.index)) {
      return reject(
        ACTION_CODES.OUT_OF_RANGE,
        `A cell index must be an integer in [0, ${CELL_COUNT - 1}]`,
      );
    }
    if (!isCellValue(value.value)) {
      return reject(
        ACTION_CODES.OUT_OF_RANGE,
        `A value must be an integer in [${MIN_VALUE}, ${MAX_VALUE}]`,
      );
    }
    return { ok: true, action: { kind: "place", index: value.index, value: value.value } };
  }

  if (kind === "clear") {
    if (!isCellIndex(value.index)) {
      return reject(
        ACTION_CODES.OUT_OF_RANGE,
        `A cell index must be an integer in [0, ${CELL_COUNT - 1}]`,
      );
    }
    return { ok: true, action: { kind: "clear", index: value.index } };
  }

  return reject(ACTION_CODES.BAD_ACTION, "Unknown action kind");
}

export type ActionValidation =
  | { ok: true; code?: SudokuActionCode; error?: string }
  | { ok: false; code: SudokuActionCode; error: string };

/**
 * Whether an action is legal against the visible board.
 *
 * Gate order (each an explicit, testable rejection):
 *   1. the puzzle and board are well-formed
 *   2. the cell index is in range
 *   3. the cell is not a fixed clue
 *   4. a `place` value is in range and does not clash with a visible peer
 *
 * It never reads a solution, so it is safe to mirror on the client for
 * optimistic rendering and cannot become an oracle for the answer.
 */
export function validateAction({
  puzzle,
  grid,
  action,
}: {
  puzzle: Grid;
  grid: Grid;
  action: SudokuAction;
}): ActionValidation {
  if (!isGrid(puzzle) || !isGrid(grid)) {
    return reject(ACTION_CODES.BAD_ACTION, "The board is unavailable");
  }
  if (!isCellIndex(action?.index)) {
    return reject(
      ACTION_CODES.OUT_OF_RANGE,
      `A cell index must be an integer in [0, ${CELL_COUNT - 1}]`,
    );
  }
  if (puzzle[action.index] !== EMPTY) {
    return reject(ACTION_CODES.GIVEN_CELL, "That cell is a fixed clue");
  }
  if (action.kind === "place") {
    if (!isCellValue(action.value)) {
      return reject(
        ACTION_CODES.OUT_OF_RANGE,
        `A value must be an integer in [${MIN_VALUE}, ${MAX_VALUE}]`,
      );
    }
    const probe = grid.slice();
    probe[action.index] = action.value;
    if (conflictsAt(probe, action.index)) {
      return reject(
        ACTION_CODES.CONFLICT,
        "That value already appears in this row, column or box",
      );
    }
  }
  return { ok: true };
}

/**
 * Read the failure fields off a result union, or null for a success.
 *
 * Needed because this repo compiles with `strict: false`, where a boolean
 * discriminant does not narrow a union. Mirrors the helper of the same name in
 * `src/lib/solitaire-duel/rules.ts`.
 */
export function failureOf<T extends { ok: boolean }>(
  result: T,
): { code: SudokuActionCode; error: string } | null {
  if (!result || result.ok) return null;
  const failure = result as unknown as { code?: SudokuActionCode; error?: string };
  return {
    code: failure.code ?? ACTION_CODES.BAD_ACTION,
    error: failure.error ?? "Invalid action",
  };
}

export type AppliedAction =
  | { ok: true; grid: Grid; action: SudokuAction; code?: SudokuActionCode; error?: string }
  | {
      ok: false;
      code: SudokuActionCode;
      error: string;
      grid?: Grid;
    };

/**
 * Apply one legal action and return the NEXT board.
 *
 * Re-validates internally, so an unvalidated action can never reach the board.
 * The input grid is never mutated: the result is a fresh copy.
 */
export function applyAction({
  puzzle,
  grid,
  action,
}: {
  puzzle: Grid;
  grid: Grid;
  action: SudokuAction;
}): AppliedAction {
  const invalid = failureOf(validateAction({ puzzle, grid, action }));
  if (invalid) return { ok: false, ...invalid };

  const next = grid.slice();
  next[action.index] = action.kind === "place" ? action.value : EMPTY;
  return { ok: true, grid: next, action };
}

/** Replay an accepted action log from the puzzle, for audit/tests. */
export function replayActions({
  puzzle,
  actions,
}: {
  puzzle: Grid;
  actions: SudokuAction[];
}): { ok: boolean; grid: Grid; rejectedAt: number | null } {
  let grid = initialGrid(puzzle);
  if (!isGrid(puzzle)) return { ok: false, grid, rejectedAt: 0 };
  for (let index = 0; index < actions.length; index += 1) {
    const applied = applyAction({ puzzle, grid, action: actions[index] });
    if (!applied.ok) return { ok: false, grid, rejectedAt: index };
    grid = applied.grid;
  }
  return { ok: true, grid, rejectedAt: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress (the competitive metric)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verified progress, computed from the SERVER's givens, board and solution.
 *
 * `correctEntries` counts only NON-given cells that match the solution, so the
 * clues both seats start with never inflate it and a wrong entry never advances
 * it. `completed` is true only when the board is the solution exactly.
 */
export function progressOf(puzzle: Grid, grid: Grid, solution: Grid): SudokuProgress {
  const safePuzzle = isGrid(puzzle) ? puzzle : emptyGrid();
  const safeGrid = isGrid(grid) ? grid : emptyGrid();
  const safeSolution = isGrid(solution) ? solution : emptyGrid();

  let correctCells = 0;
  let correctEntries = 0;
  let filledEntries = 0;
  let incorrectEntries = 0;
  let emptyEntries = 0;

  for (let i = 0; i < CELL_COUNT; i += 1) {
    const isClue = safePuzzle[i] !== EMPTY;
    const value = safeGrid[i];
    if (value !== EMPTY && value === safeSolution[i]) correctCells += 1;
    if (isClue) continue;
    if (value === EMPTY) {
      emptyEntries += 1;
      continue;
    }
    filledEntries += 1;
    if (value === safeSolution[i]) correctEntries += 1;
    else incorrectEntries += 1;
  }

  const totalEntries = CELL_COUNT - givenCount(safePuzzle);
  const completed = correctCells === CELL_COUNT;
  const progressPercent =
    totalEntries > 0 ? Math.round((correctEntries / totalEntries) * 100) : 0;

  return {
    correctCells,
    correctEntries,
    filledEntries,
    incorrectEntries,
    emptyEntries,
    totalEntries,
    progressPercent,
    completed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// View projection — the single place hidden information could leak
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The client-facing projection of a seat's board.
 *
 * Carries the givens, the seat's OWN entries, the conflicts deducible from those
 * (which the player can already compute), and verified progress. It does NOT
 * carry the solution, the opponent's board, or any value a client authored.
 */
export function viewForState({
  puzzle,
  grid,
  ply = 0,
}: {
  puzzle: SudokuPuzzle | Grid;
  grid: Grid;
  ply?: number;
}): SudokuView {
  const meta = Array.isArray(puzzle) ? null : puzzle;
  const safePuzzle: Grid = meta ? meta.puzzle : (puzzle as Grid);
  const solution: Grid = meta ? meta.solution : emptyGrid();
  const safeGrid = isGrid(grid) ? grid : initialGrid(safePuzzle);

  return {
    variant: meta ? meta.variant : "",
    variantVersion: meta ? meta.variantVersion : 0,
    difficulty: meta ? meta.difficulty : ("normal" as SudokuView["difficulty"]),
    puzzle: isGrid(safePuzzle) ? safePuzzle.slice() : emptyGrid(),
    entries: safeGrid.slice(),
    conflicts: findConflicts(safeGrid),
    progress: progressOf(safePuzzle, safeGrid, solution),
    completed: isBoardSolved(safeGrid, solution),
    ply: Number.isInteger(ply) && ply > 0 ? ply : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seats
// ─────────────────────────────────────────────────────────────────────────────

/** True when a value is one of the two seats. */
export function isSeat(value: unknown): value is Seat {
  return value === SEAT.PLAYER1 || value === SEAT.PLAYER2;
}

export function otherSeat(seat: Seat): Seat {
  return seat === SEAT.PLAYER1 ? SEAT.PLAYER2 : SEAT.PLAYER1;
}

export function seatForUser(seats: Seats, userId: unknown): Seat | null {
  if (typeof userId !== "string" || !userId) return null;
  if (seats?.player1Id === userId) return SEAT.PLAYER1;
  if (seats?.player2Id === userId) return SEAT.PLAYER2;
  return null;
}

export function userIdForSeat(seats: Seats, seat: Seat | null): string | null {
  if (seat === SEAT.PLAYER1) return seats?.player1Id ?? null;
  if (seat === SEAT.PLAYER2) return seats?.player2Id ?? null;
  return null;
}

export function hasBothSeats(seats: Seats): boolean {
  return Boolean(seats?.player1Id) && Boolean(seats?.player2Id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-seat authoritative state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The board a seat starts from: the puzzle's clues, nothing placed.
 *
 * Both seats are handed the SAME opening board, so no per-seat randomness exists
 * anywhere in the opening position — which is the structural half of "both
 * players receive the exact same puzzle".
 */
export function initialStateFromPuzzle(puzzle: SudokuPuzzle | Grid): SudokuSeatState {
  const clues: Grid = Array.isArray(puzzle) ? puzzle : puzzle.puzzle;
  return {
    grid: initialGrid(clues),
    ply: 0,
    mistakes: 0,
    penaltyMs: 0,
    completed: false,
    completedAtMs: null,
    progressAtMs: null,
  };
}

/**
 * A shallow structural check for a seat state read back from the database.
 *
 * Guards against a legacy or hand-edited row: anything that is not a plausible
 * board is refused rather than fed to the engine.
 */
export function isWellFormedSeatState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<SudokuSeatState>;
  if (!isGrid(state.grid)) return false;
  if (!Number.isInteger(state.ply) || (state.ply as number) < 0) return false;
  return true;
}

/** A copy of a seat state, so the engine never mutates the caller's object. */
export function cloneSeatState(state: SudokuSeatState): SudokuSeatState {
  return {
    grid: isGrid(state?.grid) ? state.grid.slice() : emptyGrid(),
    ply: Number.isInteger(state?.ply) ? (state.ply as number) : 0,
    mistakes: Number.isFinite(state?.mistakes) ? (state.mistakes as number) : 0,
    penaltyMs: Number.isFinite(state?.penaltyMs) ? (state.penaltyMs as number) : 0,
    completed: Boolean(state?.completed),
    completedAtMs:
      typeof state?.completedAtMs === "number" ? state.completedAtMs : null,
    progressAtMs:
      typeof state?.progressAtMs === "number" ? state.progressAtMs : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The judge — the ONE place a submitted action meets the hidden solution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of judging one submitted action against the authoritative boards.
 *
 * A refused action (`ok: false`) never happens for a well-formed action on a
 * live board: an incorrect value is ACCEPTED as an action but recorded as a
 * MISTAKE, because the client is entitled to know it was wrong (that is the
 * game) while never being told what the right value was.
 */
export type SudokuJudgement =
  | {
      ok: true;
      verdict: SudokuVerdict;
      /** True only for a correct placement. */
      correct: boolean;
      /** The NEXT seat state (grid unchanged for a mistake). */
      state: SudokuSeatState;
      progress: SudokuProgress;
    }
  | { ok: false; code: SudokuActionCode; error: string };

/**
 * Judge one normalized action and return the next seat state.
 *
 * THE ONLY function in the engine that reads the solution on a player's behalf.
 * It is called exclusively by the store, inside a row lock, and its decision is
 * never echoed as anything but `correct: true|false` — the correct VALUE is
 * never returned and never placed on a wrong cell, so the response cannot be
 * mined for the answer.
 *
 * `nowMs` is the server instant the store is acting at; it is passed in (never
 * read from a clock here) so the engine stays pure and testable. It stamps the
 * two time facts that decide the match: `completedAtMs` and `progressAtMs`.
 */
export function judgeAction({
  puzzle,
  solution,
  state,
  action,
  nowMs = 0,
}: {
  puzzle: Grid;
  solution: Grid;
  state: SudokuSeatState;
  action: SudokuAction;
  nowMs?: number;
}): SudokuJudgement {
  if (!isGrid(puzzle) || !isGrid(solution)) {
    return reject(ACTION_CODES.BAD_ACTION, "The board is unavailable");
  }
  if (!isWellFormedSeatState(state)) {
    return reject(ACTION_CODES.BAD_ACTION, "The board is unavailable");
  }
  if (!action || !isCellIndex(action.index)) {
    return reject(
      ACTION_CODES.OUT_OF_RANGE,
      `A cell index must be an integer in [0, ${CELL_COUNT - 1}]`,
    );
  }
  if (puzzle[action.index] !== EMPTY) {
    return reject(ACTION_CODES.GIVEN_CELL, "That cell is a fixed clue");
  }

  const before = progressOf(puzzle, state.grid, solution);

  if (action.kind === "clear") {
    if (state.grid[action.index] === EMPTY) {
      return reject(ACTION_CODES.NOTHING_TO_CLEAR, "That cell is already empty");
    }
    const next = cloneSeatState(state);
    next.grid[action.index] = EMPTY;
    next.ply = state.ply + 1;
    // Progress can only fall here, so `progressAtMs` is deliberately untouched.
    return {
      ok: true,
      verdict: "cleared",
      correct: false,
      state: next,
      progress: progressOf(puzzle, next.grid, solution),
    };
  }

  if (!isCellValue(action.value)) {
    return reject(
      ACTION_CODES.OUT_OF_RANGE,
      `A value must be an integer in [${MIN_VALUE}, ${MAX_VALUE}]`,
    );
  }

  const answer = solution[action.index];
  if (state.grid[action.index] === answer) {
    return reject(ACTION_CODES.ALREADY_PLACED, "That cell is already correct");
  }

  if (action.value !== answer) {
    // INCORRECT: the value is NOT written, and the answer is NOT revealed. Only
    // the mistake, its penalty and the ply cursor move.
    const next = cloneSeatState(state);
    next.ply = state.ply + 1;
    next.mistakes = state.mistakes + 1;
    next.penaltyMs = state.penaltyMs + MISTAKE_PENALTY_MS;
    return { ok: true, verdict: "incorrect", correct: false, state: next, progress: before };
  }

  // CORRECT: write the value and re-derive completion from the server's grid.
  const next = cloneSeatState(state);
  next.grid[action.index] = action.value;
  next.ply = state.ply + 1;
  const progress = progressOf(puzzle, next.grid, solution);
  if (progress.correctEntries > before.correctEntries) next.progressAtMs = nowMs;
  next.completed = progress.completed;
  if (progress.completed) next.completedAtMs = nowMs;
  return { ok: true, verdict: "correct", correct: true, state: next, progress };
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress projections
// ─────────────────────────────────────────────────────────────────────────────

/** The viewer's own live figures, derived entirely from the server's boards. */
export function seatProgressFor(
  puzzle: Grid,
  solution: Grid,
  state: SudokuSeatState,
): SeatProgress {
  const progress = progressOf(puzzle, state?.grid ?? emptyGrid(), solution);
  return {
    correctCells: progress.correctEntries,
    mistakes: Number.isFinite(state?.mistakes) ? state.mistakes : 0,
    penaltyMs: Number.isFinite(state?.penaltyMs) ? state.penaltyMs : 0,
    progressPercent: progress.progressPercent,
  };
}

/**
 * The closed opponent shape.
 *
 * Counts and status, deliberately nothing else: no grid, no entries, no move
 * list. The information is insufficient to reconstruct a board, so it cannot be
 * used to copy answers.
 */
export function opponentProgressFor(
  seat: Seat,
  puzzle: Grid,
  solution: Grid,
  state: SudokuSeatState,
): OpponentProgress {
  const progress = progressOf(puzzle, state?.grid ?? emptyGrid(), solution);
  return {
    seatKey: seat,
    correctCells: progress.correctEntries,
    mistakes: Number.isFinite(state?.mistakes) ? state.mistakes : 0,
    progressPercent: progress.progressPercent,
    completed: Boolean(state?.completed),
    completedAtMs: typeof state?.completedAtMs === "number" ? state.completedAtMs : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Race resolution — the tie-break ladder, pure and testable
// ─────────────────────────────────────────────────────────────────────────────

/** Build the per-seat race facts the ladder reads, from the seat's own board. */
export function raceFactsFor({
  userId,
  state,
  puzzle,
  solution,
  forfeited = false,
}: {
  userId: string | null;
  state: SudokuSeatState | null | undefined;
  puzzle: Grid;
  solution: Grid;
  forfeited?: boolean;
}): SudokuSeatRace {
  const progress = state
    ? progressOf(puzzle, state.grid ?? emptyGrid(), solution)
    : null;
  return {
    userId,
    ply: state?.ply ?? 0,
    correctCells: progress?.correctEntries ?? 0,
    mistakes: Number.isFinite(state?.mistakes) ? (state!.mistakes as number) : 0,
    penaltyMs: Number.isFinite(state?.penaltyMs) ? (state!.penaltyMs as number) : 0,
    // The completion INSTANT decides a photo finish, so it is read from the
    // stored state (stamped by the store), never re-derived here.
    completedAtMs:
      state && (state.completed || state.completedAtMs != null)
        ? (state.completedAtMs ?? null)
        : null,
    progressAtMs:
      typeof state?.progressAtMs === "number" ? state.progressAtMs : null,
    forfeited,
  };
}

/**
 * A seat's ADJUSTED finish instant: its completion instant plus its accumulated
 * mistake penalty.
 *
 * Comparing adjusted instants is order-equivalent to comparing adjusted ELAPSED
 * times, because both seats share one absolute GO instant — subtracting it
 * shifts both sides equally — so the ladder needs no clock input. Returns null
 * for a seat that has not completed.
 */
export function adjustedFinishAtMs(
  race: Pick<SudokuSeatRace, "completedAtMs" | "penaltyMs">,
): number | null {
  if (race.completedAtMs == null) return null;
  return race.completedAtMs + (Number.isFinite(race.penaltyMs) ? race.penaltyMs : 0);
}

/**
 * Decide the match from the two seats' race facts.
 *
 * Returns null while the match is still live (nobody has completed and nobody
 * has forfeited), so the store can call it on every transition and only act
 * when there is a verdict. There is no match clock: a match ends on a
 * completion or a forfeit (a concession, a disconnect, or the inactivity rule).
 *
 * Order:
 *   1. a forfeit decides the match for the opponent; two forfeits are a draw
 *   2. a completion decides it: the LOWER ADJUSTED completion instant wins, an
 *      exact tie falls back to the earliest server completion instant, and a
 *      full tie is a draw. With one completion this is just "the finisher wins"
 */
export function resolveSudokuRace({
  player1,
  player2,
}: {
  player1: SudokuSeatRace;
  player2: SudokuSeatRace;
}): SudokuRaceOutcome | null {
  if (player1.forfeited && player2.forfeited) {
    return { result: "draw", resolution: RESOLUTION.DRAW };
  }
  if (player1.forfeited) return { result: SEAT.PLAYER2, resolution: RESOLUTION.FORFEIT };
  if (player2.forfeited) return { result: SEAT.PLAYER1, resolution: RESOLUTION.FORFEIT };

  const finish1 = adjustedFinishAtMs(player1);
  const finish2 = adjustedFinishAtMs(player2);
  if (finish1 != null && finish2 != null) {
    if (finish1 !== finish2) {
      return finish1 < finish2
        ? { result: SEAT.PLAYER1, resolution: RESOLUTION.FINISH }
        : { result: SEAT.PLAYER2, resolution: RESOLUTION.FINISH };
    }
    // Adjusted times are level: the earlier server-stamped completion wins.
    const at1 = player1.completedAtMs as number;
    const at2 = player2.completedAtMs as number;
    if (at1 !== at2) {
      return at1 < at2
        ? { result: SEAT.PLAYER1, resolution: RESOLUTION.FINISH }
        : { result: SEAT.PLAYER2, resolution: RESOLUTION.FINISH };
    }
    return { result: "draw", resolution: RESOLUTION.DRAW };
  }
  if (finish1 != null) return { result: SEAT.PLAYER1, resolution: RESOLUTION.FINISH };
  if (finish2 != null) return { result: SEAT.PLAYER2, resolution: RESOLUTION.FINISH };

  return null;
}

/** The viewer's own outcome, for the result screen. */
export function outcomeFor(
  seat: Seat | null,
  result: unknown,
): "win" | "loss" | "draw" | null {
  if (!seat || typeof result !== "string") return null;
  if (result === "draw") return "draw";
  if (result === SEAT.PLAYER1 || result === SEAT.PLAYER2) {
    return result === seat ? "win" : "loss";
  }
  return null;
}

/** Re-exported so routes/tests can assert lifecycle vocabulary without a second import. */
export const MATCH_STATUSES = MATCH_STATUS;
export const MAX_ACTIONS_PER_SEAT = MAX_MOVES_PER_SEAT;
