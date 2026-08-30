/**
 * Mines Duel ("Mines PvP") — engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers
 * in `src/lib/mines-pvp/constants.js`. The board generator and the
 * outcome/payout math are the contract every other piece of the match
 * system depends on, so they're tested exhaustively (valid + invalid
 * inputs, edge cases at the boundaries).
 *
 * The flow-level (DB-backed) tests for `createOrJoin`, `pickTile`, and
 * `fetchMatchWithAutoResolve` live in `tests/mines-pvp-flow.test.mjs`.
 *
 * Run:  node --test tests/mines-pvp-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  // Board geometry
  GRID_SIZE,
  GRID_CELLS,
  MIN_MINES,
  MAX_MINES,
  // Per-turn window
  ROUND_TIMER_SECONDS,
  ROUND_PICK_DEADLINE_MS,
  // Stake matchmaking
  STAKE_PRESETS,
  MIN_STAKE,
  MAX_STAKE,
  // House fee / payout split
  HOUSE_FEE_PCT,
  WINNER_RATIO,
  HOUSE_RATIO,
  // State machine
  MATCH_STATUS,
  ACTIVE_STATES,
  PICKABLE_STATES,
  TERMINAL_STATES,
  READY_WINDOW_MS,
  FINISHED_GRACE_MS,
  // Advisory-lock namespace
  MINES_PVP_LOCK_NAMESPACE,
  // Result + pick constants
  RESULT,
  PICK_KIND,
  // No-guess board machinery
  SENSIBLE_FIRST_PICKS,
  CENTER_FIRST_PICK,
  CENTER_BLOCK,
  CENTER_BLOCK_SET,
  chebyshevDistance,
  relocateMine,
  ejectMinesFromCenter,
  simulateSolvability,
  generateSolvableBoard,
  // Pure helpers under test
  generateBoard,
  isMine,
  nearestMineDistance,
  decideOutcome,
  computePayout,
  pickRandomCell,
  round2,
  cellIndexToRowCol,
  rowColToCellIndex,
  seatForPickNumber,
  activeSeatForMatch,
  activePickerForMatch,
} from "../src/lib/mines-pvp/constants.js";

// ════════════════════════════════════════════════════════════════════════
// Board geometry constants
// ════════════════════════════════════════════════════════════════════════

test("GRID_SIZE is 5 (matches solo-mines 5x5 layout)", () => {
  assert.equal(GRID_SIZE, 5);
});

test("GRID_CELLS is 25 (5*5)", () => {
  assert.equal(GRID_CELLS, 25);
  assert.equal(GRID_CELLS, GRID_SIZE * GRID_SIZE);
});

test("MIN_MINES is 1 (at least 1 mine so the game has stakes)", () => {
  assert.equal(MIN_MINES, 1);
});

test("MAX_MINES is GRID_CELLS - 1 (24 — never allow 25 instant-loss)", () => {
  assert.equal(MAX_MINES, 24);
  assert.equal(MAX_MINES, GRID_CELLS - 1);
});

// ════════════════════════════════════════════════════════════════════════
// Per-turn window
// ════════════════════════════════════════════════════════════════════════

test("ROUND_TIMER_SECONDS is 20 (mirrors blackjack-pvp pacing)", () => {
  assert.equal(ROUND_TIMER_SECONDS, 20);
});

test("ROUND_PICK_DEADLINE_MS is 20000 (20 seconds in ms)", () => {
  assert.equal(ROUND_PICK_DEADLINE_MS, 20_000);
  assert.equal(ROUND_PICK_DEADLINE_MS, ROUND_TIMER_SECONDS * 1000);
});

// ════════════════════════════════════════════════════════════════════════
// Stake matchmaking constants
// ════════════════════════════════════════════════════════════════════════

test("STAKE_PRESETS match the chip row used by blackjack-pvp / roulette-pvp", () => {
  assert.deepEqual(STAKE_PRESETS, [10, 25, 50, 100, 250, 500]);
});

test("MIN_STAKE is 1", () => {
  assert.equal(MIN_STAKE, 1);
});

test("MAX_STAKE is 1,000,000 (one million cap)", () => {
  assert.equal(MAX_STAKE, 100_000); // economy cap (GLOBAL_MAX_BET)
});

// ════════════════════════════════════════════════════════════════════════
// House fee / payout split (per user spec: 90/10 on the LOSER's stake)
// ════════════════════════════════════════════════════════════════════════

test("HOUSE_FEE_PCT is 0.10 (10% rake)", () => {
  assert.equal(HOUSE_FEE_PCT, 0.10);
});

test("WINNER_RATIO is 0.90 (winner takes 90% of the loser's stake)", () => {
  assert.equal(WINNER_RATIO, 0.90);
});

test("HOUSE_RATIO is 0.10 (house takes 10% of the loser's stake)", () => {
  assert.equal(HOUSE_RATIO, 0.10);
});

test("WINNER_RATIO + HOUSE_RATIO sum to 1.0 (full loser's stake is split)", () => {
  assert.equal(WINNER_RATIO + HOUSE_RATIO, 1.0);
});

// ════════════════════════════════════════════════════════════════════════
// Status state machine
// ════════════════════════════════════════════════════════════════════════

test("MATCH_STATUS contains the six expected states", () => {
  assert.equal(MATCH_STATUS.WAITING, "waiting");
  assert.equal(MATCH_STATUS.READY, "ready");
  assert.equal(MATCH_STATUS.P1_TURN, "p1_turn");
  assert.equal(MATCH_STATUS.P2_TURN, "p2_turn");
  assert.equal(MATCH_STATUS.FINISHED, "finished");
  assert.equal(MATCH_STATUS.CANCELLED, "cancelled");
});

test("MATCH_STATUS is frozen (immutable at runtime)", () => {
  assert.equal(Object.isFrozen(MATCH_STATUS), true);
});

test("ACTIVE_STATES includes ready / p1_turn / p2_turn (excludes waiting)", () => {
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.READY), true);
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.P1_TURN), true);
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.P2_TURN), true);
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.WAITING), false);
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.FINISHED), false);
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.CANCELLED), false);
});

test("PICKABLE_STATES is a strict subset of ACTIVE_STATES (no ready banner picks)", () => {
  for (const state of PICKABLE_STATES) {
    assert.equal(ACTIVE_STATES.has(state), true, `${state} should be in ACTIVE_STATES`);
  }
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.P1_TURN), true);
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.P2_TURN), true);
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.READY), false, "ready banner doesn't accept picks");
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.WAITING), false, "no opponent yet");
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.FINISHED), false, "terminal state");
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.CANCELLED), false, "terminal state");
});

test("TERMINAL_STATES is finished + cancelled", () => {
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.FINISHED), true);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.CANCELLED), true);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.WAITING), false);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.READY), false);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.P1_TURN), false);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.P2_TURN), false);
});

test("ACTIVE_STATES and TERMINAL_STATES are disjoint (no double-classification)", () => {
  for (const state of ACTIVE_STATES) {
    assert.equal(TERMINAL_STATES.has(state), false, `${state} should not be in both`);
  }
  for (const state of TERMINAL_STATES) {
    assert.equal(ACTIVE_STATES.has(state), false, `${state} should not be in both`);
  }
});

test("READY_WINDOW_MS is 3 seconds (3s 'Get ready' banner)", () => {
  assert.equal(READY_WINDOW_MS, 3000);
});

test("FINISHED_GRACE_MS is 5 seconds (post-finish grace before lobby nav)", () => {
  assert.equal(FINISHED_GRACE_MS, 5000);
});

// ════════════════════════════════════════════════════════════════════════
// Advisory-lock namespace
// ════════════════════════════════════════════════════════════════════════

test("MINES_PVP_LOCK_NAMESPACE is a positive 31-bit integer (Postgres bigint-safe)", () => {
  assert.equal(Number.isInteger(MINES_PVP_LOCK_NAMESPACE), true);
  assert.ok(MINES_PVP_LOCK_NAMESPACE > 0, "should be positive");
  assert.ok(
    MINES_PVP_LOCK_NAMESPACE <= 0x7fffffff,
    "should fit in a positive 31-bit signed int",
  );
});

// ════════════════════════════════════════════════════════════════════════
// RESULT / PICK_KIND enums
// ════════════════════════════════════════════════════════════════════════

test("RESULT is frozen with player1 / player2 / draw", () => {
  assert.equal(Object.isFrozen(RESULT), true);
  assert.equal(RESULT.PLAYER1, "player1");
  assert.equal(RESULT.PLAYER2, "player2");
  assert.equal(RESULT.DRAW, "draw");
});

test("PICK_KIND is frozen with mine / safe", () => {
  assert.equal(Object.isFrozen(PICK_KIND), true);
  assert.equal(PICK_KIND.MINE, "mine");
  assert.equal(PICK_KIND.SAFE, "safe");
});

// ════════════════════════════════════════════════════════════════════════
// generateBoard
// ════════════════════════════════════════════════════════════════════════

test("generateBoard: 1 mine returns a valid 1-mine board", () => {
  for (let i = 0; i < 50; i += 1) {
    const board = generateBoard(1);
    assert.equal(board.size, 5);
    assert.equal(board.mines.length, 1);
    assert.ok(board.mines[0] >= 0 && board.mines[0] < GRID_CELLS);
  }
});

test("generateBoard: 12 mines returns a valid 12-mine board", () => {
  const board = generateBoard(12);
  assert.equal(board.size, 5);
  assert.equal(board.mines.length, 12);
});

test("generateBoard: 24 mines (max) returns a valid 24-mine board", () => {
  const board = generateBoard(24);
  assert.equal(board.size, 5);
  assert.equal(board.mines.length, 24);
});

test("generateBoard: mines are unique (no duplicate cells)", () => {
  for (let i = 0; i < 100; i += 1) {
    const board = generateBoard(12);
    const seen = new Set();
    for (const idx of board.mines) {
      assert.equal(seen.has(idx), false, `duplicate mine cell ${idx}`);
      seen.add(idx);
    }
  }
});

test("generateBoard: mines are sorted ascending (deterministic ordering for storage)", () => {
  for (let i = 0; i < 50; i += 1) {
    const board = generateBoard(15);
    for (let j = 1; j < board.mines.length; j += 1) {
      assert.ok(
        board.mines[j] > board.mines[j - 1],
        `mines should be sorted ascending; got ${board.mines[j - 1]} before ${board.mines[j]}`,
      );
    }
  }
});

test("generateBoard: all mine indices are within 0..GRID_CELLS-1", () => {
  for (let i = 0; i < 100; i += 1) {
    const board = generateBoard(20);
    for (const idx of board.mines) {
      assert.ok(Number.isInteger(idx), `mine ${idx} is not an integer`);
      assert.ok(idx >= 0 && idx < GRID_CELLS, `mine ${idx} is out of range`);
    }
  }
});

test("generateBoard: distribution is roughly uniform (each cell appears ~count/25 times in 1000 trials)", () => {
  const counts = new Array(GRID_CELLS).fill(0);
  const trials = 1000;
  for (let i = 0; i < trials; i += 1) {
    const board = generateBoard(5);
    for (const idx of board.mines) counts[idx] += 1;
  }
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    assert.ok(
      counts[cell] > 100 && counts[cell] < 320,
      `cell ${cell} hit ${counts[cell]} times — out of expected range`,
    );
  }
});

test("generateBoard: 0 mines throws RangeError", () => {
  assert.throws(() => generateBoard(0), RangeError);
});

test("generateBoard: 25 mines throws RangeError (instant-loss not allowed)", () => {
  assert.throws(() => generateBoard(25), RangeError);
});

test("generateBoard: 100 mines throws RangeError", () => {
  assert.throws(() => generateBoard(100), RangeError);
});

test("generateBoard: -1 mines throws RangeError", () => {
  assert.throws(() => generateBoard(-1), RangeError);
});

test("generateBoard: non-integer (1.5) throws RangeError", () => {
  assert.throws(() => generateBoard(1.5), RangeError);
});

test("generateBoard: NaN throws RangeError", () => {
  assert.throws(() => generateBoard(NaN), RangeError);
});

test("generateBoard: numeric string is coerced (no throw for '5')", () => {
  const board = generateBoard("5");
  assert.equal(board.mines.length, 5);
  assert.throws(() => generateBoard("abc"), RangeError);
  assert.throws(() => generateBoard("1.5"), RangeError);
});

test("generateBoard: error message mentions valid range", () => {
  try {
    generateBoard(99);
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof RangeError, "should be RangeError");
    assert.ok(err.message.includes(String(MIN_MINES)), "should mention min");
    assert.ok(err.message.includes(String(MAX_MINES)), "should mention max");
  }
});

// ════════════════════════════════════════════════════════════════════════
// isMine
// ════════════════════════════════════════════════════════════════════════

test("isMine: returns true for a cell listed in board.mines", () => {
  const board = generateBoard(3);
  for (const idx of board.mines) {
    assert.equal(isMine(board, idx), true);
  }
});

test("isMine: returns false for a cell NOT in board.mines", () => {
  const board = generateBoard(3);
  const mineSet = new Set(board.mines);
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    if (!mineSet.has(cell)) {
      assert.equal(isMine(board, cell), false);
    }
  }
});

test("isMine: out-of-range cell returns false (defence-in-depth)", () => {
  const board = generateBoard(3);
  assert.equal(isMine(board, -1), false);
  assert.equal(isMine(board, GRID_CELLS), false);
  assert.equal(isMine(board, 9999), false);
});

test("isMine: non-integer cell returns false (defence-in-depth)", () => {
  const board = generateBoard(3);
  assert.equal(isMine(board, 1.5), false);
  assert.equal(isMine(board, "5"), false);
  assert.equal(isMine(board, null), false);
  assert.equal(isMine(board, undefined), false);
});

test("isMine: null board returns false", () => {
  assert.equal(isMine(null, 0), false);
  assert.equal(isMine(undefined, 0), false);
});

test("isMine: board with no mines array returns false", () => {
  assert.equal(isMine({}, 5), false);
  assert.equal(isMine({ mines: "not-an-array" }, 5), false);
});

// ════════════════════════════════════════════════════════════════════════
// nearestMineDistance — the private minesweeper-style hint
// ════════════════════════════════════════════════════════════════════════

test("nearestMineDistance: touching a mine (any of the 8 cells) is distance 1", () => {
  // Center cell 12 (row 2, col 2) with mines at 6 (diag), 13 (right),
  // 17 (below) — all adjacent.
  assert.equal(nearestMineDistance({ size: 5, mines: [6, 13, 17] }, 12), 1);
  // A mine ON the cell itself is distance 0 (only reachable
  // post-match — safe picks always return >= 1).
  assert.equal(nearestMineDistance({ size: 5, mines: [12] }, 12), 0);
});

test("nearestMineDistance: reports the CLOSEST mine (Chebyshev tiles)", () => {
  // Mines at 0 (0,0) and 18 (3,3). Cell 12 (2,2): cheb to 0 = 2,
  // cheb to 18 = 1 -> 1.
  assert.equal(nearestMineDistance({ size: 5, mines: [0, 18] }, 12), 1);
  // Single mine at 0 (0,0). Cell 24 (4,4) is 4 tiles away.
  assert.equal(nearestMineDistance({ size: 5, mines: [0] }, 24), 4);
  // Mines [0,1,2] (top row). Cell 7 (1,2): nearest = 1 (touches 1/2).
  assert.equal(nearestMineDistance({ size: 5, mines: [0, 1, 2] }, 7), 1);
  // Same board, cell 12 (2,2): nearest = 2 tiles below the top row.
  assert.equal(nearestMineDistance({ size: 5, mines: [0, 1, 2] }, 12), 2);
  // Cell 0 is the mine itself -> 0.
  assert.equal(nearestMineDistance({ size: 5, mines: [0, 1, 2] }, 0), 0);
});

test("nearestMineDistance: defensive inputs return null", () => {
  assert.equal(nearestMineDistance(null, 0), null);
  assert.equal(nearestMineDistance({}, 0), null);
  assert.equal(nearestMineDistance({ mines: "not-an-array" }, 0), null);
  assert.equal(nearestMineDistance({ mines: [] }, 0), null);
  assert.equal(nearestMineDistance({ mines: [0] }, -1), null);
  assert.equal(nearestMineDistance({ mines: [0] }, 99), null);
  assert.equal(nearestMineDistance({ mines: [0] }, 1.5), null);
});

// ════════════════════════════════════════════════════════════════════════
// No-guess board machinery — constants, mercy, solver, generator
// ════════════════════════════════════════════════════════════════════════

test("SENSIBLE_FIRST_PICKS = center + the four corners", () => {
  assert.deepEqual(SENSIBLE_FIRST_PICKS, [12, 0, 4, 20, 24]);
});

test("CENTER_FIRST_PICK is the center cell (row 2, col 2)", () => {
  assert.equal(CENTER_FIRST_PICK, 12);
  assert.deepEqual(cellIndexToRowCol(CENTER_FIRST_PICK), { row: 2, col: 2 });
});

test("CENTER_BLOCK is the 3x3 block around the center (9 cells)", () => {
  assert.equal(CENTER_BLOCK.length, 9);
  assert.deepEqual(
    [...CENTER_BLOCK].sort((a, b) => a - b),
    [6, 7, 8, 11, 12, 13, 16, 17, 18],
  );
  assert.equal(CENTER_BLOCK_SET.size, 9);
  assert.equal(CENTER_BLOCK_SET.has(12), true);
  assert.equal(CENTER_BLOCK_SET.has(0), false);
  assert.equal(CENTER_BLOCK_SET.has(24), false);
});

test("chebyshevDistance: king-move distance between cells", () => {
  // Same cell -> 0
  assert.equal(chebyshevDistance(12, 12), 0);
  // Orthogonal neighbour -> 1
  assert.equal(chebyshevDistance(7, 12), 1);
  // Diagonal neighbour -> 1
  assert.equal(chebyshevDistance(6, 12), 1);
  // Corner (0,0) to center (2,2) -> 2
  assert.equal(chebyshevDistance(0, 12), 2);
  // (0,0) to (4,4) -> 4
  assert.equal(chebyshevDistance(0, 24), 4);
  // Defensive
  assert.equal(chebyshevDistance(-1, 12), null);
  assert.equal(chebyshevDistance(25, 12), null);
  assert.equal(chebyshevDistance(1.5, 12), null);
});

test("relocateMine: moves the mine off a cell, preserving the mine count", () => {
  for (let i = 0; i < 200; i += 1) {
    const board = generateBoard(5);
    const target = board.mines[0];
    const moved = relocateMine(board, target);
    assert.equal(moved.mines.length, 5, "mine count preserved");
    assert.equal(moved.mines.includes(target), false, `mine ${target} should be gone`);
    assert.equal(isMine(moved, target), false);
    // Every remaining mine must be a valid unique cell.
    const seen = new Set();
    for (const m of moved.mines) {
      assert.ok(Number.isInteger(m) && m >= 0 && m < GRID_CELLS);
      assert.equal(seen.has(m), false, `duplicate mine ${m}`);
      seen.add(m);
    }
  }
});

test("relocateMine: no-op on a safe cell / malformed input", () => {
  const board = { size: 5, mines: [0, 5] };
  // No-op returns the same board reference (never mutates, never copies).
  assert.equal(relocateMine(board, 12), board);
  assert.equal(relocateMine(board, -1), board);
  assert.deepEqual(board.mines, [0, 5], "input untouched");
  // Malformed inputs pass through untouched.
  assert.equal(relocateMine(null, 0), null);
  assert.equal(relocateMine({ mines: "x" }, 0).mines, "x");
});

test("ejectMinesFromCenter: removes every mine from the 3x3 center block", () => {
  for (let i = 0; i < 300; i += 1) {
    const board = ejectMinesFromCenter(generateBoard(5));
    assert.equal(board.mines.length, 5);
    for (const m of board.mines) {
      assert.equal(
        CENTER_BLOCK_SET.has(m),
        false,
        `mine ${m} should not sit in the center block`,
      );
    }
  }
});

test("ejectMinesFromCenter: works from the densest legal mine counts (up to 16)", () => {
  for (let i = 0; i < 50; i += 1) {
    const board = ejectMinesFromCenter(generateBoard(16));
    assert.equal(board.mines.length, 16);
    for (const m of board.mines) {
      assert.equal(CENTER_BLOCK_SET.has(m), false);
    }
  }
});

test("ejectMinesFromCenter: best-effort beyond 16 mines (center block must hold some)", () => {
  const board = ejectMinesFromCenter(generateBoard(20));
  assert.equal(board.mines.length, 20);
  const seen = new Set();
  for (const m of board.mines) {
    assert.equal(seen.has(m), false);
    seen.add(m);
  }
});

test("simulateSolvability: a single corner mine is fully solvable from the center", () => {
  // Mine at corner 0. Center hint = 2 -> 3x3 block revealed -> cascade.
  const r = simulateSolvability({ size: 5, mines: [0] }, 12);
  assert.equal(r.guessFree, true);
  assert.equal(r.safeRemaining, 0);
  assert.equal(r.revealedCount, 24); // every safe cell (all but the mine)
});

test("simulateSolvability: a hint-1 opening (mine adjacent to the pick) is stuck", () => {
  // Mine at 7 sits directly above the center -> center hint = 1 -> the
  // hint proves nothing safe -> any continuation is a guess.
  const r = simulateSolvability({ size: 5, mines: [7] }, 12);
  assert.equal(r.guessFree, false);
  assert.ok(r.safeRemaining > 0);
});

test("simulateSolvability: a mid-game stall strands safe cells (distance hints are weak there)", () => {
  // Mines at 2 (0,2) and 10 (2,0): the center cascade deduces 20 of the
  // 23 safe cells, then hits a wall of hint-1 frontier reveals and can
  // prove nothing about the last 3 safe cells -> forced guess.
  const r = simulateSolvability({ size: 5, mines: [2, 10] }, 12);
  assert.equal(r.guessFree, false);
  assert.equal(r.safeRemaining, 3);
});

test("simulateSolvability: deterministic for the same board + opening", () => {
  const board = { size: 5, mines: [0, 2, 14, 22] };
  const a = simulateSolvability(board, 12);
  const b = simulateSolvability(board, 12);
  assert.deepEqual(a, b);
});

test("simulateSolvability: defensive inputs", () => {
  assert.equal(simulateSolvability(null, 12).guessFree, false);
  assert.equal(simulateSolvability({ mines: "x" }, 12).guessFree, false);
  assert.equal(simulateSolvability({ size: 5, mines: [0] }, -1).guessFree, false);
  assert.equal(simulateSolvability({ size: 5, mines: [0] }, 99).guessFree, false);
});

test("generateSolvableBoard: every returned board is valid (count, unique, sorted)", () => {
  for (const m of [1, 2, 3, 5, 8, 12]) {
    for (let i = 0; i < 20; i += 1) {
      const board = generateSolvableBoard(m);
      assert.equal(board.size, 5);
      assert.equal(board.mines.length, m, `m=${m} mine count`);
      const seen = new Set();
      for (let j = 0; j < board.mines.length; j += 1) {
        assert.equal(seen.has(board.mines[j]), false, `duplicate mine ${board.mines[j]}`);
        seen.add(board.mines[j]);
        assert.ok(board.mines[j] >= 0 && board.mines[j] < GRID_CELLS);
        if (j > 0) {
          assert.ok(board.mines[j] > board.mines[j - 1], "mines sorted ascending");
        }
      }
    }
  }
});

test("generateSolvableBoard: center block is always mine-free", () => {
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16]) {
    for (let i = 0; i < 30; i += 1) {
      const board = generateSolvableBoard(m);
      for (const idx of board.mines) {
        assert.equal(
          CENTER_BLOCK_SET.has(idx),
          false,
          `m=${m}: mine ${idx} inside center block`,
        );
      }
    }
  }
});

test("generateSolvableBoard: low mine counts are always fully solvable from the center", () => {
  // Measured acceptance: ~100% at m<=3, ~90% at m=4, ~72% at m=5.
  // Assert the hard floor we ship on: m<=3 boards must virtually
  // always pass (allow a tiny epsilon for randomness at 3).
  const trials = 60;
  let passed = 0;
  for (let i = 0; i < trials; i += 1) {
    const board = generateSolvableBoard(3);
    if (simulateSolvability(board, CENTER_FIRST_PICK).guessFree) passed += 1;
  }
  assert.ok(passed >= trials - 1, `expected ~100% pass at 3 mines, got ${passed}/${trials}`);
});

test("generateSolvableBoard: throws on invalid mine counts (mirrors generateBoard)", () => {
  assert.throws(() => generateSolvableBoard(0), RangeError);
  assert.throws(() => generateSolvableBoard(25), RangeError);
  assert.throws(() => generateSolvableBoard(-1), RangeError);
  assert.throws(() => generateSolvableBoard(1.5), RangeError);
  assert.throws(() => generateSolvableBoard(NaN), RangeError);
});

// ════════════════════════════════════════════════════════════════════════
// decideOutcome — the user-spec resolution table (odds-turn flow)
//
// Every match ends when a player picks a mine; the picker loses.
// `decideOutcome({ loserId, player1Id, player2Id })` returns the seat
// of the WINNING player. DRAW remains on the RESULT enum for parity
// with other PvP systems that produce draws, but is never returned
// by the new mines-pvp logic.
// ════════════════════════════════════════════════════════════════════════

test("decideOutcome: loserId = player1Id -> PLAYER2 wins", () => {
  assert.equal(
    decideOutcome({ loserId: "u1", player1Id: "u1", player2Id: "u2" }),
    RESULT.PLAYER2,
  );
});

test("decideOutcome: loserId = player2Id -> PLAYER1 wins", () => {
  assert.equal(
    decideOutcome({ loserId: "u2", player1Id: "u1", player2Id: "u2" }),
    RESULT.PLAYER1,
  );
});

test("decideOutcome: never returns DRAW for any (loserId, seat) pair", () => {
  for (const loserId of ["u1", "u2"]) {
    const result = decideOutcome({
      loserId,
      player1Id: "u1",
      player2Id: "u2",
    });
    assert.notEqual(
      result,
      RESULT.DRAW,
      `decideOutcome leaked DRAW for loserId=${loserId}`,
    );
    assert.ok(
      result === RESULT.PLAYER1 || result === RESULT.PLAYER2,
      `decideOutcome returned non-PLAYER value: ${result}`,
    );
  }
});

test("decideOutcome: loserId must match one of player1Id / player2Id (RangeError otherwise)", () => {
  assert.throws(
    () => decideOutcome({ loserId: "u3", player1Id: "u1", player2Id: "u2" }),
    RangeError,
  );
  assert.throws(
    () => decideOutcome({ loserId: null, player1Id: "u1", player2Id: "u2" }),
    RangeError,
  );
  assert.throws(
    () => decideOutcome({
      loserId: undefined,
      player1Id: "u1",
      player2Id: "u2",
    }),
    RangeError,
  );
  assert.throws(
    () => decideOutcome({ loserId: "", player1Id: "u1", player2Id: "u2" }),
    RangeError,
  );
});

// ════════════════════════════════════════════════════════════════════════
// seatForPickNumber / activeSeatForMatch / activePickerForMatch
// — the closed-form "odds" turn order helper
//
// Pattern (with firstPlayerSeat = "player1"):
//   turn 1 -> player1, turn 2 -> player2, turn 3 -> player2,
//   turn 4 -> player1, turn 5 -> player1, turn 6 -> player2,
//   turn 7 -> player2, turn 8 -> player1, ...
// Grouped by 4: each pair of two consecutive picks stays on the
// "leader" until the pair-leader flips.
// ════════════════════════════════════════════════════════════════════════

test("seatForPickNumber: closed-form pattern (firstPlayerSeat='player1')", () => {
  const expected = [
    [1, "player1"],
    [2, "player2"],
    [3, "player2"],
    [4, "player1"],
    [5, "player1"],
    [6, "player2"],
    [7, "player2"],
    [8, "player1"],
    [9, "player1"],
    [10, "player2"],
    [11, "player2"],
    [12, "player1"],
  ];
  for (const [n, want] of expected) {
    assert.equal(seatForPickNumber(n, "player1"), want, `turn ${n}`);
  }
});

test("seatForPickNumber: firstPlayerSeat='player2' mirrors the pattern", () => {
  const expected = [
    [1, "player2"],
    [2, "player1"],
    [3, "player1"],
    [4, "player2"],
    [5, "player2"],
    [6, "player1"],
  ];
  for (const [n, want] of expected) {
    assert.equal(seatForPickNumber(n, "player2"), want, `turn ${n}`);
  }
});

test("seatForPickNumber: invalid N returns null (defensive)", () => {
  assert.equal(seatForPickNumber(0, "player1"), null);
  assert.equal(seatForPickNumber(-1, "player1"), null);
  assert.equal(seatForPickNumber(1.5, "player1"), null);
  assert.equal(seatForPickNumber("1", "player1"), null);
  assert.equal(seatForPickNumber(null, "player1"), null);
});

test("activeSeatForMatch: derives turns from picks.length + firstPlayerId", () => {
  const mkMatch = ({ firstPlayerId, picks }) => ({
    player1Id: "u1",
    player2Id: "u2",
    firstPlayerId,
    picks,
  });
  assert.equal(
    activeSeatForMatch(mkMatch({ firstPlayerId: "u1", picks: [] })),
    "player1",
  );
  assert.equal(
    activeSeatForMatch(
      mkMatch({ firstPlayerId: "u1", picks: [{ seat: "player1" }] }),
    ),
    "player2",
  );
  assert.equal(
    activeSeatForMatch(
      mkMatch({
        firstPlayerId: "u1",
        picks: [{ seat: "player1" }, { seat: "player2" }],
      }),
    ),
    "player2",
  );
  assert.equal(
    activeSeatForMatch(
      mkMatch({
        firstPlayerId: "u1",
        picks: [
          { seat: "player1" },
          { seat: "player2" },
          { seat: "player2" },
        ],
      }),
    ),
    "player1",
  );
  assert.equal(
    activeSeatForMatch(
      mkMatch({
        firstPlayerId: "u1",
        picks: [
          { seat: "player1" },
          { seat: "player2" },
          { seat: "player2" },
          { seat: "player1" },
        ],
      }),
    ),
    "player1",
  );
});

test("activePickerForMatch: returns clerkId of the active picker", () => {
  const mkMatch = ({ firstPlayerId, picks }) => ({
    player1Id: "u1",
    player2Id: "u2",
    firstPlayerId,
    picks,
  });
  assert.equal(
    activePickerForMatch(mkMatch({ firstPlayerId: "u1", picks: [] })),
    "u1",
  );
  assert.equal(
    activePickerForMatch(mkMatch({ firstPlayerId: "u2", picks: [] })),
    "u2",
  );
  assert.equal(
    activePickerForMatch(
      mkMatch({
        firstPlayerId: "u1",
        picks: [{ seat: "player1" }, { seat: "player2" }],
      }),
    ),
    "u2",
  );
  assert.equal(activePickerForMatch(null), null);
  assert.equal(
    activePickerForMatch({
      player1Id: "u1",
      player2Id: null,
      firstPlayerId: "u1",
      picks: [],
    }),
    null,
  );
});

// ════════════════════════════════════════════════════════════════════════
// computePayout
// ════════════════════════════════════════════════════════════════════════

test("computePayout: stake 100, P1 wins -> winnerNet=190, loserNet=-100, houseFee=10, prizePaid=190", () => {
  const p = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(p.stake, 100);
  assert.equal(p.winnerNet, 190);
  assert.equal(p.loserNet, -100);
  assert.equal(p.houseFee, 10);
  assert.equal(p.prizePaid, 190);
});

test("computePayout: stake 100, P2 wins -> mirror math", () => {
  const p = computePayout({ stakeAmount: 100, result: RESULT.PLAYER2 });
  assert.equal(p.stake, 100);
  assert.equal(p.winnerNet, 190);
  assert.equal(p.loserNet, -100);
  assert.equal(p.houseFee, 10);
  assert.equal(p.prizePaid, 190);
});

test("computePayout: stake 50, DRAW -> winnerNet=null, loserNet=null, houseFee=0, prizePaid=0", () => {
  const p = computePayout({ stakeAmount: 50, result: RESULT.DRAW });
  assert.equal(p.stake, 50);
  assert.equal(p.winnerNet, null);
  assert.equal(p.loserNet, null);
  assert.equal(p.houseFee, 0);
  assert.equal(p.prizePaid, 0);
});

test("computePayout: prizePaid = stake + winnerPrize (1.9x stake total)", () => {
  for (const stake of [1, 10, 25, 100, 250, 1000]) {
    for (const result of [RESULT.PLAYER1, RESULT.PLAYER2]) {
      const p = computePayout({ stakeAmount: stake, result });
      assert.equal(
        p.prizePaid,
        round2(stake + stake * WINNER_RATIO),
        `stake=${stake} result=${result} prizePaid mismatch`,
      );
    }
  }
});

test("computePayout: loserNet is always -stake (regardless of winner)", () => {
  for (const stake of [1, 10, 50, 100, 500, 9999.99]) {
    for (const result of [RESULT.PLAYER1, RESULT.PLAYER2]) {
      const p = computePayout({ stakeAmount: stake, result });
      assert.equal(p.loserNet, -stake);
    }
  }
});

test("computePayout: fractional stake rounds to 2dp", () => {
  const p = computePayout({ stakeAmount: 1.5, result: RESULT.PLAYER1 });
  assert.equal(p.stake, 1.5);
  assert.equal(p.winnerNet, 2.85);
  assert.equal(p.loserNet, -1.5);
  assert.equal(p.houseFee, 0.15);
  assert.equal(p.prizePaid, 2.85);
});

test("computePayout: very small stake (0.01) houseFee rounds to 0", () => {
  const p = computePayout({ stakeAmount: 0.01, result: RESULT.PLAYER1 });
  assert.equal(p.stake, 0.01);
  assert.equal(p.winnerNet, 0.02);
  assert.equal(p.loserNet, -0.01);
  assert.equal(p.houseFee, 0);
  assert.equal(p.prizePaid, 0.02);
});

test("computePayout: invalid result throws RangeError", () => {
  assert.throws(
    () => computePayout({ stakeAmount: 100, result: "foo" }),
    RangeError,
  );
  assert.throws(
    () => computePayout({ stakeAmount: 100, result: null }),
    RangeError,
  );
  assert.throws(
    () => computePayout({ stakeAmount: 100, result: undefined }),
    RangeError,
  );
});

test("computePayout: negative stake throws RangeError", () => {
  assert.throws(
    () => computePayout({ stakeAmount: -1, result: RESULT.PLAYER1 }),
    RangeError,
  );
});

test("computePayout: NaN stake throws RangeError", () => {
  assert.throws(
    () => computePayout({ stakeAmount: NaN, result: RESULT.PLAYER1 }),
    RangeError,
  );
});

test("computePayout: Infinity stake throws RangeError", () => {
  assert.throws(
    () => computePayout({ stakeAmount: Infinity, result: RESULT.PLAYER1 }),
    RangeError,
  );
});

test("computePayout: string stake is coerced (no throw for numeric strings)", () => {
  const p = computePayout({ stakeAmount: "100", result: RESULT.PLAYER1 });
  assert.equal(p.stake, 100);
  assert.equal(p.winnerNet, 190);
  assert.throws(
    () => computePayout({ stakeAmount: "abc", result: RESULT.PLAYER1 }),
    RangeError,
  );
});

test("computePayout: houseFee + winnerPrize = stake (full loser's stake is split)", () => {
  for (const stake of [1, 10, 50, 100, 999.99]) {
    for (const result of [RESULT.PLAYER1, RESULT.PLAYER2]) {
      const p = computePayout({ stakeAmount: stake, result });
      assert.equal(round2(p.houseFee + (p.winnerNet - stake)), round2(stake));
    }
  }
});

// ════════════════════════════════════════════════════════════════════════
// pickRandomCell
// ════════════════════════════════════════════════════════════════════════

test("pickRandomCell: returns a valid cell index in 0..GRID_CELLS-1", () => {
  for (let i = 0; i < 200; i += 1) {
    const cell = pickRandomCell();
    assert.ok(Number.isInteger(cell));
    assert.ok(cell >= 0 && cell < GRID_CELLS);
  }
});

test("pickRandomCell: never returns a cell in excludePicks", () => {
  const exclude = [0, 5, 12, 24];
  for (let i = 0; i < 200; i += 1) {
    const cell = pickRandomCell({ excludePicks: exclude });
    assert.ok(!exclude.includes(cell), `cell ${cell} is in excludePicks`);
  }
});

test("pickRandomCell: with no params, excludePicks defaults to []", () => {
  for (let i = 0; i < 50; i += 1) {
    const cell = pickRandomCell();
    assert.ok(cell >= 0 && cell < GRID_CELLS);
  }
});

test("pickRandomCell: filters non-integer entries from excludePicks", () => {
  const exclude = [1.5, NaN, "abc", 5, -1, null, "3"];
  for (let i = 0; i < 200; i += 1) {
    const cell = pickRandomCell({ excludePicks: exclude });
    assert.ok(Number.isInteger(cell), `cell ${cell} should be an integer`);
    assert.ok(cell >= 0 && cell < GRID_CELLS);
    assert.notEqual(cell, 5, "5 should be excluded");
    assert.notEqual(cell, 0, "null->0 should be excluded");
    assert.notEqual(cell, 3, '"3"->3 should be excluded');
  }
});

test("pickRandomCell: excludes ALL cells -> throws", () => {
  const all = Array.from({ length: GRID_CELLS }, (_, i) => i);
  assert.throws(() => pickRandomCell({ excludePicks: all }), /every cell is already picked/);
});

test("pickRandomCell: distribution is roughly uniform across the 25 cells", () => {
  const counts = new Array(GRID_CELLS).fill(0);
  const trials = 5000;
  for (let i = 0; i < trials; i += 1) {
    counts[pickRandomCell()] += 1;
  }
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    assert.ok(
      counts[cell] > 100 && counts[cell] < 320,
      `cell ${cell} hit ${counts[cell]} times`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// round2 helper
// ════════════════════════════════════════════════════════════════════════

test("round2: rounds to 2dp (no floating-point drift)", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1);
  assert.equal(round2(1.015), 1.01);
  assert.equal(round2(190.0), 190);
  assert.equal(round2(2.85), 2.85);
  assert.equal(round2(0.001), 0);
  assert.equal(round2(0.009), 0.01);
});

test("round2: NaN / Infinity / non-number returns 0 (defensive)", () => {
  assert.equal(round2(NaN), 0);
  assert.equal(round2(Infinity), 0);
  assert.equal(round2(-Infinity), 0);
  assert.equal(round2("not a number"), 0);
  assert.equal(round2(undefined), 0);
  assert.equal(round2(null), 0);
});

test("round2: 0 stays 0", () => {
  assert.equal(round2(0), 0);
  assert.equal(round2(-0), 0);
});

// ════════════════════════════════════════════════════════════════════════
// cellIndexToRowCol / rowColToCellIndex — round-trip helpers
// ════════════════════════════════════════════════════════════════════════

test("cellIndexToRowCol: cell 0 -> row 0, col 0", () => {
  assert.deepEqual(cellIndexToRowCol(0), { row: 0, col: 0 });
});

test("cellIndexToRowCol: cell 24 -> row 4, col 4", () => {
  assert.deepEqual(cellIndexToRowCol(24), { row: 4, col: 4 });
});

test("cellIndexToRowCol: cell 5 -> row 1, col 0 (row-major)", () => {
  assert.deepEqual(cellIndexToRowCol(5), { row: 1, col: 0 });
});

test("cellIndexToRowCol: cell 12 -> row 2, col 2 (center)", () => {
  assert.deepEqual(cellIndexToRowCol(12), { row: 2, col: 2 });
});

test("cellIndexToRowCol: out-of-range returns null", () => {
  assert.equal(cellIndexToRowCol(-1), null);
  assert.equal(cellIndexToRowCol(25), null);
  assert.equal(cellIndexToRowCol(9999), null);
});

test("cellIndexToRowCol: non-integer returns null", () => {
  assert.equal(cellIndexToRowCol(1.5), null);
  assert.equal(cellIndexToRowCol("5.5"), null);
  assert.equal(cellIndexToRowCol("abc"), null);
  assert.equal(cellIndexToRowCol(undefined), null);
  assert.equal(cellIndexToRowCol(NaN), null);
  assert.equal(cellIndexToRowCol({}), null);
});

test("rowColToCellIndex: (0,0) -> 0, (4,4) -> 24, (1,0) -> 5, (2,2) -> 12", () => {
  assert.equal(rowColToCellIndex(0, 0), 0);
  assert.equal(rowColToCellIndex(4, 4), 24);
  assert.equal(rowColToCellIndex(1, 0), 5);
  assert.equal(rowColToCellIndex(2, 2), 12);
});

test("rowColToCellIndex: out-of-range returns null", () => {
  assert.equal(rowColToCellIndex(-1, 0), null);
  assert.equal(rowColToCellIndex(0, -1), null);
  assert.equal(rowColToCellIndex(5, 0), null);
  assert.equal(rowColToCellIndex(0, 5), null);
});

test("rowColToCellIndex: non-integer returns null", () => {
  assert.equal(rowColToCellIndex(1.5, 0), null);
  assert.equal(rowColToCellIndex(0, "2.5"), null);
  assert.equal(rowColToCellIndex(0, "abc"), null);
  assert.equal(rowColToCellIndex(0, undefined), null);
  assert.equal(rowColToCellIndex(NaN, 0), null);
  assert.equal(rowColToCellIndex(0, {}), null);
});

test("rowColToCellIndex <-> cellIndexToRowCol round-trip for every cell", () => {
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    const rc = cellIndexToRowCol(cell);
    assert.deepEqual(rc, { row: Math.floor(cell / 5), col: cell % 5 });
    assert.equal(rowColToCellIndex(rc.row, rc.col), cell);
  }
});

console.log("\n? All Mines Duel engine tests passed!\n");
