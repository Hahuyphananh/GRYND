/**
 * sudoku-duel-engine.test.mjs
 *
 * THE AUTHORITATIVE SUDOKU ENGINE, exercised directly (no database, no clock,
 * no I/O). These tests are the contract Phase 1 has to satisfy before any
 * matchmaking, store, rating or UI code is written on top of it.
 *
 * What they are really asserting:
 *
 *   * a puzzle is generated SERVER-SIDE, deterministically, with a valid
 *     solution and (preferably) exactly one — and the solution is never
 *     something a client can see or supply
 *   * a client may only say "place value V at cell I" / "clear cell I": every
 *     other property it attaches — a grid, a solution, a correct-cell count, a
 *     completion flag, a winner, a score, an Elo, a trophy — is never read
 *   * an illegal action is rejected WITHOUT touching the board
 *   * a wrong-but-visible-legal value is ACCEPTED, so the accept/reject channel
 *     cannot be used to probe the hidden solution
 *   * progress, correct-count and completion are all DERIVED from the server's
 *     own givens, board and solution — never taken from a caller
 *
 * Run:  npm run test:sudoku-duel
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_CODES,
  CELL_COUNT,
  EMPTY,
  GIVENS_BY_DIFFICULTY,
  MAX_VALUE,
  MIN_GIVENS,
  MIN_VALUE,
  SIZE,
} from "../src/lib/sudoku-duel/constants.ts";
import {
  applyAction,
  boxIndices,
  boxOf,
  colIndices,
  conflictsAt,
  failureOf,
  findConflicts,
  givenCount,
  hasNoConflicts,
  indexToCol,
  indexToRow,
  initialGrid,
  isBoardSolved,
  isCellIndex,
  isCellValue,
  isCompleteSolution,
  isGiven,
  isGrid,
  normalizeAction,
  peersOf,
  progressOf,
  replayActions,
  rowIndices,
  validateAction,
  viewForState,
  correctAt,
  emptyGrid,
  gridsEqual,
} from "../src/lib/sudoku-duel/rules.ts";
import {
  carvePuzzle,
  coerceSudokuDifficulty,
  countSolutions,
  generatePuzzle,
  generateSolvedGrid,
  givensForSeed,
  hasUniqueSolution,
  isValidPuzzleGrid,
  isSolvable,
  normalizeSeed,
  selectPuzzleForSeed,
  solveGrid,
  targetGivensFor,
  verifyPuzzle,
} from "../src/lib/sudoku-duel/generator.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A well-known, hand-verified complete 9x9 grid (no intercalates). */
const SOLVED = [
  5, 3, 4, 6, 7, 8, 9, 1, 2,
  6, 7, 2, 1, 9, 5, 3, 4, 8,
  1, 9, 8, 3, 4, 2, 5, 6, 7,
  8, 5, 9, 7, 6, 1, 4, 2, 3,
  4, 2, 6, 8, 5, 3, 7, 9, 1,
  7, 1, 3, 9, 2, 4, 8, 5, 6,
  9, 6, 1, 5, 3, 7, 2, 8, 4,
  2, 8, 7, 4, 1, 9, 6, 3, 5,
  3, 4, 5, 2, 8, 6, 1, 7, 9,
];

/** Every 81-length array reachable anywhere inside a value (for leak checks). */
function arraysOf81(value) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (node.length === 81) found.push(node);
      for (const child of node) walk(child);
      return;
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return found;
}

/** A normalized action, applied and asserted to be accepted. */
function play(puzzle, grid, action) {
  const normalized = normalizeAction(action);
  assert.equal(normalized.ok, true, `should normalize: ${JSON.stringify(action)}`);
  const applied = applyAction({ puzzle, grid, action: normalized.action });
  assert.equal(applied.ok, true, `should be legal: ${JSON.stringify(action)}`);
  return applied;
}

/** A normalized action, asserted to be refused with an optional code. */
function refuse(puzzle, grid, action, code = null) {
  const normalized = normalizeAction(action);
  if (!normalized.ok) {
    if (code) assert.equal(normalized.code, code);
    return normalized;
  }
  const applied = applyAction({ puzzle, grid, action: normalized.action });
  assert.equal(applied.ok, false, `should be illegal: ${JSON.stringify(action)}`);
  if (code) assert.equal(applied.code, code);
  return applied;
}

const firstGiven = (grid) => grid.findIndex((value) => value !== EMPTY);

// ── 1. Geometry ───────────────────────────────────────────────────────────

test("geometry: index → row/column and back is lossless", () => {
  for (let index = 0; index < CELL_COUNT; index += 1) {
    assert.equal(indexToRow(index) * SIZE + indexToCol(index), index);
    assert.equal(indexToRow(index) >= 0 && indexToRow(index) < SIZE, true);
    assert.equal(indexToCol(index) >= 0 && indexToCol(index) < SIZE, true);
  }
});

