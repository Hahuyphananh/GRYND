/**
 * tic-tac-toe-rules.test.mjs
 *
 * The PURE Mega Tic-Tac-Toe rules engine, pinned exhaustively.
 *
 * The engine is the authoritative game logic: it decides whose turn it is, whose
 * mark lands on which small board, when a small board is locked (won or drawn),
 * when the match grows from 1 → 4 → 9 boards, when a Mega line wins, and what
 * the final tiebreaker (or sudden death) produces. It is pure — no DB, no I/O,
 * no randomness — so every branch can be pinned here.
 *
 * It also asserts the anti-cheat property directly: the mark is derived from the
 * acting SEAT, and the round, active/completed boards, board winners, Mega
 * winner, draws, tiebreaker and sudden-death requirement are all derived from
 * the server state. Nothing here reads a client-supplied winner, score, board,
 * round or result, because no such value is ever passed in.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  activeBoardIndexes,
  applyMove,
  boardControlAt,
  completedBoardIndexes,
  computeMatchResult,
  countCells,
  createEmptyBoard,
  createInitialState,
  currentSuddenDeathBoard,
  evaluateTiebreak,
  findMegaWin,
  findWinningLine,
  isBoardFull,
  isValidBoardIndex,
  isValidCellIndex,
  isWellFormedBoard,
  markForSeat,
  megaLinesForStage,
  normalizeForViewer,
  otherSeat,
  replayMoves,
  resolveBoardControl,
  seatForMark,
  seatForPly,
  seatForUser,
  seatsFromMatch,
  stageBoardSlots,
  statusForState,
  userIdForSeat,
  validateMove,
} from "../src/lib/tic-tac-toe/rules.ts";
import {
  BOARD_SIZE,
  CELL_COUNT,
  FIRST_SEAT,
  MATCH_STATUS,
  MAX_BOARDS,
  MAX_MEGA_STAGE,
  MEGA_SIZE,
  MEGA_WINNING_LINES,
  RESULT,
  STAGE_BOARD_SLOTS,
  SUDDEN_DEATH_BOARD_INDEX,
  TIC_TAC_TOE_LOCK_NAMESPACE,
  WINNING_LINES,
} from "../src/lib/tic-tac-toe/constants.ts";

const SEATS = { player1Id: "user_alice", player2Id: "user_bob" };
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A small board whose control/winningLine are derived exactly as the engine derives them. */
function board(cells) {
  assert.equal(cells.length, CELL_COUNT, "a fixture board must have nine cells");
  const { control, winningLine } = resolveBoardControl(cells);
  return {
    cells: [...cells],
    plies: cells.filter((cell) => cell !== null).length,
    control,
    winningLine,
  };
}

/** The classic nine-move draw, as a per-ply cell order for ONE board. */
const DRAW_CELL_ORDER = [0, 4, 8, 2, 6, 3, 5, 7, 1];
const DRAW_CELLS = (() => {
  const cells = new Array(CELL_COUNT).fill(null);
  DRAW_CELL_ORDER.forEach((cell, ply) => {
    cells[cell] = ply % 2 === 0 ? "X" : "O";
  });
  return cells;
})();

// Per-board fixtures. "majority" is BY CELL COUNT — the tiebreaker's unit.
const X_SWEEP = ["X", "X", "X", "O", "O", null, null, null, null]; // X=3 O=2 → X controls
const O_SWEEP = ["O", "O", "O", "X", "X", null, null, null, null]; // O=3 X=2 → O controls
const X_PENDING = ["X", "X", null, "O", "O", null, null, null, null]; // active; X's 3rd wins it
const O_PENDING = ["X", null, "X", "O", "O", null, "X", null, null]; // active; O's 3rd wins it (3/3)
const X_MAJORITY = ["X", "X", "X", "X", "X", "O", null, null, null]; // X=5 O=1 → X
const O_MAJORITY = ["O", "O", "O", "X", "O", null, null, null, null]; // O=4 X=1 → O
const NEUTRAL = ["X", null, "X", "O", "O", "O", "X", null, null]; // O line, X=3 O=3 → neutral

/** Build a state directly. `boards` is keyed by lattice slot (0..8). */
function craft({
  stage = 1,
  boards = {},
  currentTurn = FIRST_SEAT,
  ply = 0,
  phase = "playing",
  suddenDeath = null,
} = {}) {
  return {
    version: 1,
    phase,
    stage,
    boards: Array.from({ length: MAX_BOARDS }, (_, slot) => boards[slot] ?? null),
    currentTurn,
    ply,
    winner: null,
    winningBoards: null,
    tiebreak: null,
    suddenDeath,
    lastMove: null,
  };
}

const seatAt = (ply) => (ply % 2 === 0 ? "player1" : "player2");

/** Drive a game on the single stage-1 board, alternating seats from ply parity. */
function playRound1(cells) {
  let state = createInitialState();
  cells.forEach((cellIndex, ply) => {
    state = applyMove({ state, seat: seatAt(ply), boardIndex: 0, cellIndex }).state;
  });
  return state;
}

// ── Vocabulary and geometry ───────────────────────────────────────────────

test("constants: a small board is 3x3, the Mega lattice is 3x3, three stages", () => {
  assert.equal(BOARD_SIZE, 3);
  assert.equal(CELL_COUNT, 9);
  assert.equal(MEGA_SIZE, 3);
  assert.equal(MAX_BOARDS, 9);
  assert.equal(MAX_MEGA_STAGE, 3);
  assert.equal(FIRST_SEAT, "player1");
  assert.equal(SUDDEN_DEATH_BOARD_INDEX, -1);
  assert.equal(MATCH_STATUS.PLAYING, "playing");
  // Distinct from Mini Golf's 0x4d474c46 ("MGLF") so the locks never contend.
  assert.equal(TIC_TAC_TOE_LOCK_NAMESPACE, 0x54494354);
  assert.notEqual(TIC_TAC_TOE_LOCK_NAMESPACE, 0x4d474c46);
});

