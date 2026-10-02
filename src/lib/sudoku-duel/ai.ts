// src/lib/sudoku-duel/ai.ts
//
// The Sudoku Duel practice bot. PURE: it is handed the server's CLUE grid and
// the bot's own board and returns a list of legal Sudoku actions, in order. No
// database, no clock, no I/O, and no hidden solution is ever read — the bot
// derives the answer from the clues exactly as a human does.
//
// WHY A SOLVER RATHER THAN A HEURISTIC: Sudoku has a single unique completion,
// and the whole game is "reach it first". A constraint solver finds that
// completion deterministically, so the bot genuinely plays the shared puzzle
// instead of guessing — which is what makes it a fair race rather than a dice
// roll. The solver only ever writes values that keep the board legal, so every
// action it returns is one the server's `judgeAction` accepts as CORRECT (the
// bot never wastes a turn on a mistake).
//
// The tier does NOT change accuracy — it changes PACE. Sudoku Duel is
// simultaneous, so the store advances the bot from the server clock: at
// difficulty `d` the bot has earned `floor((now - goAt) / aiMoveDelayMs(d))`
// moves. `hard` solves the shared puzzle quickly, `normal` is a fair race, and
// `easy` is slow enough for a careful human to beat — the same "pace the bot
// from the clock" shape Solitaire Duel uses.

import { coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import { CELL_COUNT, EMPTY, MAX_VALUE, MIN_VALUE, SIZE } from "./constants";
import { emptyGrid, isGrid } from "./rules";
import type { Grid, SudokuAction } from "./types";

/**
 * How long the bot "thinks" between actions, per tier.
 *
 * Measured from GO: the bot is allowed `floor(elapsed / delay)` actions, so a
 * slower tier simply solves the same puzzle later. A classic 9x9 puzzle needs
 * roughly 45-55 non-given placements, so `hard` finishes well inside a
 * couple of minutes while `easy` gives a careful player a real window to win.
 */
export const AI_MOVE_DELAY_MS: Record<AiDifficulty, number> = {
  easy: 4_000,
  normal: 2_200,
  hard: 1_200,
};

/** The delay for a tier, defaulting to the shared `normal` tier. */
export function aiMoveDelayMs(difficulty: unknown): number {
  return AI_MOVE_DELAY_MS[coerceAiDifficulty(difficulty)];
}

/** True when `value` may be placed at `index` without breaking a row/col/box. */
function canPlace(grid: Grid, index: number, value: number): boolean {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;
  for (let i = 0; i < SIZE; i += 1) {
    if (grid[row * SIZE + i] === value) return false;
    if (grid[i * SIZE + col] === value) return false;
    const br = boxRow + Math.floor(i / 3);
    const bc = boxCol + (i % 3);
    if (grid[br * SIZE + bc] === value) return false;
  }
  return true;
}

/**
 * Fill `grid` in place to its unique completion, returning true on success.
 *
 * Depth-first with a "first empty cell" branching order. Sudoku's state space is
 * small enough for this to run inside a request (a 9x9 grid solves in
 * microseconds-to-milliseconds), and the bot's board is always a legal partial
 * solution, so the search never explores a contradiction for long.
 */
function backtrack(grid: Grid, start = 0): boolean {
  let index = -1;
  for (let i = start; i < CELL_COUNT; i += 1) {
    if (grid[i] === EMPTY) {
      index = i;
      break;
    }
  }
  if (index < 0) return true; // every cell is filled

  for (let value = MIN_VALUE; value <= MAX_VALUE; value += 1) {
    if (!canPlace(grid, index, value)) continue;
    grid[index] = value;
    if (backtrack(grid, index + 1)) return true;
    grid[index] = EMPTY;
  }
  return false;
}

/**
 * The unique completion of a board, or null when the board is unsolvable.
 * Never mutates the input.
 */
export function solveGrid(grid: Grid): Grid | null {
  if (!isGrid(grid)) return null;
  const work = grid.slice();
  return backtrack(work) ? work : null;
}

/**
 * Plan the bot's next actions from its current board.
 *
 * Solves the shared puzzle ONCE and returns the placements for its still-empty
 * cells, in row-major order, up to `maxMoves`. The returned `grid` is the board
 * after those actions and `completed` is true when every cell is filled — which
 * the store uses to stamp the bot's completion instant.
 *
 * A board that cannot be solved (only possible if it was somehow corrupted)
 * yields no actions rather than an illegal one, so the bot can never write a
 * value that would be refused.
 */
export function planAiMoves({
  grid,
  maxMoves = 1,
}: {
  grid: Grid;
  maxMoves?: number;
}): { actions: SudokuAction[]; grid: Grid; completed: boolean } {
  const start = isGrid(grid) ? grid.slice() : emptyGrid();
  const cap = Math.max(0, Math.floor(Number(maxMoves) || 0));
  const solved = cap > 0 ? solveGrid(start) : null;
  if (!solved) {
    return { actions: [], grid: start, completed: start.every((c) => c !== EMPTY) };
  }

  const actions: SudokuAction[] = [];
  const work = start.slice();
  for (let index = 0; index < CELL_COUNT && actions.length < cap; index += 1) {
    if (work[index] !== EMPTY) continue;
    const value = solved[index];
    if (!Number.isInteger(value) || value === EMPTY) continue;
    actions.push({ kind: "place", index, value });
    work[index] = value;
  }

  return { actions, grid: work, completed: work.every((c) => c !== EMPTY) };
}

/**
 * The bot's single next action from `grid`, or null when the board is already
 * solved. Exposed for tests and any caller that wants one move at a time.
 *
 * The action is always CORRECT (it comes from the derived solution), so the bot
 * never spends a turn on a mistake; the tier only decides HOW OFTEN it moves
 * (see `aiMoveDelayMs`), which is what makes `easy` beatable.
 */
export function chooseAiMove({ grid }: { grid: Grid }): SudokuAction | null {
  const plan = planAiMoves({ grid, maxMoves: 1 });
  return plan.actions[0] ?? null;
}
