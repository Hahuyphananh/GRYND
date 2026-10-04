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
// The tier changes BOTH pace and accuracy, because pace alone was invisible:
// a bot that is always 100% correct but merely slower still wins every race it
// is given enough time for, so `easy` and `hard` felt identical.
//
//   * PACE — the store advances the bot from the server clock: at difficulty
//     `d` the bot has earned `floor((now - goAt) / aiMoveDelayMs(d))` actions.
//   * ACCURACY — a weaker tier now and then plays a WRONG value. The server
//     already rejects an incorrect entry (it costs a mistake and a time
//     penalty), so a mistake is a real, visible turn wasted — exactly the
//     handicap a weaker opponent should have. `hard` still errs occasionally,
//     so it is beatable rather than unbeatable.

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
  easy: 5_200,
  normal: 2_900,
  hard: 1_600,
};

/**
 * How often a tier plays a deliberately WRONG value instead of the right one.
 *
 * The server refuses an incorrect entry and charges a mistake plus a time
 * penalty, so this is a direct handicap. `hard` is not zero: it stays the
 * strongest tier but can now be beaten.
 */
export const AI_MISTAKE_RATE: Record<AiDifficulty, number> = {
  easy: 0.35,
  normal: 0.15,
  hard: 0.03,
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
/**
 * A deliberately wrong action for the first empty cell, or null when there is
 * none. The value is a legal digit that is simply not the answer — the server
 * rejects it and charges a mistake, which is the point.
 */
function mistakenAction(
  grid: Grid,
  solved: Grid,
  random: () => number,
): SudokuAction | null {
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (grid[index] !== EMPTY) continue;
    const answer = solved[index];
    if (!Number.isInteger(answer) || answer === EMPTY) continue;
    // Any digit in range other than the answer. (`grid[index]` is EMPTY, so
    // there is no already-placed value to avoid.) Drawn from [1, 8]; when that
    // happens to be the answer, `MAX_VALUE` (9) is always a valid substitute.
    const wrong = MIN_VALUE + Math.floor(random() * (MAX_VALUE - MIN_VALUE));
    const value = wrong === answer ? MAX_VALUE : wrong;
    return { kind: "place", index, value };
  }
  return null;
}

export function planAiMoves({
  grid,
  maxMoves = 1,
  difficulty,
  random = Math.random,
}: {
  grid: Grid;
  maxMoves?: number;
  /** easy | normal | hard; anything unrecognised plays the default. */
  difficulty?: unknown;
  random?: () => number;
}): { actions: SudokuAction[]; grid: Grid; completed: boolean } {
  const start = isGrid(grid) ? grid.slice() : emptyGrid();
  const cap = Math.max(0, Math.floor(Number(maxMoves) || 0));
  const solved = cap > 0 ? solveGrid(start) : null;
  if (!solved) {
    return { actions: [], grid: start, completed: start.every((c) => c !== EMPTY) };
  }

  // A weaker tier wastes this turn on a wrong value. Only the FIRST action is
  // ever replaced: the store drives the bot one action at a time, so a mistake
  // is one wasted turn rather than a whole run of them.
  const tier = coerceAiDifficulty(difficulty);
  if (cap > 0 && random() < AI_MISTAKE_RATE[tier]) {
    const wrong = mistakenAction(start, solved, random);
    if (wrong) {
      return { actions: [wrong], grid: start, completed: false };
    }
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
 * The action comes from the derived solution, except when the tier slips (see
 * `AI_MISTAKE_RATE`) — in which case it is a deliberate wrong value the server
 * refuses. Together with the pace (`aiMoveDelayMs`) that is what makes a weaker
 * tier genuinely beatable.
 */
export function chooseAiMove({
  grid,
  difficulty,
  random = Math.random,
}: {
  grid: Grid;
  difficulty?: unknown;
  random?: () => number;
}): SudokuAction | null {
  const plan = planAiMoves({ grid, maxMoves: 1, difficulty, random });
  return plan.actions[0] ?? null;
}