test("constants: the eight cell lines and the eight Mega lines are complete and distinct", () => {
  assert.equal(WINNING_LINES.length, 8);
  assert.equal(MEGA_WINNING_LINES.length, 8);
  for (const line of [...WINNING_LINES, ...MEGA_WINNING_LINES]) {
    assert.equal(line.length, 3);
    for (const index of line) assert.ok(index >= 0 && index < CELL_COUNT);
  }
  const megaKeys = MEGA_WINNING_LINES.map((line) => [...line].sort((a, b) => a - b).join(","));
  assert.equal(new Set(megaKeys).size, 8);
  // Every cell of a small board participates in at least one line.
  assert.equal(new Set(WINNING_LINES.flat()).size, CELL_COUNT);
});

test("stage geometry: stages expose 1, 4 and 9 slots, and membership only grows", () => {
  assert.deepEqual(stageBoardSlots(1), [0]);
  assert.deepEqual(stageBoardSlots(2), [0, 1, 3, 4]);
  assert.deepEqual(stageBoardSlots(3), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...STAGE_BOARD_SLOTS[2]], [0, 1, 3, 4]);
  // Support exactly 1, 4 and 9 boards.
  assert.equal(stageBoardSlots(1).length, 1);
  assert.equal(stageBoardSlots(2).length, 4);
  assert.equal(stageBoardSlots(3).length, 9);
  // An expansion only ever ADDS slots — the original board always keeps slot 0.
  for (const slot of STAGE_BOARD_SLOTS[1]) assert.ok(STAGE_BOARD_SLOTS[2].includes(slot));
  for (const slot of STAGE_BOARD_SLOTS[2]) assert.ok(STAGE_BOARD_SLOTS[3].includes(slot));
  // Out-of-range stages clamp rather than throwing.
  assert.deepEqual(stageBoardSlots(0), stageBoardSlots(1));
  assert.deepEqual(stageBoardSlots(99), stageBoardSlots(3));
});

test("Mega lines begin at Round 3: a 2x2 has NO Mega line", () => {
  assert.deepEqual(megaLinesForStage(1), []);
  assert.deepEqual(megaLinesForStage(2), []);
  assert.equal(megaLinesForStage(3).length, 8);
});

test("seats: mark mapping, inversion and participation", () => {
  assert.equal(markForSeat("player1"), "X");
  assert.equal(markForSeat("player2"), "O");
  assert.equal(seatForMark("X"), "player1");
  assert.equal(seatForMark("O"), "player2");
  assert.equal(otherSeat("player1"), "player2");
  assert.equal(otherSeat("player2"), "player1");
  assert.equal(seatForPly(0), "player1");
  assert.equal(seatForPly(1), "player2");
  assert.equal(seatForUser(SEATS, ALICE), "player1");
  assert.equal(seatForUser(SEATS, BOB), "player2");
  assert.equal(seatForUser(SEATS, MALLORY), null);
  assert.equal(seatForUser(SEATS, null), null);
  assert.equal(userIdForSeat(SEATS, "player1"), ALICE);
  assert.equal(userIdForSeat({ player1Id: ALICE, player2Id: null }, "player2"), null);
  assert.deepEqual(seatsFromMatch({ player1Id: ALICE }), { player1Id: ALICE, player2Id: null });
});

// ── The opening position ──────────────────────────────────────────────────

test("createInitialState: one empty board, X to move, no seed, no randomness", () => {
  const state = createInitialState();
  assert.equal(state.version, 1);
  assert.equal(state.phase, "playing");
  assert.equal(state.stage, 1);
  assert.equal(state.ply, 0);
  assert.equal(state.currentTurn, "player1");
  assert.equal(state.winner, null);
  assert.equal(state.winningBoards, null);
  assert.equal(state.tiebreak, null);
  assert.equal(state.suddenDeath, null);
  assert.equal(state.lastMove, null);
  assert.equal(state.boards.length, MAX_BOARDS);
  assert.equal(state.boards[0].cells.length, CELL_COUNT);
  assert.ok(state.boards[0].cells.every((cell) => cell === null));
  // Only slot 0 exists at stage 1 — the rest are un-materialised placeholders.
  for (let slot = 1; slot < MAX_BOARDS; slot += 1) assert.equal(state.boards[slot], null);
  assert.deepEqual(createInitialState(), createInitialState());
  assert.equal("seed" in state, false);
});

// ── Round 1 ───────────────────────────────────────────────────────────────

test("Round 1: a normal 3x3 win ends the WHOLE match immediately — no expansion", () => {
  const state = playRound1([0, 3, 1, 4, 2]);
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, "player1");
  assert.equal(state.stage, 1);
  assert.deepEqual(state.winningBoards, [0]);
  assert.deepEqual(state.boards[0].winningLine, [0, 1, 2]);
  assert.equal(state.boards[0].control, "X");
  assert.equal(state.boards.filter((board) => board !== null).length, 1);
  assert.deepEqual(computeMatchResult(state), { result: RESULT.PLAYER1, winnerSeat: "player1" });
  assert.equal(statusForState(state), MATCH_STATUS.FINISHED);
});