test("geometry: boxOf numbers the nine 3x3 boxes row-major", () => {
  assert.equal(boxOf(0), 0);
  assert.equal(boxOf(8), 2);
  assert.equal(boxOf(40), 4);
  assert.equal(boxOf(72), 6);
  assert.equal(boxOf(80), 8);
  // Every cell in a box shares the same box id.
  for (const index of boxIndices(40)) assert.equal(boxOf(index), boxOf(40));
});

test("geometry: rowIndices / colIndices / boxIndices each have exactly nine cells", () => {
  for (const index of [0, 13, 40, 67, 80]) {
    assert.equal(rowIndices(index).length, SIZE);
    assert.equal(colIndices(index).length, SIZE);
    assert.equal(boxIndices(index).length, SIZE * 1);
    assert.equal(new Set(rowIndices(index)).size, SIZE);
    assert.equal(new Set(colIndices(index)).size, SIZE);
    assert.equal(new Set(boxIndices(index)).size, 9);
  }
});

test("geometry: peersOf is the 20 other cells sharing a row, column or box", () => {
  for (const index of [0, 13, 40, 80]) {
    const peers = peersOf(index);
    assert.equal(peers.length, 20);
    assert.equal(new Set(peers).size, 20);
    assert.equal(peers.includes(index), false, "a cell is not its own peer");
    // Every peer really shares a row, column or box.
    for (const peer of peers) {
      const shares =
        indexToRow(peer) === indexToRow(index) ||
        indexToCol(peer) === indexToCol(index) ||
        boxOf(peer) === boxOf(index);
      assert.equal(shares, true);
    }
  }
});

// ── 2. Shape checks: strict, no coercion ──────────────────────────────────

test("shape: emptyGrid is 81 zeros and a well-formed grid", () => {
  const grid = emptyGrid();
  assert.equal(grid.length, CELL_COUNT);
  assert.equal(grid.every((cell) => cell === EMPTY), true);
  assert.equal(isGrid(grid), true);
});

test("shape: isGrid rejects anything that is not exactly 81 integers in 0..9", () => {
  for (const bad of [
    null,
    undefined,
    42,
    "grid",
    [],
    new Array(80).fill(0),
    new Array(82).fill(0),
    new Array(81).fill("0"),
    new Array(81).fill(2.5),
    new Array(81).fill(NaN),
    new Array(81).fill(Infinity),
    new Array(81).fill(-1),
    new Array(81).fill(10),
    new Array(81).fill(null),
    new Array(81).fill(true),
  ]) {
    assert.equal(isGrid(bad), false, `isGrid must reject ${JSON.stringify(bad)?.slice(0, 24)}`);
  }
});

test("shape: isCellIndex and isCellValue are bounds-checked and never coerce", () => {
  assert.equal(isCellIndex(0), true);
  assert.equal(isCellIndex(CELL_COUNT - 1), true);
  for (const bad of [-1, CELL_COUNT, 3.5, "3", null, NaN, true, {}]) {
    assert.equal(isCellIndex(bad), false, `index ${JSON.stringify(bad)}`);
  }

  assert.equal(isCellValue(MIN_VALUE), true);
  assert.equal(isCellValue(MAX_VALUE), true);
  // 0 means EMPTY and is NOT a placed value.
  for (const bad of [EMPTY, MAX_VALUE + 1, -1, 2.5, "3", null, NaN, true, {}]) {
    assert.equal(isCellValue(bad), false, `value ${JSON.stringify(bad)}`);
  }
});

test("shape: gridsEqual compares cell by cell", () => {
  const a = emptyGrid();
  const b = emptyGrid();
  assert.equal(gridsEqual(a, b), true);
  b[40] = 7;
  assert.equal(gridsEqual(a, b), false);
  assert.equal(gridsEqual(a, [1, 2, 3]), false);
  assert.equal(gridsEqual(null, a), false);
});

test("shape: givenCount and isGiven read only the puzzle", () => {
  const puzzle = emptyGrid();
  puzzle[0] = 1;
  puzzle[40] = 5;
  assert.equal(givenCount(puzzle), 2);
  assert.equal(isGiven(puzzle, 0), true);
  assert.equal(isGiven(puzzle, 1), false);
  assert.equal(isGiven(puzzle, 999), false);
  assert.equal(initialGrid(puzzle)[0], 1);
  assert.notEqual(initialGrid(puzzle), puzzle, "initialGrid must copy");
});

// ── 3. Conflicts (visible-board legality) ─────────────────────────────────

test("conflicts: a duplicate in a row / column / box is reported at both cells", () => {
  const grid = SOLVED.slice();
  grid[1] = grid[0]; // two 5s in row 0
  const conflicts = findConflicts(grid);
  assert.equal(conflicts.includes(0), true);
  assert.equal(conflicts.includes(1), true);
  assert.equal(conflictsAt(grid, 0), true);
  assert.equal(hasNoConflicts(grid), false);

  assert.equal(findConflicts(SOLVED).length, 0);
  assert.equal(hasNoConflicts(SOLVED), true);
  assert.equal(conflictsAt(emptyGrid(), 0), false, "an empty cell never conflicts");
});

