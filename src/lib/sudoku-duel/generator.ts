// src/lib/sudoku-duel/generator.ts
//
// The deterministic Sudoku generator and solver — the SERVER-side authority for
// the puzzle both seats race on. PURE: no database, no clock, no I/O, and no
// `Math.random()`. The same 32-bit seed always produces the same puzzle, in
// every runtime, which is what lets a match be reproduced from its stored seed
// alone (the same fairness property Solitaire Duel and Mini Golf rely on).
//
// It reuses the platform's shared deterministic primitives
// (`mulberry32` + `hashSeed` in `src/lib/physics2d/deterministic.ts`) rather than
// introducing a second PRNG.
//
// ── HOW A PUZZLE IS BUILT ────────────────────────────────────────────────────
//
//   1. A FULL solved grid is built from a seed by permuting a fixed canonical
//      grid (shuffle the digits, shuffle the bands/stacks and the rows/columns
//      inside them). Every such permutation of a valid grid is still a valid
//      grid, so this step needs no search.
//   2. The solver then CARVES clues out of it, always removing a cell together
//      with its 180°-rotational partner, and only ever accepting a removal that
//      leaves the puzzle with EXACTLY ONE solution (`countSolutions(..., 2)`).
//      Symmetric carving is what gives the shipped puzzles a pleasing layout;
//      the uniqueness check is what guarantees the "prefer exactly one solution"
//      requirement.
//
// The generator is the ONLY source of a puzzle. A client never sends one, and
// `generator.ts` is never imported by a client component (it is pure, but the
// solution it returns must stay server-side — see `src/lib/sudoku-duel/types.ts`).

import { hashSeed, mulberry32 } from "../physics2d/deterministic";
import {
  BOX,
  CELL_COUNT,
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  EMPTY,
  GIVENS_BY_DIFFICULTY,
  MAX_VALUE,
  MIN_GIVENS,
  MIN_VALUE,
  SIZE,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import {
  emptyGrid,
  findConflicts,
  givenCount,
  isCellValue,
  isCompleteSolution,
  isGrid,
  peersOf,
} from "./rules";
import type { Grid, SudokuDifficulty, SudokuPuzzle } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Difficulty
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map any spelling onto the canonical tier.
 *
 * Accepts the platform's historical aliases (`medium`, `casual`, `expert`, …)
 * and falls back to the default for anything unrecognised rather than throwing —
 * this runs on a value arriving from a lobby or a stored row.
 */
export function coerceSudokuDifficulty(value: unknown): SudokuDifficulty {
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if ((DIFFICULTIES as readonly string[]).includes(key)) {
      return key as SudokuDifficulty;
    }
    if (key === "medium" || key === "moderate" || key === "average") return "normal";
    if (key === "casual" || key === "beginner" || key === "novice") return "easy";
    if (key === "expert" || key === "pro" || key === "advanced" || key === "insane") {
      return "hard";
    }
  }
  return DEFAULT_DIFFICULTY;
}

/** The clue target for a tier, clamped to a realisable range. */
export function targetGivensFor(difficulty: unknown): number {
  const tier = coerceSudokuDifficulty(difficulty);
  const target = Number(GIVENS_BY_DIFFICULTY[tier]);
  return Math.min(CELL_COUNT, Math.max(MIN_GIVENS, Number.isFinite(target) ? target : MIN_GIVENS));
}

/** A valid unsigned 32-bit seed, or 0 for anything unusable. */
export function normalizeSeed(seed: unknown): number {
  const value = Number(seed);
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Solver (bitmask + MRV backtracking)
// ─────────────────────────────────────────────────────────────────────────────

/** Bitmask of values that may legally occupy `index` on `board` (bit v ⇒ v). */
function candidateMask(board: Grid, index: number): number {
  let used = 0;
  for (const peer of peersOf(index)) {
    const value = board[peer];
    if (value !== EMPTY) used |= 1 << value;
  }
  let mask = 0;
  for (let value = MIN_VALUE; value <= MAX_VALUE; value += 1) {
    if ((used & (1 << value)) === 0) mask |= 1 << value;
  }
  return mask;
}

function maskToValues(mask: number): number[] {
  const out: number[] = [];
  for (let value = MIN_VALUE; value <= MAX_VALUE; value += 1) {
    if (mask & (1 << value)) out.push(value);
  }
  return out;
}

/**
 * The first completion of `grid`, or null when it has none.
 *
 * A minimum-remaining-values search: it always expands the empty cell with the
 * fewest candidates, which keeps even a nearly-empty board fast. Returns a fresh
 * grid; the input is never mutated.
 */
export function solveGrid(grid: unknown): Grid | null {
  if (!isGrid(grid)) return null;
  const board = grid.slice();

  const step = (): boolean => {
    let best = -1;
    let bestMask = 0;
    let bestCount = 0;

    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (board[index] !== EMPTY) continue;
      const mask = candidateMask(board, index);
      const count = maskToValues(mask).length;
      if (count === 0) return false; // dead end
      if (best === -1 || count < bestCount) {
        best = index;
        bestMask = mask;
        bestCount = count;
        if (count === 1) break;
      }
    }

    if (best === -1) return true; // no empty cell: solved

    for (const value of maskToValues(bestMask)) {
      board[best] = value;
      if (step()) return true;
      board[best] = EMPTY;
    }
    return false;
  };

  return step() ? board : null;
}