test("Round 1: O can win it too, and the win is locked to the O seat", () => {
  const state = playRound1([3, 0, 4, 1, 7, 2]);
  assert.equal(state.winner, "player2");
  assert.deepEqual(state.winningBoards, [0]);
  assert.deepEqual(state.boards[0].winningLine, [0, 1, 2]);
  assert.deepEqual(computeMatchResult(state), { result: RESULT.PLAYER2, winnerSeat: "player2" });
});

test("Round 1 draw: a full board with no line EXPANDS the match to four boards", () => {
  const state = playRound1(DRAW_CELL_ORDER);
  assert.equal(state.ply, 9);
  assert.equal(state.phase, "playing");
  assert.equal(state.winner, null);
  assert.equal(state.stage, 2);
  assert.equal(state.boards[0].control, "draw");
  assert.deepEqual(state.boards[0].cells, DRAW_CELLS);
  assert.deepEqual(activeBoardIndexes(state), [1, 3, 4]);
  assert.deepEqual(completedBoardIndexes(state), [0]);
});

test("expansion 1 → 4: three new EMPTY boards, the original board preserved", () => {
  const state = playRound1(DRAW_CELL_ORDER);
  assert.deepEqual(state.boards[0].cells, DRAW_CELLS);
  for (const slot of [1, 3, 4]) {
    assert.equal(state.boards[slot].cells.length, CELL_COUNT, `slot ${slot} has nine cells`);
    assert.ok(
      state.boards[slot].cells.every((cell) => cell === null),
      `slot ${slot} empty`
    );
    assert.equal(state.boards[slot].control, "active");
    assert.equal(state.boards[slot].plies, 0);
    assert.equal(state.boards[slot].winningLine, null);
  }
  // Slots outside the new stage stay un-materialised.
  for (const slot of [2, 5, 6, 7, 8]) assert.equal(state.boards[slot], null);
});

test("preservation: later-stage moves never mutate the original board", () => {
  let state = playRound1(DRAW_CELL_ORDER);
  const original = JSON.stringify(state.boards[0].cells);
  state = applyMove({ state, seat: state.currentTurn, boardIndex: 1, cellIndex: 0 }).state;
  state = applyMove({ state, seat: state.currentTurn, boardIndex: 3, cellIndex: 4 }).state;
  state = applyMove({ state, seat: state.currentTurn, boardIndex: 4, cellIndex: 8 }).state;
  assert.equal(JSON.stringify(state.boards[0].cells), original);
  assert.equal(state.boards[0].control, "draw");
});

// ── Round 2 ───────────────────────────────────────────────────────────────

test("Round 2: a small-board win LOCKS that board without ending the match", () => {
  const state = craft({
    stage: 2,
    ply: 9,
    currentTurn: "player1",
    boards: {
      0: board(DRAW_CELLS),
      1: board(X_PENDING),
      3: createEmptyBoard(),
      4: createEmptyBoard(),
    },
  });
  const applied = applyMove({ state, seat: "player1", boardIndex: 1, cellIndex: 2 });
  assert.equal(applied.boardResolved, true);
  assert.equal(applied.state.boards[1].control, "X");
  assert.deepEqual(applied.state.boards[1].winningLine, [0, 1, 2]);
  assert.equal(applied.matchCompleted, false);
  assert.equal(applied.state.phase, "playing");
  assert.deepEqual(activeBoardIndexes(applied.state), [3, 4]);
  assert.deepEqual(completedBoardIndexes(applied.state), [0, 1]);
});

test("Round 2: a small-board DRAW also locks it, and the match continues", () => {
  const nearDraw = (() => {
    const cells = new Array(CELL_COUNT).fill(null);
    DRAW_CELL_ORDER.slice(0, 8).forEach((cell, ply) => {
      cells[cell] = ply % 2 === 0 ? "X" : "O";
    });
    return cells;
  })();
  const state = craft({
    stage: 2,
    ply: 9,
    currentTurn: "player1",
    boards: {
      0: board(DRAW_CELLS),
      1: board(nearDraw),
      3: createEmptyBoard(),
      4: createEmptyBoard(),
    },
  });
  const applied = applyMove({
    state,
    seat: "player1",
    boardIndex: 1,
    cellIndex: DRAW_CELL_ORDER[8],
  });
  assert.equal(applied.state.boards[1].control, "draw");
  assert.equal(applied.boardResolved, true);
  assert.equal(applied.matchCompleted, false);
  assert.equal(applied.stageAdvanced, false);
});

test("Round 2: a 2x2 'diagonal' of controlled boards is NOT a Mega victory", () => {
  const lattice = Array.from({ length: MAX_BOARDS }, () => null);
  lattice[0] = board(X_SWEEP);
  lattice[4] = board(X_SWEEP);
  lattice[1] = board(O_SWEEP);
  lattice[3] = board(DRAW_CELLS);
  // Slots 0 and 4 are the 2x2 "diagonal"; a Mega line needs a THIRD collinear board.
  assert.equal(findMegaWin(lattice, 2), null);
  // Even read as a 3x3, the [0,4,8] line is incomplete (slot 8 does not exist).
  assert.equal(findMegaWin(lattice, 3), null);
});

