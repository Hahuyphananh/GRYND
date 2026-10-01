/**
 * sudoku-duel-rules.test.mjs
 *
 * THE AUTHORITATIVE SERVER ENGINE, exercised directly (no database, no clock, no
 * I/O). What these tests are really asserting:
 *
 *   * a client may only say WHICH CELL AND WHICH VALUE — the board, the correct
 *     count, the mistake count, the penalty, the completion instant and the
 *     winner are all derived by the server
 *   * a CORRECT placement is written; an INCORRECT one is NOT written and never
 *     reveals the answer — it only costs a mistake and a full second
 *   * progress, completion and the race ladder are all derived from the server's
 *     own grid
 *   * the opponent shape is counts-and-status only — no board, no answer
 *
 * Run:  npm run test:sudoku-duel
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MISTAKE_PENALTY_MS,
  RESOLUTION,
  SEAT,
} from "../src/lib/sudoku-duel/constants.ts";
import { generatePuzzle } from "../src/lib/sudoku-duel/generator.ts";
import {
  adjustedFinishAtMs,
  cloneSeatState,
  failureOf,
  hasBothSeats,
  initialStateFromPuzzle,
  isSeat,
  isWellFormedSeatState,
  judgeAction,
  opponentProgressFor,
  otherSeat,
  outcomeFor,
  raceFactsFor,
  resolveSudokuRace,
  seatForUser,
  seatProgressFor,
  userIdForSeat,
} from "../src/lib/sudoku-duel/rules.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

const PUZZLE_SET = generatePuzzle({ seed: 987_654, difficulty: "normal" });
const PUZZLE = PUZZLE_SET.puzzle;
const SOLUTION = PUZZLE_SET.solution;
const EMPTIES = [];
for (let i = 0; i < 81; i += 1) if (PUZZLE[i] === 0) EMPTIES.push(i);
const GIVEN = PUZZLE.findIndex((value) => value !== 0);

/** The clues at ply 0. */
function freshState(overrides = {}) {
  return { ...initialStateFromPuzzle(PUZZLE), ...overrides };
}

/** A board with every non-given cell filled correctly. */
function solvedGrid() {
  const grid = PUZZLE.slice();
  for (const i of EMPTIES) grid[i] = SOLUTION[i];
  return grid;
}

/** A board one correct placement away from completion. */
function oneFromDoneState(overrides = {}) {
  const grid = solvedGrid();
  grid[EMPTIES[EMPTIES.length - 1]] = 0;
  return freshState({ grid, ply: EMPTIES.length - 1, ...overrides });
}

const LAST_CELL = EMPTIES[EMPTIES.length - 1];
const FIRST_CELL = EMPTIES[0];
const wrongValueFor = (index) => (SOLUTION[index] === 1 ? 2 : 1);

function judge(state, action, nowMs = 1_000) {
  return judgeAction({ puzzle: PUZZLE, solution: SOLUTION, state, action, nowMs });
}

// ── 1. Seats ──────────────────────────────────────────────────────────────

test("seats: seatForUser / otherSeat / userIdForSeat round-trip", () => {
  const seats = { player1Id: "alice", player2Id: "bob" };
  assert.equal(seatForUser(seats, "alice"), SEAT.PLAYER1);
  assert.equal(seatForUser(seats, "bob"), SEAT.PLAYER2);
  assert.equal(seatForUser(seats, "mallory"), null);
  assert.equal(seatForUser(seats, null), null);
  assert.equal(otherSeat(SEAT.PLAYER1), SEAT.PLAYER2);
  assert.equal(otherSeat(SEAT.PLAYER2), SEAT.PLAYER1);
  assert.equal(userIdForSeat(seats, SEAT.PLAYER1), "alice");
  assert.equal(userIdForSeat(seats, SEAT.PLAYER2), "bob");
  assert.equal(hasBothSeats(seats), true);
  assert.equal(hasBothSeats({ player1Id: "alice", player2Id: null }), false);
  assert.equal(isSeat("player1"), true);
  assert.equal(isSeat("spectator"), false);
});

// ── 2. Initial state ──────────────────────────────────────────────────────

test("state: both seats open from the SAME clue grid, at ply 0", () => {
  const one = initialStateFromPuzzle(PUZZLE_SET);
  const two = initialStateFromPuzzle(PUZZLE_SET);
  assert.deepEqual(one, two);
  assert.deepEqual(one.grid, PUZZLE);
  assert.equal(one.ply, 0);
  assert.equal(one.mistakes, 0);
  assert.equal(one.penaltyMs, 0);
  assert.equal(one.completed, false);
  assert.equal(isWellFormedSeatState(one), true);
  assert.notEqual(one.grid, PUZZLE, "the board must be a copy, not the puzzle itself");

  assert.equal(isWellFormedSeatState(null), false);
  assert.equal(isWellFormedSeatState({ grid: [1, 2, 3], ply: 0 }), false);
  assert.equal(isWellFormedSeatState({ grid: PUZZLE, ply: -1 }), false);
  assert.equal(isWellFormedSeatState({ grid: PUZZLE, ply: 1.5 }), false);
});