// ── 4. Solutions (server-only shapes) ─────────────────────────────────────

test("solutions: isCompleteSolution accepts only a full, conflict-free grid", () => {
  assert.equal(isCompleteSolution(SOLVED), true);
  assert.equal(isCompleteSolution(emptyGrid()), false);
  assert.equal(isCompleteSolution(SOLVED.slice(0, 80)), false);

  const withHole = SOLVED.slice();
  withHole[40] = EMPTY;
  assert.equal(isCompleteSolution(withHole), false, "a hole is not a solution");

  const withDup = SOLVED.slice();
  withDup[1] = withDup[0];
  assert.equal(isCompleteSolution(withDup), false, "a conflict is not a solution");
});

test("solutions: isBoardSolved compares against the authoritative solution", () => {
  assert.equal(isBoardSolved(SOLVED, SOLVED), true);
  const nearly = SOLVED.slice();
  nearly[40] = nearly[40] === 1 ? 2 : 1;
  assert.equal(isBoardSolved(nearly, SOLVED), false);
  assert.equal(isBoardSolved(emptyGrid(), SOLVED), false);
  assert.equal(isBoardSolved(SOLVED, withHole(SOLVED)), false, "a bad solution can never be solved");
});

test("solutions: correctAt judges one value against the hidden answer", () => {
  assert.equal(correctAt(SOLVED, 0, 5), true);
  assert.equal(correctAt(SOLVED, 0, 6), false);
  assert.equal(correctAt(SOLVED, 0, EMPTY), false, "empty is never correct");
  assert.equal(correctAt(SOLVED, 999, 5), false);
});

function withHole(grid) {
  const copy = grid.slice();
  copy[40] = EMPTY;
  return copy;
}

// ── 5. Actions: normalization is strict and strips everything else ────────

test("normalize: a non-object payload is refused with BAD_ACTION", () => {
  for (const bad of [null, undefined, 42, "place", [], true]) {
    const normalized = normalizeAction(bad);
    assert.equal(normalized.ok, false);
    assert.equal(normalized.code, ACTION_CODES.BAD_ACTION);
  }
});

test("normalize: an unknown kind is refused with BAD_ACTION", () => {
  const normalized = normalizeAction({ kind: "solve-everything", index: 0, value: 1 });
  assert.equal(normalized.ok, false);
  assert.equal(normalized.code, ACTION_CODES.BAD_ACTION);
});

test("normalize: out-of-range indices and values are refused with OUT_OF_RANGE", () => {
  for (const bad of [-1, CELL_COUNT, 3.5, "3", null, NaN, true]) {
    const asIndex = normalizeAction({ kind: "place", index: bad, value: 1 });
    assert.equal(asIndex.ok, false, `index ${JSON.stringify(bad)}`);
    assert.equal(asIndex.code, ACTION_CODES.OUT_OF_RANGE);
  }
  for (const bad of [EMPTY, MAX_VALUE + 1, 2.5, "3", null, undefined, NaN]) {
    const asValue = normalizeAction({ kind: "place", index: 0, value: bad });
    assert.equal(asValue.ok, false, `value ${JSON.stringify(bad)}`);
    assert.equal(asValue.code, ACTION_CODES.OUT_OF_RANGE);
  }
});

test("normalize: a well-formed place / clear is accepted and rebuilt fresh", () => {
  const place = normalizeAction({ kind: "place", index: 40, value: 7 });
  assert.equal(place.ok, true);
  assert.deepEqual(place.action, { kind: "place", index: 40, value: 7 });

  const clear = normalizeAction({ kind: "clear", index: 40 });
  assert.equal(clear.ok, true);
  assert.deepEqual(clear.action, { kind: "clear", index: 40 });
});

test("normalize: every smuggled property is dropped, not merged", () => {
  const normalized = normalizeAction({
    kind: "place",
    index: 40,
    value: 7,
    // A whole fabricated world the client is not allowed to author.
    solution: SOLVED,
    puzzle: SOLVED,
    grid: SOLVED,
    correctCells: 81,
    correctEntries: 81,
    completed: true,
    winner: "player1",
    score: 9999,
    elo: 2400,
    trophies: 99,
    ply: 500,
  });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.action, { kind: "place", index: 40, value: 7 });
  assert.equal("solution" in normalized.action, false);
  assert.equal("completed" in normalized.action, false);
  assert.equal("winner" in normalized.action, false);
});

// ── 6. Action validation (against the visible board only) ─────────────────