test("Round 2 → Round 3: all four boards resolved with no Mega winner expands to nine", () => {
  const state = craft({
    stage: 2,
    ply: 36,
    currentTurn: "player1",
    boards: {
      0: board(DRAW_CELLS),
      1: board(X_SWEEP),
      3: board(O_SWEEP),
      4: board(X_PENDING),
    },
  });
  const applied = applyMove({ state, seat: "player1", boardIndex: 4, cellIndex: 2 });
  assert.equal(applied.matchCompleted, false);
  assert.equal(applied.stageAdvanced, true);
  assert.equal(applied.stage, 3);
  assert.equal(applied.state.stage, 3);
  assert.equal(applied.state.boards.filter((b) => b !== null).length, 9);
  // Every earlier board survives, byte for byte.
  assert.deepEqual(applied.state.boards[0].cells, DRAW_CELLS);
  assert.deepEqual(applied.state.boards[1].cells, X_SWEEP);
  assert.deepEqual(applied.state.boards[3].cells, O_SWEEP);
  assert.equal(applied.state.boards[4].control, "X");
  for (const slot of [2, 5, 6, 7, 8]) {
    assert.ok(
      applied.state.boards[slot].cells.every((cell) => cell === null),
      `slot ${slot} new`
    );
  }
});

test("Round 2: resolving its four boards never finishes the match, it expands", () => {
  const state = craft({
    stage: 2,
    ply: 36,
    currentTurn: "player1",
    boards: { 0: board(X_SWEEP), 4: board(X_SWEEP), 1: board(O_SWEEP), 3: board(X_PENDING) },
  });
  const applied = applyMove({ state, seat: "player1", boardIndex: 3, cellIndex: 2 });
  assert.equal(applied.matchCompleted, false);
  assert.equal(applied.winnerSeat, null);
  assert.deepEqual(applied.state.winningBoards, null);
  assert.equal(applied.stageAdvanced, true);
  assert.equal(applied.state.stage, 3);
});

// ── Round 3 Mega wins ─────────────────────────────────────────────────────

test("Round 3 Mega win — HORIZONTAL: three controlled boards in a row end the match", () => {
  const state = craft({
    stage: 3,
    ply: 45,
    currentTurn: "player1",
    boards: {
      0: board(X_SWEEP),
      1: board(X_SWEEP),
      2: board(X_PENDING),
      3: createEmptyBoard(),
      4: createEmptyBoard(),
    },
  });
  const applied = applyMove({ state, seat: "player1", boardIndex: 2, cellIndex: 2 });
  assert.equal(applied.matchCompleted, true);
  assert.equal(applied.winnerSeat, "player1");
  assert.deepEqual(applied.winningBoards, [0, 1, 2]);
  assert.equal(applied.state.phase, "finished");
  assert.equal(applied.state.winner, "player1");
  assert.deepEqual(computeMatchResult(applied.state), {
    result: RESULT.PLAYER1,
    winnerSeat: "player1",
  });
});

test("Round 3 Mega win — VERTICAL: three controlled boards in a column end the match", () => {
  const state = craft({
    stage: 3,
    ply: 45,
    currentTurn: "player1",
    boards: {
      0: board(X_SWEEP),
      3: board(X_SWEEP),
      6: board(X_PENDING),
      1: createEmptyBoard(),
      4: createEmptyBoard(),
    },
  });
  const applied = applyMove({ state, seat: "player1", boardIndex: 6, cellIndex: 2 });
  assert.equal(applied.matchCompleted, true);
  assert.deepEqual(applied.winningBoards, [0, 3, 6]);
  assert.equal(applied.winnerSeat, "player1");
});

test("Round 3 Mega win — DIAGONAL: the main diagonal ends the match", () => {
  const state = craft({
    stage: 3,
    ply: 45,
    currentTurn: "player1",
    boards: {
      0: board(X_SWEEP),
      4: board(X_SWEEP),
      8: board(X_PENDING),
      1: createEmptyBoard(),
      3: createEmptyBoard(),
    },
  });
  const applied = applyMove({ state, seat: "player1", boardIndex: 8, cellIndex: 2 });
  assert.equal(applied.matchCompleted, true);
  assert.deepEqual(applied.winningBoards, [0, 4, 8]);
});

test("Round 3 Mega win — ANTI-DIAGONAL, and O can take a Mega win as well", () => {
  const state = craft({
    stage: 3,
    ply: 45,
    currentTurn: "player2",
    boards: {
      2: board(O_SWEEP),
      4: board(O_SWEEP),
      6: board(O_PENDING),
      0: createEmptyBoard(),
      8: createEmptyBoard(),
    },
  });
  const applied = applyMove({ state, seat: "player2", boardIndex: 6, cellIndex: 5 });
  assert.equal(applied.matchCompleted, true);
  assert.deepEqual(applied.winningBoards, [2, 4, 6]);
  assert.equal(applied.winnerSeat, "player2");
});

test("Round 3: three collinear boards owned by DIFFERENT marks is not a Mega win", () => {
  const state = craft({
    stage: 3,
    ply: 45,
    boards: { 0: board(X_SWEEP), 1: board(X_SWEEP), 2: board(O_SWEEP) },
  });
  assert.equal(findMegaWin(state.boards, 3), null);
});

// ── Round 3 end: tiebreak and sudden death ────────────────────────────────

test("full Round 3 draw: every board resolves, no Mega line → the tiebreaker decides", () => {
  const nearDraw = (() => {
    const cells = new Array(CELL_COUNT).fill(null);
    DRAW_CELL_ORDER.slice(0, 8).forEach((cell, ply) => {
      cells[cell] = ply % 2 === 0 ? "X" : "O";
    });
    return cells;
  })();
  const boards = {};
  for (const slot of [0, 1, 2, 3, 4, 5, 6, 7]) boards[slot] = board(DRAW_CELLS);
  boards[8] = board(nearDraw);
  const state = craft({ stage: 3, ply: 80, currentTurn: "player1", boards });
  const applied = applyMove({
    state,
    seat: "player1",
    boardIndex: 8,
    cellIndex: DRAW_CELL_ORDER[8],
  });
  assert.equal(applied.matchCompleted, true);
  assert.equal(applied.tiebreak.decidedBy, "boards");
  assert.equal(applied.tiebreak.winner, "player1");
  assert.equal(applied.tiebreak.xBoards, 9);
  assert.equal(applied.state.winner, "player1");
  assert.deepEqual(applied.state.winningBoards, null);
  assert.equal(applied.state.suddenDeath, null);
});