/**
 * How many completions `grid` has, counting at most `limit`.
 *
 * `countSolutions(grid, 2)` is the uniqueness test: `1` means exactly one
 * solution, `2` means "more than one" (the count stops early for speed).
 */
export function countSolutions(grid: unknown, limit = 2): number {
  if (!isGrid(grid)) return 0;
  const cap = Math.max(1, Math.floor(Number(limit) || 1));
  const board = grid.slice();
  let count = 0;

  const step = (): void => {
    if (count >= cap) return;

    let best = -1;
    let bestMask = 0;
    let bestCount = 0;

    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (board[index] !== EMPTY) continue;
      const mask = candidateMask(board, index);
      const size = maskToValues(mask).length;
      if (size === 0) return; // dead end
      if (best === -1 || size < bestCount) {
        best = index;
        bestMask = mask;
        bestCount = size;
        if (size === 1) break;
      }
    }

    if (best === -1) {
      count += 1;
      return;
    }

    for (const value of maskToValues(bestMask)) {
      board[best] = value;
      step();
      board[best] = EMPTY;
      if (count >= cap) return;
    }
  };

  step();
  return count;
}

/** True when `grid` has exactly one completion (the preferred puzzle shape). */
export function hasUniqueSolution(grid: unknown): boolean {
  return countSolutions(grid, 2) === 1;
}

/** True when `grid` has at least one completion. */
export function isSolvable(grid: unknown): boolean {
  return countSolutions(grid, 1) >= 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic grid construction
// ─────────────────────────────────────────────────────────────────────────────

/** A valid completed 9x9 grid at index 0 of a cyclic Latin pattern. */
function canonicalValue(row: number, col: number): number {
  return ((row * BOX + Math.floor(row / BOX) + col) % SIZE) + 1;
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/**
 * A row/column ordering that respects the box groups: the three bands are
 * shuffled, and the rows inside each band are shuffled independently.
 *
 * Any such ordering is a symmetry of Sudoku, so applying it to a valid grid (on
 * the row axis, the column axis, or both) keeps the grid valid.
 */
function bandedOrder(rand: () => number): number[] {
  const groups = shuffled([0, 1, 2], rand);
  const out: number[] = [];
  for (const group of groups) {
    for (const inside of shuffled([0, 1, 2], rand)) out.push(group * BOX + inside);
  }
  return out;
}

/**
 * A full solved grid from `seed`.
 *
 * Deterministic and search-free: it shuffles the digits, the bands, the
 * row/column groups and the rows/columns within each group, then maps the
 * canonical pattern through them. Every transformation is a Sudoku symmetry, so
 * the result is always a valid completed grid.
 */
export function generateSolvedGrid(seed: unknown): Grid {
  const rand = mulberry32(hashSeed(`sudoku-duel:grid:${normalizeSeed(seed)}`));
  const digits = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], rand);
  const rowOrder = bandedOrder(rand);
  const colOrder = bandedOrder(rand);

  const grid = emptyGrid();
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      grid[row * SIZE + col] = digits[canonicalValue(rowOrder[row], colOrder[col]) - 1];
    }
  }
  return grid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Carving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove clues from `solution` until `targetGivens` remain, always preserving a
 * UNIQUE solution.
 *
 * Cells are considered in a seeded order and removed in 180°-rotational pairs,
 * so the layout stays symmetric. A removal is kept only when the puzzle it
 * produces still has exactly one completion; otherwise it is reverted. The
 * result can therefore carry MORE clues than the target (never fewer), and the
 * puzzle it returns is guaranteed unique.
 */
export function carvePuzzle({
  solution,
  seed,
  targetGivens,
}: {
  solution: Grid;
  seed: unknown;
  targetGivens: number;
}): { puzzle: Grid; givens: number } {
  if (!isGrid(solution)) {
    return { puzzle: emptyGrid(), givens: 0 };
  }
  const target = Math.min(CELL_COUNT, Math.max(MIN_GIVENS, Math.floor(Number(targetGivens) || 0)));
  const rand = mulberry32(hashSeed(`sudoku-duel:carve:${normalizeSeed(seed)}`));
  const puzzle = solution.slice();
  let givens = CELL_COUNT;

  const order = shuffled(
    Array.from({ length: CELL_COUNT }, (_, i) => i),
    rand,
  );

  for (const index of order) {
    if (givens <= target) break;
    const partner = CELL_COUNT - 1 - index;
    const cells = index === partner ? [index] : [index, partner];
    if (cells.some((cell) => puzzle[cell] === EMPTY)) continue; // already carved

    const saved = cells.map((cell) => puzzle[cell]);
    for (const cell of cells) puzzle[cell] = EMPTY;

    if (countSolutions(puzzle, 2) === 1) {
      givens -= cells.length;
    } else {
      cells.forEach((cell, i) => {
        puzzle[cell] = saved[i];
      });
    }
  }

  return { puzzle, givens };
}