test("validate: a malformed board or a missing action cannot be applied", () => {
  const puzzle = generatePuzzle({ seed: 1, difficulty: "normal" }).puzzle;
  assert.equal(validateAction({ puzzle: null, grid: puzzle, action: { kind: "clear", index: 0 } }).code, ACTION_CODES.BAD_ACTION);
  assert.equal(validateAction({ puzzle, grid: [1, 2, 3], action: { kind: "clear", index: 0 } }).code, ACTION_CODES.BAD_ACTION);
  const missing = validateAction({ puzzle, grid: puzzle, action: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, ACTION_CODES.OUT_OF_RANGE, "an unusable index is out of range");
});

test("validate: a fixed clue can never be edited", () => {
  const puzzle = generatePuzzle({ seed: 2, difficulty: "normal" }).puzzle;
  const given = firstGiven(puzzle);
  const cleared = validateAction({ puzzle, grid: puzzle, action: { kind: "clear", index: given } });
  assert.equal(cleared.ok, false);
  assert.equal(cleared.code, ACTION_CODES.GIVEN_CELL);

  const placed = validateAction({ puzzle, grid: puzzle, action: { kind: "place", index: given, value: 1 } });
  assert.equal(placed.ok, false);
  assert.equal(placed.code, ACTION_CODES.GIVEN_CELL);
});

test("validate: a value already visible in the row/column/box is refused", () => {
  const puzzle = generatePuzzle({ seed: 3, difficulty: "normal" }).puzzle;
  const empty = puzzle.findIndex((value) => value === EMPTY);
  const clash = puzzle[peersOf(empty).find((peer) => puzzle[peer] !== EMPTY)];
  const result = validateAction({ puzzle, grid: puzzle, action: { kind: "place", index: empty, value: clash } });
  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_CODES.CONFLICT);
});

test("validate: a wrong-but-visible-legal value is ACCEPTED (no solution oracle)", () => {
  const puzzle = generatePuzzle({ seed: 4, difficulty: "normal" });
  const wrongLegal = [];
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (puzzle.puzzle[index] !== EMPTY) continue;
    for (let value = MIN_VALUE; value <= MAX_VALUE; value += 1) {
      if (value === puzzle.solution[index]) continue;
      const result = validateAction({ puzzle: puzzle.puzzle, grid: puzzle.puzzle, action: { kind: "place", index, value } });
      if (result.ok) wrongLegal.push({ index, value });
    }
  }
  // A real puzzle always has at least one locally-legal but globally-wrong
  // placement; accepting it is what stops the accept/reject channel leaking.
  assert.equal(wrongLegal.length > 0, true, "a wrong-but-visible-legal value must exist");

  const sample = wrongLegal[0];
  const applied = applyAction({
    puzzle: puzzle.puzzle,
    grid: puzzle.puzzle,
    action: { kind: "place", index: sample.index, value: sample.value },
  });
  assert.equal(applied.ok, true, "wrong values must be accepted, never refused");
  assert.equal(applied.grid[sample.index], sample.value);
  // …and it is counted as WRONG progress, not as a refusal.
  assert.equal(progressOf(puzzle.puzzle, applied.grid, puzzle.solution).incorrectEntries, 1);
});

test("validate: clearing an empty, non-given cell is legal", () => {
  const puzzle = generatePuzzle({ seed: 5, difficulty: "normal" }).puzzle;
  const empty = puzzle.findIndex((value) => value === EMPTY);
  assert.equal(validateAction({ puzzle, grid: puzzle, action: { kind: "clear", index: empty } }).ok, true);
});

test("failureOf: reads the failure fields off a union (strict:false safety)", () => {
  assert.equal(failureOf({ ok: true }), null);
  assert.deepEqual(failureOf({ ok: false, code: ACTION_CODES.GIVEN_CELL, error: "nope" }), {
    code: ACTION_CODES.GIVEN_CELL,
    error: "nope",
  });
  assert.deepEqual(failureOf({ ok: false }), { code: ACTION_CODES.BAD_ACTION, error: "Invalid action" });
});

// ── 7. Applying actions: isolation and replay ─────────────────────────────

test("apply: a legal action returns a fresh board and never mutates its input", () => {
  const full = generatePuzzle({ seed: 6, difficulty: "normal" });
  const puzzle = full.puzzle;
  const empty = puzzle.findIndex((value) => value === EMPTY);
  // The solution value is conflict-free by definition, so it is always legal.
  const legalValue = full.solution[empty];
  const grid = puzzle.slice();
  const before = grid.slice();

  const applied = play(puzzle, grid, { kind: "place", index: empty, value: legalValue });
  assert.notEqual(applied.grid, grid, "a new board must be returned");
  assert.deepEqual(grid, before, "the caller's board must be untouched");
  assert.equal(applied.grid[empty], legalValue);

  const reverted = play(puzzle, applied.grid, { kind: "clear", index: empty });
  assert.equal(reverted.grid[empty], EMPTY);
  assert.equal(applied.grid[empty], legalValue, "the previous board is untouched");
});