test("tiebreaker rule 1: the player controlling the most boards wins", () => {
  const tb = evaluateTiebreak([
    board(X_MAJORITY),
    board(X_MAJORITY),
    board(X_MAJORITY),
    board(O_MAJORITY),
    board(NEUTRAL),
    board(NEUTRAL),
    board(NEUTRAL),
    board(NEUTRAL),
    board(NEUTRAL),
  ]);
  assert.equal(tb.xBoards, 3);
  assert.equal(tb.oBoards, 1);
  assert.equal(tb.neutralBoards, 5);
  assert.equal(tb.decidedBy, "boards");
  assert.equal(tb.winner, "player1");
});

test("tiebreaker rule 2: with the board count tied, the most total cells wins", () => {
  const tb = evaluateTiebreak([
    board(X_MAJORITY),
    board(X_MAJORITY),
    board(O_MAJORITY),
    board(O_MAJORITY),
    board(NEUTRAL),
    board(NEUTRAL),
    board(NEUTRAL),
    board(NEUTRAL),
    board(NEUTRAL),
  ]);
  assert.equal(tb.xBoards, 2);
  assert.equal(tb.oBoards, 2);
  assert.equal(tb.xCells, 2 * 5 + 2 * 1 + 5 * 3); // 27
  assert.equal(tb.oCells, 2 * 1 + 2 * 4 + 5 * 3); // 25
  assert.equal(tb.decidedBy, "cells");
  assert.equal(tb.winner, "player1");
});

test("tiebreaker rule 3: a complete tie requires SUDDEN DEATH (no winner yet)", () => {
  const tb = evaluateTiebreak(new Array(9).fill(board(NEUTRAL)));
  assert.equal(tb.xBoards, 0);
  assert.equal(tb.oBoards, 0);
  assert.equal(tb.neutralBoards, 9);
  assert.equal(tb.xCells, tb.oCells);
  assert.equal(tb.decidedBy, "sudden-death");
  assert.equal(tb.winner, null);
});

test("tiebreaker counts cells, not line-winners: an O-majority board is O-controlled", () => {
  // O never completes a line here, but it occupies more cells.
  const oMajority = board(["O", "O", null, "O", "X", "O", "O", null, null]);
  const tb = evaluateTiebreak([oMajority]);
  assert.equal(tb.oBoards, 1);
  assert.equal(tb.xBoards, 0);
  assert.equal(tb.winner, "player2");
});

test("Round 3 complete tie via a real move starts SUDDEN DEATH, not a result", () => {
  // A "neutral" board (equal X/O cells) is still an O-CONTROLLED board to the
  // Mega lines, so the arrangement must avoid three collinear boards of the
  // same control. This layout (X on {0,1,5,6}, O elsewhere) has no Mega line
  // before OR after the final move, yet ties on both board count and cell count.
  const boards = {
    0: board(X_SWEEP),
    1: board(X_SWEEP),
    2: board(O_SWEEP),
    3: board(O_SWEEP),
    4: board(O_PENDING), // X=3 O=2; O's next move makes it a 3/3 (cell-neutral) board
    5: board(X_SWEEP),
    6: board(X_SWEEP),
    7: board(O_SWEEP),
    8: board(O_SWEEP),
  };
  const state = craft({ stage: 3, ply: 45, currentTurn: "player2", boards });
  assert.equal(findMegaWin(state.boards, 3), null);
  const applied = applyMove({ state, seat: "player2", boardIndex: 4, cellIndex: 5 });
  assert.equal(findMegaWin(applied.state.boards, 3), null);
  assert.equal(applied.tiebreak.xBoards, applied.tiebreak.oBoards);
  assert.equal(applied.tiebreak.xCells, applied.tiebreak.oCells);
  assert.equal(applied.matchCompleted, false);
  assert.equal(applied.tiebreak.decidedBy, "sudden-death");
  assert.equal(applied.tiebreak.winner, null);
  assert.equal(applied.suddenDeath, true);
  assert.equal(applied.state.phase, "playing");
  assert.equal(applied.state.suddenDeath.boards.length, 1);
  assert.ok(applied.state.suddenDeath.boards[0].cells.every((cell) => cell === null));
  assert.equal(applied.state.currentTurn, "player1");
});

test("sudden death: only boardIndex -1 is legal while it is active", () => {
  const state = craft({
    stage: 3,
    ply: 54,
    currentTurn: "player1",
    suddenDeath: { boards: [createEmptyBoard()] },
  });
  for (const bad of [0, 1, 8]) {
    const res = validateMove({ state, seat: "player1", boardIndex: bad, cellIndex: 0 });
    assert.equal(res.ok, false, `board ${bad}`);
    assert.equal(res.status, 409, `board ${bad}`);
  }
  assert.equal(
    validateMove({ state, seat: "player1", boardIndex: SUDDEN_DEATH_BOARD_INDEX, cellIndex: 0 }).ok,
    true
  );
});

test("sudden death: a line on the sudden-death board wins the match", () => {
  let state = craft({
    stage: 3,
    ply: 54,
    currentTurn: "player1",
    suddenDeath: { boards: [createEmptyBoard()] },
  });
  for (const cellIndex of [0, 3, 1, 4, 2]) {
    state = applyMove({
      state,
      seat: state.currentTurn,
      boardIndex: SUDDEN_DEATH_BOARD_INDEX,
      cellIndex,
    }).state;
  }
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, "player1");
  assert.equal(currentSuddenDeathBoard(state) !== null, true);
});