test("state: cloneSeatState never aliases the caller's board", () => {
  const state = freshState({ mistakes: 3, penaltyMs: 3_000 });
  const copy = cloneSeatState(state);
  copy.grid[FIRST_CELL] = 9;
  copy.mistakes = 99;
  assert.equal(state.grid[FIRST_CELL], 0);
  assert.equal(state.mistakes, 3);
});

// ── 3. The judge — correct, incorrect, cleared ────────────────────────────

test("judge: a CORRECT placement is written, advances progress and burns a ply", () => {
  const state = freshState();
  const result = judge(state, { kind: "place", index: FIRST_CELL, value: SOLUTION[FIRST_CELL] });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "correct");
  assert.equal(result.correct, true);
  assert.equal(result.state.grid[FIRST_CELL], SOLUTION[FIRST_CELL]);
  assert.equal(result.state.ply, 1);
  assert.equal(result.state.mistakes, 0);
  assert.equal(result.state.penaltyMs, 0);
  assert.equal(result.progress.correctEntries, 1);
  assert.equal(result.state.progressAtMs, 1_000, "the achievement instant is stamped");
  assert.equal(result.state.completed, false);

  // The caller's state is untouched.
  assert.equal(state.grid[FIRST_CELL], 0);
  assert.equal(state.ply, 0);
});

test("judge: an INCORRECT placement is NOT written and does NOT reveal the answer", () => {
  const state = freshState();
  const wrong = wrongValueFor(FIRST_CELL);
  const result = judge(state, { kind: "place", index: FIRST_CELL, value: wrong });

  assert.equal(result.ok, true, "a wrong value is an accepted action, not a refusal");
  assert.equal(result.verdict, "incorrect");
  assert.equal(result.correct, false);
  // The value is discarded and the answer is not placed.
  assert.equal(result.state.grid[FIRST_CELL], 0);
  assert.notEqual(result.state.grid[FIRST_CELL], SOLUTION[FIRST_CELL]);
  // The mistake and its penalty move; progress does not.
  assert.equal(result.state.ply, 1);
  assert.equal(result.state.mistakes, 1);
  assert.equal(result.state.penaltyMs, MISTAKE_PENALTY_MS);
  assert.equal(result.progress.correctEntries, 0);
  assert.equal(result.state.progressAtMs, null, "a mistake never counts as progress");
  assert.equal(result.state.completed, false);
});

test("judge: mistakes accumulate, so the penalty is 1s per mistake", () => {
  let state = freshState();
  for (let n = 0; n < 3; n += 1) {
    const result = judge(state, { kind: "place", index: FIRST_CELL, value: wrongValueFor(FIRST_CELL) });
    state = result.state;
  }
  assert.equal(state.mistakes, 3);
  assert.equal(state.penaltyMs, 3 * MISTAKE_PENALTY_MS);
  assert.equal(state.ply, 3);
  assert.equal(state.grid[FIRST_CELL], 0);
});

test("judge: a CLEAR removes a correct entry and burns a ply", () => {
  const placed = judge(freshState(), { kind: "place", index: FIRST_CELL, value: SOLUTION[FIRST_CELL] });
  const cleared = judge(placed.state, { kind: "clear", index: FIRST_CELL });
  assert.equal(cleared.verdict, "cleared");
  assert.equal(cleared.state.grid[FIRST_CELL], 0);
  assert.equal(cleared.state.ply, 2);
  assert.equal(cleared.progress.correctEntries, 0);
});

test("judge: a clue cell, a repeat, an empty clear and bad ranges are refused", () => {
  const state = freshState();

  const clue = judge(state, { kind: "place", index: GIVEN, value: 1 });
  assert.equal(clue.ok, false);
  assert.equal(clue.code, "GIVEN_CELL");

  const outValue = judge(state, { kind: "place", index: FIRST_CELL, value: 10 });
  assert.equal(outValue.ok, false);
  assert.equal(outValue.code, "OUT_OF_RANGE");

  const outIndex = judge(state, { kind: "place", index: 999, value: 1 });
  assert.equal(outIndex.ok, false);
  assert.equal(outIndex.code, "OUT_OF_RANGE");

  const nothingToClear = judge(state, { kind: "clear", index: FIRST_CELL });
  assert.equal(nothingToClear.ok, false);
  assert.equal(nothingToClear.code, "NOTHING_TO_CLEAR");

  const placed = judge(state, { kind: "place", index: FIRST_CELL, value: SOLUTION[FIRST_CELL] });
  const repeat = judge(placed.state, { kind: "place", index: FIRST_CELL, value: SOLUTION[FIRST_CELL] });
  assert.equal(repeat.ok, false);
  assert.equal(repeat.code, "ALREADY_PLACED");

  const badBoard = judge({ grid: [1, 2, 3], ply: 0 }, { kind: "clear", index: 0 });
  assert.equal(badBoard.ok, false);
  assert.equal(badBoard.code, "BAD_ACTION");

  assert.deepEqual(failureOf(clue), { code: "GIVEN_CELL", error: clue.error });
});