test("apply: an illegal action is refused and produces no board", () => {
  const puzzle = generatePuzzle({ seed: 7, difficulty: "normal" }).puzzle;
  const given = firstGiven(puzzle);
  const applied = refuse(puzzle, puzzle, { kind: "place", index: given, value: 1 }, ACTION_CODES.GIVEN_CELL);
  assert.equal(applied.grid, undefined);
});

test("replay: an accepted action log reproduces the board it produced", () => {
  const puzzle = generatePuzzle({ seed: 8, difficulty: "normal" });
  const empties = [];
  for (let index = 0; index < CELL_COUNT; index += 1) if (puzzle.puzzle[index] === EMPTY) empties.push(index);

  const actions = [];
  let grid = puzzle.puzzle.slice();
  for (const index of empties.slice(0, 5)) {
    const applied = play(puzzle.puzzle, grid, { kind: "place", index, value: puzzle.solution[index] });
    actions.push(applied.action);
    grid = applied.grid;
  }

  const replayed = replayActions({ puzzle: puzzle.puzzle, actions });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.rejectedAt, null);
  assert.deepEqual(replayed.grid, grid);
});

test("replay: a corrupted log is reported rather than silently accepted", () => {
  const puzzle = generatePuzzle({ seed: 9, difficulty: "normal" }).puzzle;
  const given = firstGiven(puzzle);
  const replayed = replayActions({
    puzzle,
    actions: [
      { kind: "clear", index: given }, // illegal: a fixed clue
    ],
  });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.rejectedAt, 0);
});

// ── 8. Progress: only correctly completed cells count ─────────────────────

test("progress: a fresh puzzle starts at zero verified entries", () => {
  const puzzle = generatePuzzle({ seed: 10, difficulty: "normal" });
  const progress = progressOf(puzzle.puzzle, puzzle.puzzle, puzzle.solution);

  assert.equal(progress.correctEntries, 0, "clues never count toward entries");
  assert.equal(progress.filledEntries, 0);
  assert.equal(progress.incorrectEntries, 0);
  assert.equal(progress.emptyEntries, CELL_COUNT - puzzle.givens);
  assert.equal(progress.totalEntries, CELL_COUNT - puzzle.givens);
  assert.equal(progress.correctCells, puzzle.givens, "only the clues are correct so far");
  assert.equal(progress.progressPercent, 0);
  assert.equal(progress.completed, false);
});

test("progress: correct placements advance, wrong placements do not", () => {
  const puzzle = generatePuzzle({ seed: 11, difficulty: "normal" });
  const empties = [];
  for (let index = 0; index < CELL_COUNT; index += 1) if (puzzle.puzzle[index] === EMPTY) empties.push(index);

  const grid = puzzle.puzzle.slice();
  grid[empties[0]] = puzzle.solution[empties[0]]; // correct
  grid[empties[1]] = puzzle.solution[empties[1]] === 1 ? 2 : 1; // wrong (may or may not be legal; progress does not care)

  const progress = progressOf(puzzle.puzzle, grid, puzzle.solution);
  assert.equal(progress.correctEntries, 1);
  assert.equal(progress.incorrectEntries, 1);
  assert.equal(progress.filledEntries, 2);
  assert.equal(
    progress.progressPercent,
    Math.round((1 / progress.totalEntries) * 100),
  );
});

test("progress: a completed board reports 100% and completion only from the solution", () => {
  const puzzle = generatePuzzle({ seed: 12, difficulty: "normal" });
  const progress = progressOf(puzzle.puzzle, puzzle.solution, puzzle.solution);

  assert.equal(progress.correctEntries, progress.totalEntries);
  assert.equal(progress.correctCells, CELL_COUNT);
  assert.equal(progress.emptyEntries, 0);
  assert.equal(progress.incorrectEntries, 0);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.completed, true);
  assert.equal(isBoardSolved(puzzle.solution, puzzle.solution), true);
});

test("progress: a one-cell-from-done board is NOT complete", () => {
  const puzzle = generatePuzzle({ seed: 13, difficulty: "normal" });
  const nearly = puzzle.solution.slice();
  const empty = puzzle.puzzle.findIndex((value) => value === EMPTY);
  nearly[empty] = EMPTY;

  const progress = progressOf(puzzle.puzzle, nearly, puzzle.solution);
  assert.equal(progress.completed, false);
  assert.equal(progress.correctEntries, progress.totalEntries - 1);
  assert.equal(progress.progressPercent, Math.round(((progress.totalEntries - 1) / progress.totalEntries) * 100));
});

test("progress: the givens never inflate the competitive metric", () => {
  const puzzle = generatePuzzle({ seed: 14, difficulty: "easy" });
  const grid = puzzle.puzzle.slice();
  const progress = progressOf(puzzle.puzzle, grid, puzzle.solution);
  // correctCells includes the clues; correctEntries must not.
  assert.equal(progress.correctCells, puzzle.givens);
  assert.equal(progress.correctEntries, 0);
  assert.equal(progress.totalEntries, CELL_COUNT - puzzle.givens);
});