test("sudden death: a drawn board starts another one, with X to move", () => {
  let state = craft({
    stage: 3,
    ply: 54,
    currentTurn: "player1",
    suddenDeath: { boards: [createEmptyBoard()] },
  });
  const seq = [
    [0, "player1"],
    [1, "player2"],
    [2, "player1"],
    [4, "player2"],
    [3, "player1"],
    [5, "player2"],
    [7, "player1"],
    [6, "player2"],
    [8, "player1"],
  ];
  for (const [cellIndex, seat] of seq) {
    state = applyMove({ state, seat, boardIndex: SUDDEN_DEATH_BOARD_INDEX, cellIndex }).state;
  }
  assert.equal(state.phase, "playing");
  assert.equal(state.suddenDeath.boards.length, 2);
  assert.equal(state.currentTurn, "player1");
  const current = currentSuddenDeathBoard(state);
  assert.ok(current.cells.every((cell) => cell === null));
});

// ── Server-derived board groupings ────────────────────────────────────────

test("the server derives round, active boards, completed boards and control", () => {
  const state = playRound1(DRAW_CELL_ORDER);
  assert.equal(state.stage, 2);
  assert.deepEqual(activeBoardIndexes(state), [1, 3, 4]);
  assert.deepEqual(completedBoardIndexes(state), [0]);
  assert.equal(boardControlAt(state, 0), "draw");
  assert.equal(boardControlAt(state, 1), "active");
  assert.equal(boardControlAt(state, 2), null); // not materialised
  assert.equal(boardControlAt(state, 5), null);
});

test("countCells counts a mark and ignores empties", () => {
  const cells = ["X", "O", null, "X", null, null, "O", null, "X"];
  assert.equal(countCells(cells, "X"), 3);
  assert.equal(countCells(cells, "O"), 2);
});

// ── Validation ────────────────────────────────────────────────────────────

test("validation: a move must name BOTH a valid board and a valid cell", () => {
  const state = createInitialState();
  assert.equal(validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0 }).ok, true);
  // Stage 1 has only slot 0; slots 1..8 are not in play yet.
  const notYet = validateMove({ state, seat: "player1", boardIndex: 1, cellIndex: 0 });
  assert.equal(notYet.ok, false);
  assert.equal(notYet.status, 409);
  assert.match(notYet.error, /not in play/i);
});

test("validation: an invalid board index is a 400 and is never coerced", () => {
  const state = createInitialState();
  for (const bad of [undefined, null, "", true, [], {}, -1, 9, 1.5, NaN, Infinity, "0"]) {
    const res = validateMove({ state, seat: "player1", boardIndex: bad, cellIndex: 0 });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("validation: an invalid cell index is a 400 and is never coerced", () => {
  const state = createInitialState();
  for (const bad of [undefined, null, "", true, [], {}, -1, 9, 1.5, NaN, Infinity, "0"]) {
    const res = validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("validation: a move on a locked (won or drawn) board is refused", () => {
  const won = craft({ stage: 3, boards: { 0: board(X_SWEEP), 1: createEmptyBoard() } });
  const res = validateMove({ state: won, seat: "player1", boardIndex: 0, cellIndex: 5 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /locked/i);

  const drawn = craft({ stage: 3, boards: { 0: board(DRAW_CELLS), 1: createEmptyBoard() } });
  const res2 = validateMove({ state: drawn, seat: "player1", boardIndex: 0, cellIndex: 0 });
  assert.equal(res2.ok, false);
  assert.equal(res2.status, 409);
});

test("validation: an out-of-turn move is refused", () => {
  const state = createInitialState();
  const res = validateMove({ state, seat: "player2", boardIndex: 0, cellIndex: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /not your turn/i);
});

test("validation: a duplicate (occupied-cell) move is refused", () => {
  let state = createInitialState();
  state = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 4 }).state;
  const dup = validateMove({ state, seat: "player2", boardIndex: 0, cellIndex: 4 });
  assert.equal(dup.ok, false);
  assert.equal(dup.status, 409);
  assert.match(dup.error, /occupied/i);
});

test("validation: a stale expectedVersion is refused, the current one accepted", () => {
  let state = createInitialState();
  state = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0 }).state;
  assert.equal(state.version, 2);
  const stale = validateMove({
    state,
    seat: "player2",
    boardIndex: 0,
    cellIndex: 1,
    expectedVersion: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.match(stale.error, /stale/i);
  assert.equal(
    validateMove({ state, seat: "player2", boardIndex: 0, cellIndex: 1, expectedVersion: 2 }).ok,
    true
  );
});

test("validation: expectedVersion is checked strictly — no Number() coercion", () => {
  let state = createInitialState();
  state = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0 }).state;
  state = applyMove({ state, seat: "player2", boardIndex: 0, cellIndex: 1 }).state;
  assert.equal(state.version, 3);
  for (const bad of ["3", "", true, false, [3], {}, 3.5, NaN, Infinity]) {
    const res = validateMove({
      state,
      seat: "player1",
      boardIndex: 0,
      cellIndex: 2,
      expectedVersion: bad,
    });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.status, 409, JSON.stringify(bad));
  }
  assert.equal(validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 2 }).ok, true);
  assert.equal(
    validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 2, expectedVersion: null }).ok,
    true
  );
  assert.equal(
    validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 2, expectedVersion: 3 }).ok,
    true
  );
});