// ─────────────────────────────────────────────────────────────────────────────
// Puzzle assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a puzzle plus its authoritative solution from a seed.
 *
 * The single entry point a store should use. `difficulty` is a target, not a
 * promise (see `carvePuzzle`); the returned puzzle always has a unique solution
 * and its `givens` reports what it actually carries.
 */
export function generatePuzzle({
  seed,
  difficulty,
  variantVersion = VARIANT_VERSION,
}: {
  seed: unknown;
  difficulty?: unknown;
  variantVersion?: number;
}): SudokuPuzzle {
  const tier = coerceSudokuDifficulty(difficulty);
  const normalizedSeed = normalizeSeed(seed);
  const solution = generateSolvedGrid(normalizedSeed);
  const targetGivens = targetGivensFor(tier);
  const { puzzle, givens } = carvePuzzle({ solution, seed: normalizedSeed, targetGivens });

  return {
    variant: VARIANT,
    variantVersion: Number.isFinite(Number(variantVersion))
      ? Number(variantVersion)
      : VARIANT_VERSION,
    difficulty: tier,
    seed: normalizedSeed,
    puzzle,
    solution,
    givens,
  };
}

/**
 * The puzzle a seed selects — the ONE way a puzzle is chosen for a new match.
 *
 * Deterministic, so a stored seed reproduces the exact puzzle. Named after
 * `selectPassageForSeed` / `dealFromSeed` so the pattern is obvious.
 */
export function selectPuzzleForSeed({
  seed,
  difficulty,
  version = VARIANT_VERSION,
}: {
  seed: unknown;
  difficulty?: unknown;
  version?: number;
}): SudokuPuzzle {
  return generatePuzzle({ seed, difficulty, variantVersion: version });
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

export type PuzzleVerification = {
  valid: boolean;
  unique: boolean;
  hasSolution: boolean;
  conflicts: number[];
  reason?: string;
};

/**
 * Independently verify a puzzle (and, optionally, its claimed solution).
 *
 * Checks, in order:
 *   1. the givens are a well-formed grid with no row/column/box conflict
 *   2. the puzzle is solvable at all
 *   3. every given agrees with the supplied solution (when one is supplied)
 *   4. the supplied solution is a COMPLETED, legal grid (when supplied)
 *   5. the puzzle has EXACTLY ONE solution
 *
 * `valid` mirrors "prefer exactly one solution": a puzzle with two solutions is
 * reported `hasSolution: true, unique: false, valid: false`. This is the check a
 * test, an audit or a future store calls to refuse a hand-edited row.
 */
export function verifyPuzzle({
  puzzle,
  solution,
}: {
  puzzle: unknown;
  solution?: unknown;
}): PuzzleVerification {
  if (!isGrid(puzzle)) {
    return { valid: false, unique: false, hasSolution: false, conflicts: [], reason: "malformed-grid" };
  }

  const conflicts = findConflicts(puzzle);
  if (conflicts.length > 0) {
    return { valid: false, unique: false, hasSolution: false, conflicts, reason: "given-conflict" };
  }

  const solutions = countSolutions(puzzle, 2);
  const hasSolution = solutions >= 1;
  const unique = solutions === 1;
  if (!hasSolution) {
    return { valid: false, unique: false, hasSolution: false, conflicts, reason: "no-solution" };
  }

  if (solution !== undefined && solution !== null) {
    if (!isCompleteSolution(solution)) {
      return { valid: false, unique, hasSolution, conflicts, reason: "bad-solution" };
    }
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (puzzle[i] !== EMPTY && puzzle[i] !== solution[i]) {
        return { valid: false, unique, hasSolution, conflicts, reason: "given-mismatch" };
      }
    }
  }

  return {
    valid: unique,
    unique,
    hasSolution,
    conflicts,
    ...(unique ? {} : { reason: "not-unique" }),
  };
}

/** True when `grid` is a playable puzzle grid: well-formed, conflict-free, solvable. */
export function isValidPuzzleGrid(grid: unknown): boolean {
  if (!isGrid(grid)) return false;
  if (findConflicts(grid).length > 0) return false;
  return isSolvable(grid);
}

/** The clue count of a seeded puzzle without materialising it twice. */
export function givensForSeed(seed: unknown, difficulty?: unknown): number {
  return givenCount(generatePuzzle({ seed, difficulty }).puzzle);
}

/** Re-exported so a store can assert a value without importing ./rules. */
export { isCompleteSolution, isCellValue };