test("progress: a malformed board counts as empty rather than throwing", () => {
  const puzzle = generatePuzzle({ seed: 15, difficulty: "normal" });
  const progress = progressOf(puzzle.puzzle, null, puzzle.solution);
  assert.equal(progress.correctEntries, 0);
  assert.equal(progress.completed, false);
});

// ── 9. The view projection hides the solution ─────────────────────────────

test("view: the solution never leaves the server", () => {
  const puzzle = generatePuzzle({ seed: 16, difficulty: "normal" });
  const empties = [];
  for (let index = 0; index < CELL_COUNT; index += 1) if (puzzle.puzzle[index] === EMPTY) empties.push(index);

  let grid = puzzle.puzzle.slice();
  grid[empties[0]] = puzzle.solution[empties[0]];
  const view = viewForState({ puzzle, grid, ply: 1 });

  assert.equal("solution" in view, false, "there must be no solution field at all");
  // No reachable 81-array may equal the authoritative solution.
  for (const array of arraysOf81(view)) {
    assert.notDeepEqual(array, puzzle.solution, "the solution must never be serialized into a view");
  }
  assert.deepEqual(view.puzzle, puzzle.puzzle, "the givens are public");
  assert.deepEqual(view.entries, grid, "the viewer sees their own board");
});

test("view: conflicts and progress are derived from the board", () => {
  const puzzle = generatePuzzle({ seed: 17, difficulty: "normal" });
  const empties = [];
  for (let index = 0; index < CELL_COUNT; index += 1) if (puzzle.puzzle[index] === EMPTY) empties.push(index);

  const grid = puzzle.puzzle.slice();
  grid[empties[0]] = puzzle.solution[empties[0]];
  const view = viewForState({ puzzle, grid, ply: 3 });

  assert.equal(view.variant, puzzle.variant);
  assert.equal(view.variantVersion, puzzle.variantVersion);
  assert.equal(view.difficulty, "normal");
  assert.equal(view.progress.correctEntries, 1);
  assert.equal(view.completed, false);
  assert.equal(view.ply, 3);
  assert.deepEqual(view.conflicts, findConflicts(grid));
});

test("view: a bare grid (no puzzle metadata) cannot leak a solution", () => {
  const puzzle = generatePuzzle({ seed: 18, difficulty: "normal" }).puzzle;
  const view = viewForState({ puzzle, grid: puzzle });
  assert.equal(view.variant, "");
  assert.equal(view.variantVersion, 0);
  assert.equal(view.completed, false, "without a solution nothing can be complete");
  assert.equal(view.progress.progressPercent, 0);
  assert.equal(view.ply, 0);
});

// ── 10. Difficulty control ────────────────────────────────────────────────

test("difficulty: aliases map onto the canonical tiers, unknown → default", () => {
  assert.equal(coerceSudokuDifficulty("easy"), "easy");
  assert.equal(coerceSudokuDifficulty("NORMAL"), "normal");
  assert.equal(coerceSudokuDifficulty("hard"), "hard");
  assert.equal(coerceSudokuDifficulty("medium"), "normal");
  assert.equal(coerceSudokuDifficulty("casual"), "easy");
  assert.equal(coerceSudokuDifficulty("expert"), "hard");
  assert.equal(coerceSudokuDifficulty("nonsense"), "normal");
  assert.equal(coerceSudokuDifficulty(3), "normal");
});

test("difficulty: higher tiers target fewer clues, floored at the 17-clue minimum", () => {
  assert.equal(targetGivensFor("easy"), GIVENS_BY_DIFFICULTY.easy);
  assert.equal(targetGivensFor("normal"), GIVENS_BY_DIFFICULTY.normal);
  assert.equal(targetGivensFor("hard"), GIVENS_BY_DIFFICULTY.hard);
  assert.equal(targetGivensFor("easy") > targetGivensFor("normal"), true);
  assert.equal(targetGivensFor("normal") > targetGivensFor("hard"), true);
  assert.equal(targetGivensFor("hard") >= MIN_GIVENS, true);
  assert.equal(targetGivensFor(undefined), GIVENS_BY_DIFFICULTY.normal);
});

test("difficulty: normalizeSeed is an unsigned 32-bit integer", () => {
  assert.equal(normalizeSeed(12345), 12345);
  assert.equal(normalizeSeed(-1), 4294967295);
  assert.equal(normalizeSeed(NaN), 0);
  assert.equal(normalizeSeed(Infinity), 0);
  assert.equal(normalizeSeed("nope"), 0);
  assert.equal(normalizeSeed(3.9), 3);
});

// ── 11. Generation: solved grids ──────────────────────────────────────────

test("generate: a solved grid is a valid complete Sudoku and is deterministic", () => {
  for (const seed of [0, 1, 12345, 999999]) {
    const grid = generateSolvedGrid(seed);
    assert.equal(isCompleteSolution(grid), true, `seed ${seed} must yield a complete grid`);
    assert.deepEqual(generateSolvedGrid(seed), grid, "the same seed must reproduce the grid");
  }
});