test("validation: an unauthorized player (no seat) gets a 403", () => {
  const state = createInitialState();
  const res = validateMove({ state, seat: null, boardIndex: 0, cellIndex: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.match(res.error, /participant/i);
});

test("validation: no move is accepted once the match is finished", () => {
  const state = playRound1([0, 3, 1, 4, 2]);
  const res = validateMove({ state, seat: "player2", boardIndex: 0, cellIndex: 5 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /finished/i);
});

test("isValidBoardIndex / isValidCellIndex accept only strict integers in range", () => {
  for (const good of [0, 1, 8]) {
    assert.equal(isValidBoardIndex(good), true, String(good));
    assert.equal(isValidCellIndex(good), true, String(good));
  }
  assert.equal(isValidBoardIndex(9), false);
  assert.equal(isValidBoardIndex(-1), false);
  for (const bad of ["0", "", true, null, undefined, [], {}, 1.5, NaN, Infinity]) {
    assert.equal(isValidBoardIndex(bad), false, JSON.stringify(bad));
    assert.equal(isValidCellIndex(bad), false, JSON.stringify(bad));
  }
});

// ── Authority: nothing is accepted from the client ────────────────────────

test("authority: the mark, stage, ply and result are DERIVED, never accepted", () => {
  const state = createInitialState();
  const res = validateMove({
    state,
    seat: "player1",
    boardIndex: 0,
    cellIndex: 0,
    // Fields a hostile client might attach — none exist as parameters.
    winner: "player2",
    result: "player2",
    score: 99,
    stage: 3,
    round: 3,
    board: ["O", "O", "O", null, null, null, null, null, null],
    boards: [board(O_MAJORITY)],
    ply: 81,
    currentTurn: "player2",
    tiebreak: { winner: "player2" },
  });
  assert.equal(res.ok, true);
  const applied = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0 });
  assert.equal(applied.state.boards[0].cells[0], "X"); // the server's mark, not the client's O
  assert.equal(applied.state.stage, 1); // client's stage/round ignored
  assert.equal(applied.state.ply, 1);
  assert.equal(applied.state.winner, null);
});

test("applyMove throws on an out-of-range or out-of-play move", () => {
  const state = createInitialState();
  for (const bad of [9, 1.5, NaN]) {
    assert.throws(
      () => applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: bad }),
      RangeError
    );
  }
  assert.throws(
    () => applyMove({ state, seat: "player1", boardIndex: 9, cellIndex: 0 }),
    RangeError
  );
  assert.throws(
    () => applyMove({ state, seat: "player1", boardIndex: 1, cellIndex: 0 }),
    RangeError
  );
  // -1 is the sudden-death sentinel; with no sudden death active it is refused.
  assert.throws(
    () => applyMove({ state, seat: "player1", boardIndex: -1, cellIndex: 0 }),
    RangeError
  );
});

// ── Board well-formedness ─────────────────────────────────────────────────

test("every small board holds exactly nine null/X/O cells", () => {
  assert.equal(createEmptyBoard().cells.length, CELL_COUNT);
  const state = playRound1(DRAW_CELL_ORDER);
  for (const b of state.boards.filter(Boolean)) assert.equal(b.cells.length, CELL_COUNT);
  assert.equal(isWellFormedBoard(createEmptyBoard().cells), true);
  assert.equal(isWellFormedBoard(new Array(9).fill(null)), true);
  assert.equal(isWellFormedBoard(new Array(8).fill(null)), false);
  assert.equal(isWellFormedBoard(new Array(10).fill(null)), false);
  assert.equal(isWellFormedBoard(new Array(9).fill("Z")), false);
  assert.equal(isWellFormedBoard(null), false);
});

test("findWinningLine / isBoardFull report a small board's completed line", () => {
  assert.deepEqual(findWinningLine(["X", "X", "X", null, null, null, null, null, null]), {
    mark: "X",
    line: [0, 1, 2],
  });
  assert.deepEqual(
    findWinningLine([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ([2, 4, 6].includes(i) ? "X" : null))),
    { mark: "X", line: [2, 4, 6] }
  );
  assert.equal(findWinningLine(new Array(9).fill(null)), null);
  assert.equal(isBoardFull(DRAW_CELLS), true);
  assert.equal(isBoardFull(["X", null, null, null, null, null, null, null, null]), false);
});

// ── View projection ───────────────────────────────────────────────────────

test("normalizeForViewer projects seat, stage, boards and the move gate", () => {
  const state = playRound1(DRAW_CELL_ORDER); // stage 2, O to move
  const asAlice = normalizeForViewer({
    state,
    seats: SEATS,
    viewerId: ALICE,
    status: MATCH_STATUS.PLAYING,
  });
  assert.equal(asAlice.viewerSeat, "player1");
  assert.equal(asAlice.viewerMark, "X");
  assert.equal(asAlice.stage, 2);
  assert.deepEqual(asAlice.stageBoardSlots, [0, 1, 3, 4]);
  assert.deepEqual(asAlice.activeBoards, [1, 3, 4]);
  assert.deepEqual(asAlice.completedBoards, [0]);
  assert.equal(asAlice.isViewerTurn, false);
  assert.equal(asAlice.viewerCanMove, false);
  assert.equal(asAlice.currentTurnUserId, BOB);

  const asBob = normalizeForViewer({
    state,
    seats: SEATS,
    viewerId: BOB,
    status: MATCH_STATUS.PLAYING,
  });
  assert.equal(asBob.viewerSeat, "player2");
  assert.equal(asBob.viewerMark, "O");
  assert.equal(asBob.isViewerTurn, true);
  assert.equal(asBob.viewerCanMove, true);

  const asOutsider = normalizeForViewer({
    state,
    seats: SEATS,
    viewerId: MALLORY,
    status: MATCH_STATUS.PLAYING,
  });
  assert.equal(asOutsider.viewerSeat, null);
  assert.equal(asOutsider.viewerMark, null);
  assert.equal(asOutsider.viewerCanMove, false);
});

