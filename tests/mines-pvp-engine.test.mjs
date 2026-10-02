/**
 * Mines Duel ("Mines PvP") — engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers in
 * `src/lib/mines-pvp/constants.js`. The current rules:
 *
 *   • 10×10 board (100 cells), a FIXED 10 mines (1 per 10 tiles).
 *   • strict alternation — one action (reveal OR flag) per turn.
 *   • a reveal hits a mine → the revealer loses immediately.
 *   • a flag on a mine confirms it for the flagger (private); a wrong flag is
 *     rejected and costs the turn. Confirm every mine → win.
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
  MINES_PER_MATCH,
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
  // Board machinery
  generateBoard,
  isMine,
  nearestMineDistance,
  chebyshevDistance,
  relocateMine,
  // Pure helpers under test
  decideOutcome,
  computePayout,
  pickRandomCell,
  round2,
  cellIndexToRowCol,
  rowColToCellIndex,
  seatForPickNumber,
  activeSeatForMatch,
  activePickerForMatch,
  // AI cell-selection policy
  chooseAiCell,
  chooseAiAction,
  deduceKnownMines,
  aiCellRisk,
  // AI pick pacing (legacy surface)
  AI_PICK_DELAY_MS,
  MINES_AI_PLAYER_ID,
  lastAiPickAt,
  aiPickDelayElapsed,
  // Flags + mine counters
  WIN_REASON,
  normalizeFlags,
  correctFlagCount,
  hasFlaggedAllMines,
  flagsForSeat,
  isFlagEntry,
  revealedCells,
  withFlagForSeat,
  minesFoundForSeat,
  minesRemainingForSeat,
  // Shared-board mechanics
  resultForWinner,
} from "../src/lib/mines-pvp/constants.js";

// ════════════════════════════════════════════════════════════════════════
// Board geometry constants
// ════════════════════════════════════════════════════════════════════════

test("GRID_SIZE is 10 (a wide Minesweeper field)", () => {
  assert.equal(GRID_SIZE, 10);
});

test("GRID_CELLS is 100 (10×10)", () => {
  assert.equal(GRID_CELLS, 100);
  assert.equal(GRID_CELLS, GRID_SIZE * GRID_SIZE);
});

test("MIN_MINES is 1 (at least one mine)", () => {
  assert.equal(MIN_MINES, 1);
});

test("MAX_MINES is GRID_CELLS - 1 (99)", () => {
  assert.equal(MAX_MINES, 99);
  assert.equal(MAX_MINES, GRID_CELLS - 1);
});

test("MINES_PER_MATCH is 10 (1 mine per 10 tiles)", () => {
  assert.equal(MINES_PER_MATCH, 10);
  assert.equal(MINES_PER_MATCH, Math.round(GRID_CELLS / 10));
});

// ════════════════════════════════════════════════════════════════════════
// Per-turn window / stakes / payout split
// ════════════════════════════════════════════════════════════════════════

test("ROUND_TIMER_SECONDS is 20 and the deadline mirrors it", () => {
  assert.equal(ROUND_TIMER_SECONDS, 20);
  assert.equal(ROUND_PICK_DEADLINE_MS, 20_000);
  assert.equal(ROUND_PICK_DEADLINE_MS, ROUND_TIMER_SECONDS * 1000);
});

test("stake presets + bounds", () => {
  assert.deepEqual(STAKE_PRESETS, [10, 25, 50, 100, 250, 500]);
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 100_000);
});

test("the 90/10 split sums to 1", () => {
  assert.equal(HOUSE_FEE_PCT, 0.10);
  assert.equal(WINNER_RATIO, 0.90);
  assert.equal(HOUSE_RATIO, 0.10);
  assert.equal(WINNER_RATIO + HOUSE_RATIO, 1.0);
});

// ════════════════════════════════════════════════════════════════════════
// Status state machine
// ════════════════════════════════════════════════════════════════════════

test("MATCH_STATUS is frozen with the six states", () => {
  assert.equal(Object.isFrozen(MATCH_STATUS), true);
  assert.equal(MATCH_STATUS.WAITING, "waiting");
  assert.equal(MATCH_STATUS.READY, "ready");
  assert.equal(MATCH_STATUS.P1_TURN, "p1_turn");
  assert.equal(MATCH_STATUS.P2_TURN, "p2_turn");
  assert.equal(MATCH_STATUS.FINISHED, "finished");
  assert.equal(MATCH_STATUS.CANCELLED, "cancelled");
});

test("ACTIVE / PICKABLE / TERMINAL partition the states", () => {
  assert.equal(ACTIVE_STATES.has(MATCH_STATUS.READY), true);
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.READY), false);
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.P1_TURN), true);
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.P2_TURN), true);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.FINISHED), true);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.CANCELLED), true);
  for (const state of ACTIVE_STATES) {
    assert.equal(TERMINAL_STATES.has(state), false);
  }
  for (const state of PICKABLE_STATES) {
    assert.equal(ACTIVE_STATES.has(state), true);
  }
});

test("READY_WINDOW_MS / FINISHED_GRACE_MS", () => {
  assert.equal(READY_WINDOW_MS, 3000);
  assert.equal(FINISHED_GRACE_MS, 5000);
});

test("MINES_PVP_LOCK_NAMESPACE is a positive 31-bit integer", () => {
  assert.equal(Number.isInteger(MINES_PVP_LOCK_NAMESPACE), true);
  assert.ok(MINES_PVP_LOCK_NAMESPACE > 0);
  assert.ok(MINES_PVP_LOCK_NAMESPACE <= 0x7fffffff);
});

test("RESULT / PICK_KIND / WIN_REASON vocabularies", () => {
  assert.equal(Object.isFrozen(RESULT), true);
  assert.equal(RESULT.PLAYER1, "player1");
  assert.equal(RESULT.PLAYER2, "player2");
  assert.equal(RESULT.DRAW, "draw");
  assert.equal(PICK_KIND.MINE, "mine");
  assert.equal(PICK_KIND.SAFE, "safe");
  assert.equal(WIN_REASON.MINE_HIT, "mine_hit");
  assert.equal(WIN_REASON.ALL_MINES_FLAGGED, "all_mines_flagged");
  assert.equal(WIN_REASON.RESIGN, "resign");
  assert.equal(WIN_REASON.DISCONNECT, "disconnect");
});

// ════════════════════════════════════════════════════════════════════════
// seatForPickNumber — strict alternation
// ════════════════════════════════════════════════════════════════════════

test("seatForPickNumber alternates every single turn", () => {
  const expected = [
    [1, "player1"],
    [2, "player2"],
    [3, "player1"],
    [4, "player2"],
    [5, "player1"],
    [6, "player2"],
  ];
  for (const [n, want] of expected) {
    assert.equal(seatForPickNumber(n, "player1"), want, `turn ${n}`);
  }
});

test("seatForPickNumber mirrors when player2 opens", () => {
  assert.equal(seatForPickNumber(1, "player2"), "player2");
  assert.equal(seatForPickNumber(2, "player2"), "player1");
  assert.equal(seatForPickNumber(3, "player2"), "player2");
});

test("seatForPickNumber rejects non-positive / non-integer input", () => {
  for (const bad of [0, -1, 1.5, "1", null, undefined, NaN]) {
    assert.equal(seatForPickNumber(bad, "player1"), null);
  }
});

test("activeSeatForMatch / activePickerForMatch derive the turn from history", () => {
  const match = {
    player1Id: "u1",
    player2Id: "u2",
    firstPlayerId: "u1",
    picks: [],
  };
  assert.equal(activeSeatForMatch(match), "player1");
  assert.equal(activePickerForMatch(match), "u1");
  match.picks = [{ cell: 5 }];
  assert.equal(activeSeatForMatch(match), "player2");
  assert.equal(activePickerForMatch(match), "u2");
  match.picks = [{ cell: 5 }, { cell: 6 }];
  assert.equal(activeSeatForMatch(match), "player1");
});

// ════════════════════════════════════════════════════════════════════════
// generateBoard
// ════════════════════════════════════════════════════════════════════════

test("generateBoard: produces a valid 5-mine board", () => {
  for (let i = 0; i < 50; i += 1) {
    const board = generateBoard(5);
    assert.equal(board.size, 10);
    assert.equal(board.mines.length, 5);
    const seen = new Set();
    for (const idx of board.mines) {
      assert.ok(Number.isInteger(idx) && idx >= 0 && idx < GRID_CELLS);
      assert.equal(seen.has(idx), false, `duplicate mine ${idx}`);
      seen.add(idx);
    }
  }
});

test("generateBoard: mines are sorted ascending", () => {
  for (let i = 0; i < 50; i += 1) {
    const board = generateBoard(5);
    for (let j = 1; j < board.mines.length; j += 1) {
      assert.ok(board.mines[j] > board.mines[j - 1]);
    }
  }
});

test("generateBoard: roughly uniform distribution across 100 cells", () => {
  const counts = new Array(GRID_CELLS).fill(0);
  const trials = 1000;
  for (let i = 0; i < trials; i += 1) {
    for (const idx of generateBoard(5).mines) counts[idx] += 1;
  }
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    assert.ok(
      counts[cell] > 15 && counts[cell] < 95,
      `cell ${cell} hit ${counts[cell]} times — out of range`,
    );
  }
});

test("generateBoard: rejects invalid mine counts", () => {
  for (const bad of [0, 100, -1, 1.5, NaN]) {
    assert.throws(() => generateBoard(bad), RangeError);
  }
  // The generic bounds still allow up to MAX_MINES for the pure generator.
  assert.equal(generateBoard(99).mines.length, 99);
});

// ════════════════════════════════════════════════════════════════════════
// isMine / nearestMineDistance / chebyshevDistance
// ════════════════════════════════════════════════════════════════════════

test("isMine: true for listed mines, false otherwise", () => {
  const board = generateBoard(5);
  for (const idx of board.mines) assert.equal(isMine(board, idx), true);
  const set = new Set(board.mines);
  for (let c = 0; c < GRID_CELLS; c += 1) {
    if (!set.has(c)) assert.equal(isMine(board, c), false);
  }
});

test("isMine: defensive inputs return false", () => {
  const board = generateBoard(5);
  assert.equal(isMine(board, -1), false);
  assert.equal(isMine(board, GRID_CELLS), false);
  assert.equal(isMine(board, "5"), false);
  assert.equal(isMine(null, 0), false);
  assert.equal(isMine({}, 5), false);
});

test("nearestMineDistance: Chebyshev tiles to the closest mine", () => {
  // Board 10×10. Mine at 0 (0,0). Cell 99 (9,9) is 9 tiles away.
  assert.equal(nearestMineDistance({ size: 10, mines: [0] }, 99), 9);
  // Cell 11 (1,1) touches (0,0) diagonally.
  assert.equal(nearestMineDistance({ size: 10, mines: [0] }, 11), 1);
  // A mine on the cell itself is distance 0.
  assert.equal(nearestMineDistance({ size: 10, mines: [55] }, 55), 0);
});

test("nearestMineDistance: defensive inputs return null", () => {
  assert.equal(nearestMineDistance(null, 0), null);
  assert.equal(nearestMineDistance({}, 0), null);
  assert.equal(nearestMineDistance({ mines: [] }, 0), null);
  assert.equal(nearestMineDistance({ mines: [0] }, -1), null);
  assert.equal(nearestMineDistance({ mines: [0] }, 999), null);
});

test("chebyshevDistance: king-move distance between cells", () => {
  assert.equal(chebyshevDistance(0, 0), 0);
  assert.equal(chebyshevDistance(0, 11), 1);
  assert.equal(chebyshevDistance(0, 55), 5);
  assert.equal(chebyshevDistance(0, 99), 9);
  assert.equal(chebyshevDistance(-1, 12), null);
  assert.equal(chebyshevDistance(100, 12), null);
});

// ════════════════════════════════════════════════════════════════════════
// relocateMine (first-pick mercy)
// ════════════════════════════════════════════════════════════════════════

test("relocateMine: moves the mine off a cell, preserving the count", () => {
  for (let i = 0; i < 100; i += 1) {
    const board = generateBoard(5);
    const target = board.mines[0];
    const moved = relocateMine(board, target);
    assert.equal(moved.mines.length, 5);
    assert.equal(isMine(moved, target), false);
  }
});

test("relocateMine: no-op on a safe cell / malformed input", () => {
  const board = { size: 10, mines: [0, 5] };
  assert.equal(relocateMine(board, 12), board);
  assert.deepEqual(board.mines, [0, 5]);
  assert.equal(relocateMine(null, 0), null);
});

// ════════════════════════════════════════════════════════════════════════
// decideOutcome / resultForWinner / computePayout
// ════════════════════════════════════════════════════════════════════════

test("decideOutcome maps a loser to the winning seat", () => {
  assert.equal(
    decideOutcome({ loserId: "u1", player1Id: "u1", player2Id: "u2" }),
    RESULT.PLAYER2,
  );
  assert.equal(
    decideOutcome({ loserId: "u2", player1Id: "u1", player2Id: "u2" }),
    RESULT.PLAYER1,
  );
  assert.throws(
    () => decideOutcome({ loserId: "u3", player1Id: "u1", player2Id: "u2" }),
    RangeError,
  );
});

test("resultForWinner is winner-shaped and throws on a non-seat", () => {
  assert.equal(
    resultForWinner({ winnerId: "u1", player1Id: "u1", player2Id: "u2" }),
    RESULT.PLAYER1,
  );
  assert.equal(
    resultForWinner({ winnerId: "u2", player1Id: "u1", player2Id: "u2" }),
    RESULT.PLAYER2,
  );
  assert.throws(
    () => resultForWinner({ winnerId: "x", player1Id: "u1", player2Id: "u2" }),
    RangeError,
  );
});

test("computePayout: winner takes stake + 90%, house 10%, loser -stake", () => {
  const p = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(p.winnerNet, 190);
  assert.equal(p.loserNet, -100);
  assert.equal(p.houseFee, 10);
  assert.equal(p.prizePaid, 190);
  // Draw (legacy) refunds both sides.
  const d = computePayout({ stakeAmount: 100, result: RESULT.DRAW });
  assert.equal(d.winnerNet, null);
  assert.equal(d.houseFee, 0);
  assert.throws(() => computePayout({ stakeAmount: -1, result: RESULT.PLAYER1 }), RangeError);
  assert.throws(() => computePayout({ stakeAmount: 10, result: "nope" }), RangeError);
});

// ════════════════════════════════════════════════════════════════════════
// pickRandomCell / round2 / cell conversions
// ════════════════════════════════════════════════════════════════════════

test("pickRandomCell: returns a valid cell and honours the exclusion set", () => {
  for (let i = 0; i < 100; i += 1) {
    const cell = pickRandomCell({ excludePicks: [0, 1, 2] });
    assert.ok(cell >= 3 && cell < GRID_CELLS);
  }
  assert.throws(
    () =>
      pickRandomCell({
        excludePicks: Array.from({ length: GRID_CELLS }, (_, i) => i),
      }),
    Error,
  );
});

test("round2 rounds to two decimals", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2("1.005"), 1.0);
  assert.equal(round2(NaN), 0);
});

test("cell ↔ row/col round trip", () => {
  for (const idx of [0, 9, 10, 55, 99]) {
    const rc = cellIndexToRowCol(idx);
    assert.equal(rowColToCellIndex(rc.row, rc.col), idx);
  }
  assert.equal(cellIndexToRowCol(100), null);
  assert.equal(rowColToCellIndex(10, 0), null);
});

// ════════════════════════════════════════════════════════════════════════
// Flags + mine counters
// ════════════════════════════════════════════════════════════════════════

test("normalizeFlags: unique, sorted, in-range, tamper-safe", () => {
  assert.deepEqual(normalizeFlags([5, 3, 5, 101, -1, "7", 1.5, null]), [3, 5, 7]);
  assert.deepEqual(normalizeFlags("nope"), []);
});

test("correctFlagCount counts only real mines", () => {
  const board = { size: 10, mines: [1, 2, 3, 4, 5] };
  assert.equal(correctFlagCount([1, 2, 99], board), 2);
  assert.equal(correctFlagCount([], board), 0);
});

test("hasFlaggedAllMines: every mine must be claimed", () => {
  const board = { size: 10, mines: [1, 2, 3, 4, 5] };
  assert.equal(hasFlaggedAllMines([1, 2, 3, 4, 5], board), true);
  assert.equal(hasFlaggedAllMines([1, 2, 3, 4], board), false);
  assert.equal(hasFlaggedAllMines([], board), false);
});

test("flagsForSeat reads a seat's own set, normalised", () => {
  const match = { p1Flags: [9, 3, 3], p2Flags: [5] };
  assert.deepEqual(flagsForSeat(match, "player1"), [3, 9]);
  assert.deepEqual(flagsForSeat(match, "player2"), [5]);
  assert.deepEqual(flagsForSeat({}, "player1"), []);
});

test("withFlagForSeat returns a single-column patch", () => {
  const match = { p1Flags: [1], p2Flags: [2] };
  assert.deepEqual(withFlagForSeat(match, "player1", 7), { p1Flags: [1, 7] });
  assert.deepEqual(withFlagForSeat(match, "player2", 8), { p2Flags: [2, 8] });
});

test("isFlagEntry reads both discriminators", () => {
  assert.equal(isFlagEntry({ flag: true }), true);
  assert.equal(isFlagEntry({ kind: "flag" }), true);
  assert.equal(isFlagEntry({ cell: 1 }), false);
  assert.equal(isFlagEntry(null), false);
});

test("revealedCells skips flag entries", () => {
  const match = {
    picks: [
      { cell: 1, flag: false },
      { cell: 2, flag: true, kind: "flag" },
      { cell: "3", flag: false },
    ],
  };
  assert.deepEqual(revealedCells(match), [1, 3]);
  assert.deepEqual(revealedCells({}), []);
});

test("minesFoundForSeat / minesRemainingForSeat track the public counters", () => {
  const board = { size: 10, mines: [1, 2, 3, 4, 5] };
  const match = { minesCount: 5, board, p1Flags: [1, 2], p2Flags: [] };
  assert.equal(minesFoundForSeat(match, "player1"), 2);
  assert.equal(minesRemainingForSeat(match, "player1"), 3);
  assert.equal(minesFoundForSeat(match, "player2"), 0);
  assert.equal(minesRemainingForSeat(match, "player2"), 5);
});

// ════════════════════════════════════════════════════════════════════════
// AI — reveal-only, deduction-driven
// ════════════════════════════════════════════════════════════════════════

test("aiCellRisk: cells inside a clue's safety radius are risk 0", () => {
  // A clue of 5 at cell 55 proves nothing within Chebyshev 4 is a mine.
  const revealed = [{ cell: 55, hint: 5 }];
  // Cell 44 is a neighbour of 55 (distance 1 < 5) → provably safe.
  assert.equal(aiCellRisk(44, revealed), 0);
  // A cell exactly on the frontier is a mine candidate → non-zero risk.
  assert.ok(aiCellRisk(0, revealed) > 0);
});

test("chooseAiCell: hard never picks a provably-risky cell when a safe one exists", () => {
  const match = {
    aiDifficulty: "hard",
    picks: [{ cell: 55, hint: 5, flag: false }],
  };
  const { cellIndex } = chooseAiCell(match, () => 0);
  assert.ok(Number.isInteger(cellIndex) && cellIndex >= 0 && cellIndex < GRID_CELLS);
  // It must not be the already-revealed cell, and it must be provably safe.
  assert.notEqual(cellIndex, 55);
  assert.ok(chebyshevDistance(cellIndex, 55) < 5);
});

test("chooseAiCell: easy ignores the clues and takes a random live cell", () => {
  const match = { aiDifficulty: "easy", picks: [{ cell: 0, hint: 1, flag: false }] };
  const { cellIndex } = chooseAiCell(match, () => 0);
  // It never re-picks a revealed cell, and it may ignore the clue entirely.
  assert.ok(Number.isInteger(cellIndex) && cellIndex >= 0 && cellIndex < GRID_CELLS);
  assert.notEqual(cellIndex, 0);
});

test("chooseAiCell: a full board falls back to cell 0", () => {
  const picks = Array.from({ length: GRID_CELLS }, (_, cell) => ({ cell, flag: false }));
  assert.deepEqual(chooseAiCell({ aiDifficulty: "hard", picks }, () => 0), { cellIndex: 0 });
});

test("chooseAiCell never touches the flag sets", () => {
  const { cellIndex } = chooseAiCell(
    { aiDifficulty: "hard", picks: [{ cell: 3, flag: true }] },
    () => 0,
  );
  assert.ok(Number.isInteger(cellIndex));
});

test("deduceKnownMines: the sole unrevealed cell on a clue's ring is a mine", () => {
  // Clue of 1 at corner cell 0: its 1-ring is {1, 10, 11}. With 1 and 10
  // revealed, 11 is the only candidate left, so it must be the mine.
  const revealed = [{ cell: 0, hint: 1 }];
  const unknown = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (i !== 0 && i !== 1 && i !== 10) unknown.push(i);
  }
  assert.deepEqual(deduceKnownMines(revealed, unknown), [11]);
  // Nothing is proven while more than one ring cell is unknown.
  const wide = [];
  for (let i = 0; i < GRID_CELLS; i += 1) if (i !== 0) wide.push(i);
  assert.deepEqual(deduceKnownMines(revealed, wide), []);
});

test("chooseAiAction: hard flags a proven mine instead of revealing", () => {
  const picks = [
    { cell: 0, hint: 1, flag: false },
    { cell: 1, hint: 1, flag: false },
    { cell: 10, hint: 1, flag: false },
  ];
  const action = chooseAiAction({ aiDifficulty: "hard", picks, p2Flags: [] }, () => 0);
  assert.equal(action.kind, "flag");
  assert.equal(action.cellIndex, 11);
});

test("chooseAiAction: easy never flags and falls back to a safe reveal", () => {
  const picks = [
    { cell: 0, hint: 1, flag: false },
    { cell: 1, hint: 1, flag: false },
    { cell: 10, hint: 1, flag: false },
  ];
  const action = chooseAiAction({ aiDifficulty: "easy", picks, p2Flags: [] }, () => 0);
  assert.equal(action.kind, "reveal");
  assert.ok(Number.isInteger(action.cellIndex));
  assert.notEqual(action.cellIndex, 0);
  assert.notEqual(action.cellIndex, 11);
});

test("chooseAiAction: without a proof the bot reveals the safest cell", () => {
  const action = chooseAiAction({ aiDifficulty: "hard", picks: [], p2Flags: [] }, () => 0);
  assert.equal(action.kind, "reveal");
  assert.ok(Number.isInteger(action.cellIndex));
});

// ════════════════════════════════════════════════════════════════════════
// AI pacing helpers (legacy surface)
// ════════════════════════════════════════════════════════════════════════

test("lastAiPickAt reads the bot's most recent pick", () => {
  const match = {
    picks: [
      { userId: "human", pickedAt: "2026-01-01T00:00:00.000Z" },
      { userId: MINES_AI_PLAYER_ID, pickedAt: "2026-01-01T00:00:05.000Z" },
    ],
  };
  assert.equal(lastAiPickAt(match), "2026-01-01T00:00:05.000Z");
  assert.equal(lastAiPickAt(null), null);
});

test("aiPickDelayElapsed respects the pacing window", () => {
  assert.equal(AI_PICK_DELAY_MS, 1500);
  const match = { picks: [{ userId: MINES_AI_PLAYER_ID, pickedAt: 1_000 }] };
  assert.equal(aiPickDelayElapsed(match, 5_000), true);
  assert.equal(aiPickDelayElapsed(match, 1_500), false);
  assert.equal(aiPickDelayElapsed({ picks: [] }, 0), true);
});