test("generate: different seeds (generally) yield different grids", () => {
  const grids = new Set([1, 2, 3, 4, 5].map((seed) => generateSolvedGrid(seed).join("")));
  assert.equal(grids.size > 1, true, "the seed must actually vary the grid");
});

test("generate: a solved grid has exactly one solution (itself)", () => {
  const grid = generateSolvedGrid(7);
  assert.equal(countSolutions(grid, 2), 1);
  assert.equal(hasUniqueSolution(grid), true);
  assert.deepEqual(solveGrid(grid), grid);
});

// ── 12. Solver and solution counting ──────────────────────────────────────

test("solver: an empty board has many solutions; countSolutions caps at the limit", () => {
  const blank = emptyGrid();
  assert.equal(isSolvable(blank), true);
  assert.equal(hasUniqueSolution(blank), false);
  assert.equal(countSolutions(blank, 2), 2, "the count stops at the limit");
  assert.equal(countSolutions(blank, 1), 1);
});

test("solver: a conflict-free board with no completion is detected", () => {
  // Row 0 holds 1..8, so cell (0,8) must be 9 — but the 9 in row 1 sits in the
  // same column AND the same box, leaving (0,8) with no candidate at all.
  const dead = emptyGrid();
  [1, 2, 3, 4, 5, 6, 7, 8].forEach((value, i) => {
    dead[i] = value;
  });
  dead[17] = 9;

  assert.deepEqual(findConflicts(dead), [], "the dead end is not a direct conflict");
  assert.equal(isSolvable(dead), false);
  assert.equal(countSolutions(dead, 2), 0);
  assert.equal(solveGrid(dead), null);
});

test("solver: solveGrid reproduces the authoritative solution of real puzzles", () => {
  for (const seed of [21, 22, 23]) {
    for (const difficulty of ["easy", "normal", "hard"]) {
      const puzzle = generatePuzzle({ seed, difficulty });
      const solved = solveGrid(puzzle.puzzle);
      assert.notEqual(solved, null);
      assert.deepEqual(solved, puzzle.solution, `seed ${seed} / ${difficulty}`);
    }
  }
});

// ── 13. Puzzle generation and verification ────────────────────────────────

test("puzzle: each difficulty yields a valid, unique puzzle whose givens match the solution", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    for (const seed of [100, 200, 300]) {
      const puzzle = generatePuzzle({ seed, difficulty });

      assert.equal(puzzle.variant, "classic-9");
      assert.equal(puzzle.variantVersion, 1);
      assert.equal(puzzle.difficulty, difficulty);
      assert.equal(puzzle.seed, seed);
      assert.equal(puzzle.puzzle.length, CELL_COUNT);
      assert.equal(isCompleteSolution(puzzle.solution), true, "the solution must be complete");
      assert.equal(findConflicts(puzzle.puzzle).length, 0, "the givens must not conflict");
      assert.equal(countSolutions(puzzle.puzzle, 2), 1, "the puzzle must have exactly one solution");
      assert.equal(puzzle.givens >= MIN_GIVENS, true, "a unique puzzle cannot have fewer than 17 clues");
      assert.equal(puzzle.givens, givenCount(puzzle.puzzle));

      // Every clue agrees with the authoritative solution; the solution
      // completes every non-clue cell.
      for (let index = 0; index < CELL_COUNT; index += 1) {
        if (puzzle.puzzle[index] !== EMPTY) {
          assert.equal(puzzle.puzzle[index], puzzle.solution[index], "a clue must equal the solution");
        } else {
          assert.equal(isCellValue(puzzle.solution[index]), true, "every solution cell is 1..9");
        }
      }
    }
  }
});

test("puzzle: generation is deterministic — the same seed is the same puzzle", () => {
  const a = generatePuzzle({ seed: 4242, difficulty: "normal" });
  const b = generatePuzzle({ seed: 4242, difficulty: "normal" });
  assert.deepEqual(a, b);

  const viaSelect = selectPuzzleForSeed({ seed: 4242, difficulty: "normal" });
  assert.deepEqual(viaSelect, a);

  const harder = generatePuzzle({ seed: 4242, difficulty: "hard" });
  assert.notDeepEqual(harder.puzzle, a.puzzle, "difficulty must change the puzzle");
});

test("puzzle: both seats derive an identical starting clue set from one seed", () => {
  const seed = 31337;
  const seatOne = generatePuzzle({ seed, difficulty: "normal" });
  const seatTwo = generatePuzzle({ seed, difficulty: "normal" });
  assert.deepEqual(initialGrid(seatOne.puzzle), initialGrid(seatTwo.puzzle));
  assert.equal(seatOne.givens, seatTwo.givens);
});