test("normalizeForViewer never offers a move once the match is decided", () => {
  const state = playRound1([0, 3, 1, 4, 2]);
  const dto = normalizeForViewer({ state, seats: SEATS, viewerId: ALICE });
  assert.equal(dto.phase, "finished");
  assert.equal(dto.viewerCanMove, false);
  assert.equal(dto.status, MATCH_STATUS.FINISHED);
  assert.equal(dto.winner, "player1");
  assert.deepEqual(dto.winningBoards, [0]);
  assert.equal(dto.boardSize, BOARD_SIZE);
  assert.equal(dto.megaSize, MEGA_SIZE);
  assert.equal(dto.maxBoards, MAX_BOARDS);
});

test("normalizeForViewer takes the settled outcome from the ROW, not the boards", () => {
  const state = playRound1([0]);
  const dto = normalizeForViewer({
    state,
    seats: SEATS,
    viewerId: ALICE,
    status: MATCH_STATUS.FINISHED,
    result: RESULT.PLAYER2,
    winnerId: BOB,
  });
  assert.equal(dto.status, MATCH_STATUS.FINISHED);
  assert.equal(dto.result, RESULT.PLAYER2);
  assert.equal(dto.winnerId, BOB);
  assert.equal(dto.viewerCanMove, false);
});

// ── The move log is the source of truth ───────────────────────────────────

test("replayMoves reconstructs stage, boards and winner from the log", () => {
  const log = DRAW_CELL_ORDER.map((cellIndex, ply) => ({
    ply,
    playerId: ply % 2 === 0 ? ALICE : BOB,
    boardIndex: 0,
    cellIndex,
  }));
  const rebuilt = replayMoves(log);
  const state = playRound1(DRAW_CELL_ORDER);
  assert.deepEqual(rebuilt.boards, state.boards);
  assert.equal(rebuilt.stage, 2);
  assert.equal(rebuilt.ply, 9);
  assert.equal(rebuilt.winner, null);
});

test("replayMoves agrees with applyMove across a Round 1 win", () => {
  const cells = [0, 3, 1, 4, 2];
  const log = cells.map((cellIndex, ply) => ({
    ply,
    playerId: ply % 2 === 0 ? ALICE : BOB,
    boardIndex: 0,
    cellIndex,
  }));
  const rebuilt = replayMoves(log);
  const state = playRound1(cells);
  assert.deepEqual(rebuilt.boards, state.boards);
  assert.equal(rebuilt.winner, "player1");
  assert.deepEqual(rebuilt.winningBoards, [0]);
});

test("replayMoves is order- and duplicate-tolerant and ignores unplayable moves", () => {
  const rebuilt = replayMoves([
    { ply: 1, playerId: BOB, boardIndex: 0, cellIndex: 4 },
    { ply: 0, playerId: ALICE, boardIndex: 0, cellIndex: 0 },
    // A duplicate cell is skipped rather than corrupting the board.
    { ply: 2, playerId: ALICE, boardIndex: 0, cellIndex: 0 },
    // A board that is not in play at this stage is skipped too.
    { ply: 3, playerId: BOB, boardIndex: 7, cellIndex: 1 },
  ]);
  assert.equal(rebuilt.boards[0].cells[0], "X");
  assert.equal(rebuilt.boards[0].cells[4], "O");
  assert.equal(rebuilt.ply, 2);
  assert.equal(rebuilt.boards[7], null);
});

test("fuzz: a random multi-board game keeps applyMove and replayMoves in lockstep", () => {
  // Deterministic LCG so a failure is reproducible without a seed dependency.
  let seed = 987654321;
  const rnd = (max) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };

  for (let game = 0; game < 300; game += 1) {
    let state = createInitialState();
    const log = [];
    for (let step = 0; step < 200 && state.phase === "playing"; step += 1) {
      const seat = state.currentTurn;
      let boardIndex;
      if (state.suddenDeath) {
        boardIndex = SUDDEN_DEATH_BOARD_INDEX;
      } else {
        const actives = activeBoardIndexes(state);
        if (actives.length === 0) break;
        boardIndex = actives[rnd(actives.length)];
      }
      const target =
        boardIndex === SUDDEN_DEATH_BOARD_INDEX
          ? currentSuddenDeathBoard(state)
          : state.boards[boardIndex];
      const empties = target.cells
        .map((cell, index) => (cell === null ? index : -1))
        .filter((i) => i >= 0);
      const cellIndex = empties[rnd(empties.length)];

      const applied = applyMove({ state, seat, boardIndex, cellIndex });
      log.push({
        ply: state.ply,
        playerId: seat === "player1" ? ALICE : BOB,
        boardIndex,
        cellIndex,
      });
      state = applied.state;

      // Optimistic-concurrency counters advance together, monotonically.
      assert.equal(state.version, log.length + 1, `game ${game} step ${step}`);
      assert.equal(state.ply, log.length, `game ${game} step ${step}`);

      const rebuilt = replayMoves(log);
      assert.deepEqual(rebuilt.boards, state.boards, `game ${game} step ${step}`);
      assert.equal(rebuilt.stage, state.stage, `game ${game} step ${step}`);
      assert.equal(rebuilt.ply, state.ply, `game ${game} step ${step}`);
      assert.equal(rebuilt.winner, state.winner, `game ${game} step ${step}`);
    }
  }
});