// ── 4. Completion ─────────────────────────────────────────────────────────

test("completion: the final correct placement completes the board and stamps the instant", () => {
  const state = oneFromDoneState();
  const result = judge(
    state,
    { kind: "place", index: LAST_CELL, value: SOLUTION[LAST_CELL] },
    12_345,
  );

  assert.equal(result.verdict, "correct");
  assert.equal(result.state.completed, true);
  assert.equal(result.state.completedAtMs, 12_345, "the completion instant is server-stamped");
  assert.equal(result.progress.correctEntries, EMPTIES.length);
  assert.equal(result.progress.progressPercent, 100);
  assert.equal(result.progress.completed, true);
});

test("completion: an incidental correct entry does not complete the board", () => {
  const result = judge(freshState(), { kind: "place", index: FIRST_CELL, value: SOLUTION[FIRST_CELL] });
  assert.equal(result.state.completed, false);
  assert.equal(result.state.completedAtMs, null);
});

test("progress: the givens never inflate the competitive metric", () => {
  const fresh = seatProgressFor(PUZZLE, SOLUTION, freshState());
  assert.equal(fresh.correctCells, 0, "clues do not count as progress");
  assert.equal(fresh.progressPercent, 0);

  const done = seatProgressFor(PUZZLE, SOLUTION, oneFromDoneState({ completed: true }));
  assert.equal(done.correctCells, EMPTIES.length - 1);
  assert.equal(done.progressPercent, Math.round(((EMPTIES.length - 1) / EMPTIES.length) * 100));
});

// ── 5. The opponent projection ────────────────────────────────────────────

test("opponent: counts and status only — never a grid, an entry or an answer", () => {
  const result = judge(freshState(), { kind: "place", index: FIRST_CELL, value: SOLUTION[FIRST_CELL] });
  const opponent = opponentProgressFor(SEAT.PLAYER2, PUZZLE, SOLUTION, result.state);

  assert.equal(opponent.seatKey, SEAT.PLAYER2);
  assert.equal(opponent.correctCells, 1);
  assert.equal(opponent.mistakes, 0);
  assert.equal(opponent.completed, false);
  for (const key of ["grid", "entries", "solution", "puzzle", "moves", "board"]) {
    assert.equal(key in opponent, false, `${key} must not be in OpponentProgress`);
  }
});

// ── 6. The race ladder ────────────────────────────────────────────────────

const race = (overrides = {}) => ({
  userId: "u",
  ply: 0,
  correctCells: 0,
  mistakes: 0,
  penaltyMs: 0,
  completedAtMs: null,
  progressAtMs: null,
  forfeited: false,
  ...overrides,
});

test("race: a live race resolves to nothing", () => {
  assert.equal(resolveSudokuRace({ player1: race(), player2: race() }), null);
});

test("race: a single completion wins immediately", () => {
  const outcome = resolveSudokuRace({
    player1: race({ completedAtMs: 5_000, correctCells: EMPTIES.length }),
    player2: race({ correctCells: 10, ply: 10 }),
  });
  assert.deepEqual(outcome, { result: "player1", resolution: RESOLUTION.FINISH });
});

test("race: with two completions the LOWER ADJUSTED time wins", () => {
  // p1 finished 1s earlier but made 5 mistakes (+5s) — p2 still wins.
  const slower = race({ completedAtMs: 10_000, penaltyMs: 5_000 }); // adjusted 15_000
  const better = race({ completedAtMs: 11_000, penaltyMs: 0 }); // adjusted 11_000
  assert.deepEqual(resolveSudokuRace({ player1: slower, player2: better }), {
    result: "player2",
    resolution: RESOLUTION.FINISH,
  });
  assert.deepEqual(resolveSudokuRace({ player1: better, player2: slower }), {
    result: "player1",
    resolution: RESOLUTION.FINISH,
  });
});

