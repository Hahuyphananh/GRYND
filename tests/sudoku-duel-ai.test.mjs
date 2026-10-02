/**
 * sudoku-duel-ai.test.mjs
 *
 * The Sudoku Duel practice bot: it must DERIVE the shared puzzle's completion
 * from the clues (never read a solution) and play only legal, correct actions,
 * so it genuinely races the human instead of guessing. Plus static checks that
 * the practice match is actually wired (route + store + schema + migration).
 *
 * Run:  npm run test:sudoku-duel
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import { generatePuzzle } from "../src/lib/sudoku-duel/generator.ts";
import {
  AI_MOVE_DELAY_MS,
  aiMoveDelayMs,
  chooseAiMove,
  planAiMoves,
  solveGrid,
} from "../src/lib/sudoku-duel/ai.ts";
import {
  hasNoConflicts,
  isCompleteSolution,
} from "../src/lib/sudoku-duel/rules.ts";
import { CELL_COUNT, EMPTY } from "../src/lib/sudoku-duel/constants.ts";

const read = (path) => readFileSync(path, "utf8");

const puzzle = generatePuzzle({
  seed: 123_456,
  difficulty: "normal",
  variantVersion: 1,
});

test("solveGrid derives a legal completion that matches the generator solution", () => {
  const solved = solveGrid(puzzle.puzzle);
  assert.ok(solved, "the puzzle must be solvable");
  assert.equal(solved.length, CELL_COUNT);
  assert.ok(isCompleteSolution(solved), "the completion must be a legal Sudoku");
  assert.deepEqual(solved, puzzle.solution);
});

test("planAiMoves fills every empty cell with its correct value and completes", () => {
  const plan = planAiMoves({ grid: puzzle.puzzle, maxMoves: CELL_COUNT });
  const empties = puzzle.puzzle.filter((cell) => cell === EMPTY).length;
  assert.equal(plan.actions.length, empties);
  assert.equal(plan.completed, true);
  assert.ok(hasNoConflicts(plan.grid));
  assert.deepEqual(plan.grid, puzzle.solution);

  for (const action of plan.actions) {
    assert.equal(action.kind, "place");
    assert.equal(puzzle.puzzle[action.index], EMPTY, "never writes a clue");
    assert.equal(
      action.value,
      puzzle.solution[action.index],
      "the bot only plays correct values, so it never makes a mistake",
    );
  }
});

test("planAiMoves respects the move cap and never mutates its input", () => {
  const before = puzzle.puzzle.slice();
  const plan = planAiMoves({ grid: puzzle.puzzle, maxMoves: 3 });
  assert.equal(plan.actions.length, 3);
  assert.equal(plan.completed, false);
  assert.deepEqual(puzzle.puzzle, before, "the clue grid must not be mutated");
});

test("the bot solves the puzzle step by step without a single wrong entry", () => {
  let grid = puzzle.puzzle.slice();
  let guard = 0;
  while (grid.includes(EMPTY) && guard < CELL_COUNT) {
    guard += 1;
    const move = chooseAiMove({ grid });
    assert.ok(move, "a move must exist while cells are empty");
    assert.equal(puzzle.puzzle[move.index], EMPTY);
    assert.equal(move.value, puzzle.solution[move.index]);
    grid = grid.slice();
    grid[move.index] = move.value;
  }
  assert.deepEqual(grid, puzzle.solution);
});

test("a solved board has no move left", () => {
  assert.equal(chooseAiMove({ grid: puzzle.solution }), null);
});

test("aiMoveDelayMs paces hard faster than normal faster than easy", () => {
  assert.ok(aiMoveDelayMs("hard") < aiMoveDelayMs("normal"));
  assert.ok(aiMoveDelayMs("normal") < aiMoveDelayMs("easy"));
  assert.equal(aiMoveDelayMs("unknown"), AI_MOVE_DELAY_MS.normal);
});

test("practice wiring: route, store, schema and migration all exist", () => {
  assert.ok(existsSync("src/app/api/sudoku-duel/create-ai/route.ts"));
  const store = read("src/lib/sudoku-duel/serverStore.ts");
  assert.match(store, /export async function createAiMatch\(/);
  assert.match(store, /export async function advanceAiMatch\(/);
  assert.match(store, /advanceAiIfPractice/);
  // The bot's moves are judged by the SAME engine a human's are.
  assert.match(store, /judgeAction\(\{/);
  assert.match(store, /planAiMoves\(\{/);
  assert.match(
    read("src/lib/sudoku-duel/constants.ts"),
    /SUDOKU_DUEL_AI_PLAYER_ID = "sudoku_duel_ai_bot"/,
  );
  assert.match(
    read("src/db/schema.ts"),
    /aiDifficulty: varchar\("ai_difficulty", \{ length: 16 \}\)/,
  );
  assert.ok(existsSync("src/db/migrations/0199_sudoku_duel_ai.sql"));
});