test("puzzle: higher difficulty gives no more clues than an easier one (same seed)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const easy = generatePuzzle({ seed, difficulty: "easy" }).givens;
    const hard = generatePuzzle({ seed, difficulty: "hard" }).givens;
    assert.equal(easy >= hard, true, `seed ${seed}: easy ${easy} vs hard ${hard}`);
  }
});

test("puzzle: carvePuzzle never drops below a unique solution", () => {
  const solution = generateSolvedGrid(2024);
  const { puzzle, givens } = carvePuzzle({ solution, seed: 2024, targetGivens: MIN_GIVENS });
  assert.equal(countSolutions(puzzle, 2), 1, "carving must preserve uniqueness");
  assert.equal(givens, givenCount(puzzle));
  assert.equal(givens >= MIN_GIVENS, true);
});

test("puzzle: givensForSeed matches the materialised puzzle", () => {
  for (const seed of [50, 60]) {
    assert.equal(givensForSeed(seed, "normal"), generatePuzzle({ seed, difficulty: "normal" }).givens);
  }
});

// ── 14. Verification of bad puzzles ───────────────────────────────────────

test("verify: a generated puzzle with its solution verifies clean", () => {
  const puzzle = generatePuzzle({ seed: 77, difficulty: "normal" });
  assert.deepEqual(verifyPuzzle({ puzzle: puzzle.puzzle, solution: puzzle.solution }), {
    valid: true,
    unique: true,
    hasSolution: true,
    conflicts: [],
  });
  assert.equal(isValidPuzzleGrid(puzzle.puzzle), true);
});

test("verify: a malformed grid is refused", () => {
  for (const bad of [null, undefined, "grid", [1, 2, 3], new Array(81).fill(NaN)]) {
    const result = verifyPuzzle({ puzzle: bad });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "malformed-grid");
  }
});

test("verify: a puzzle whose givens conflict is refused", () => {
  const conflicting = SOLVED.slice();
  conflicting[1] = conflicting[0];
  const result = verifyPuzzle({ puzzle: conflicting });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "given-conflict");
  assert.equal(result.conflicts.length > 0, true);
});

test("verify: a solvable-but-not-unique puzzle is refused as not-unique", () => {
  // The empty board is the extreme case: valid-looking, solvable, never unique.
  const blank = verifyPuzzle({ puzzle: emptyGrid() });
  assert.equal(blank.hasSolution, true);
  assert.equal(blank.unique, false);
  assert.equal(blank.valid, false);
  assert.equal(blank.reason, "not-unique");

  // A nearly-complete real puzzle with one clue removed genuinely has two
  // completions — the shape a client could never be allowed to ship.
  const generated = generatePuzzle({ seed: 1, difficulty: "hard" });
  const twoSolutions = generated.puzzle.slice();
  const given = firstGiven(twoSolutions);
  twoSolutions[given] = EMPTY;

  assert.equal(countSolutions(twoSolutions, 2), 2);
  assert.equal(hasUniqueSolution(twoSolutions), false);
  const result = verifyPuzzle({ puzzle: twoSolutions });
  assert.equal(result.hasSolution, true);
  assert.equal(result.unique, false);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "not-unique");
  assert.equal(isValidPuzzleGrid(twoSolutions), true, "it is still playable — it is just not unique");
});

test("verify: a conflict-free puzzle with no solution is refused as no-solution", () => {
  const dead = emptyGrid();
  [1, 2, 3, 4, 5, 6, 7, 8].forEach((value, i) => {
    dead[i] = value;
  });
  dead[17] = 9;

  const result = verifyPuzzle({ puzzle: dead });
  assert.equal(result.hasSolution, false);
  assert.equal(result.unique, false);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "no-solution");
  assert.equal(isValidPuzzleGrid(dead), false);
});

test("verify: a claimed solution that is not complete, or disagrees, is refused", () => {
  const puzzle = generatePuzzle({ seed: 88, difficulty: "normal" });

  const incompleteClaim = verifyPuzzle({ puzzle: puzzle.puzzle, solution: withHole(puzzle.solution) });
  assert.equal(incompleteClaim.valid, false);
  assert.equal(incompleteClaim.reason, "bad-solution");

  // A complete, valid solution of a DIFFERENT puzzle: still a legal grid, but
  // its values disagree with this puzzle's clues.
  const other = generateSolvedGrid(999);
  const mismatch = verifyPuzzle({ puzzle: puzzle.puzzle, solution: other });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.reason, "given-mismatch");
});

test("verify: isValidPuzzleGrid accepts playable puzzles and rejects junk", () => {
  const puzzle = generatePuzzle({ seed: 99, difficulty: "hard" });
  assert.equal(isValidPuzzleGrid(puzzle.puzzle), true);
  assert.equal(isValidPuzzleGrid(null), false);
  assert.equal(isValidPuzzleGrid([1, 2, 3]), false);
});

console.log("sudoku-duel engine tests loaded");