test("race: an adjusted tie falls back to the earlier server completion instant", () => {
  const outcome = resolveSudokuRace({
    player1: race({ completedAtMs: 20_000, penaltyMs: 0 }), // adjusted 20_000
    player2: race({ completedAtMs: 21_000, penaltyMs: 1_000 }), // adjusted 20_000
  });
  assert.deepEqual(outcome, { result: "player1", resolution: RESOLUTION.FINISH });
});

test("race: an exact tie on both figures is a draw", () => {
  const outcome = resolveSudokuRace({
    player1: race({ completedAtMs: 20_000, penaltyMs: 1_000 }),
    player2: race({ completedAtMs: 20_000, penaltyMs: 1_000 }),
  });
  assert.deepEqual(outcome, { result: "draw", resolution: RESOLUTION.DRAW });
});

test("race: a forfeit decides for the opponent whatever the boards say", () => {
  const outcome = resolveSudokuRace({
    player1: race({ forfeited: true, correctCells: 80, completedAtMs: 1_000 }),
    player2: race({ correctCells: 1, ply: 1 }),
    deadlineReached: true,
  });
  assert.deepEqual(outcome, { result: "player2", resolution: RESOLUTION.FORFEIT });
});

test("race: at the deadline the most correct cells wins", () => {
  const outcome = resolveSudokuRace({
    player1: race({ correctCells: 40, ply: 50 }),
    player2: race({ correctCells: 41, ply: 50 }),
    deadlineReached: true,
  });
  assert.deepEqual(outcome, { result: "player2", resolution: RESOLUTION.DEADLINE });
});

test("race: ties on cells are broken by fewest mistakes", () => {
  const outcome = resolveSudokuRace({
    player1: race({ correctCells: 40, mistakes: 1, ply: 50 }),
    player2: race({ correctCells: 40, mistakes: 4, ply: 50 }),
    deadlineReached: true,
  });
  assert.deepEqual(outcome, { result: "player1", resolution: RESOLUTION.DEADLINE });
});

test("race: ties on cells and mistakes are broken by the earliest achievement", () => {
  const outcome = resolveSudokuRace({
    player1: race({ correctCells: 40, mistakes: 2, progressAtMs: 9_000, ply: 50 }),
    player2: race({ correctCells: 40, mistakes: 2, progressAtMs: 8_000, ply: 50 }),
    deadlineReached: true,
  });
  assert.deepEqual(outcome, { result: "player2", resolution: RESOLUTION.DEADLINE });
});

test("race: an exact tie at the deadline is a draw", () => {
  const outcome = resolveSudokuRace({
    player1: race({ correctCells: 7, mistakes: 2, progressAtMs: 5_000, ply: 9 }),
    player2: race({ correctCells: 7, mistakes: 2, progressAtMs: 5_000, ply: 11 }),
    deadlineReached: true,
  });
  assert.deepEqual(outcome, { result: "draw", resolution: RESOLUTION.DRAW });
});

test("race: a seat that never acted loses to one that did", () => {
  const outcome = resolveSudokuRace({
    player1: race({ ply: 0 }),
    player2: race({ ply: 3, correctCells: 3, progressAtMs: 4_000 }),
    deadlineReached: true,
  });
  assert.deepEqual(outcome, { result: "player2", resolution: RESOLUTION.FORFEIT });
});

// ── 7. Derivations ────────────────────────────────────────────────────────

test("race: raceFactsFor reads the seat's stored board and instants", () => {
  const result = judge(oneFromDoneState(), { kind: "place", index: LAST_CELL, value: SOLUTION[LAST_CELL] }, 7_000);
  const facts = raceFactsFor({
    userId: "alice",
    state: result.state,
    puzzle: PUZZLE,
    solution: SOLUTION,
  });
  assert.equal(facts.userId, "alice");
  assert.equal(facts.correctCells, EMPTIES.length);
  assert.equal(facts.completedAtMs, 7_000);
  assert.equal(facts.mistakes, 0);
  assert.equal(adjustedFinishAtMs(facts), 7_000);
  assert.equal(adjustedFinishAtMs({ completedAtMs: 7_000, penaltyMs: 2_000 }), 9_000);
  assert.equal(adjustedFinishAtMs({ completedAtMs: null, penaltyMs: 0 }), null);
});

test("outcome: the viewer's result is derived from the seat and the result", () => {
  assert.equal(outcomeFor(SEAT.PLAYER1, "player1"), "win");
  assert.equal(outcomeFor(SEAT.PLAYER1, "player2"), "loss");
  assert.equal(outcomeFor(SEAT.PLAYER2, "player1"), "loss");
  assert.equal(outcomeFor(SEAT.PLAYER2, "draw"), "draw");
  assert.equal(outcomeFor(null, "player1"), null);
  assert.equal(outcomeFor(SEAT.PLAYER1, "tie"), null);
});
