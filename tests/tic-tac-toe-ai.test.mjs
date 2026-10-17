/**
 * tic-tac-toe-ai.test.mjs
 *
 * The Tic-Tac-Toe practice bot, pinned.
 *
 * Two layers are under test:
 *
 *   • `chooseAiCell` — the single 3x3 board solver. A pure function of
 *     (board, seat, difficulty, random), so every tier can be driven exactly.
 *   • `chooseAiMove` — the Ultimate chooser. It must obey the SAME authoritative
 *     legal-move rules the server enforces (required destination, free choice,
 *     never a resolved board or occupied cell) and never return a move
 *     `validateMove` would reject.
 *
 * The AI test suite asserts that property the way the server does: every
 * candidate is checked through `validateMove`, and a full match is played with
 * the bot on both seats.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { chooseAiCell, chooseAiMove } from "../src/lib/tic-tac-toe/ai.ts";
import {
  applyMove,
  createInitialState,
  findLatticeWin,
  findWinningLine,
  markForSeat,
  nextBoardForCell,
  playableBoardIndexes,
  resolveBoardControl,
  validateMove,
} from "../src/lib/tic-tac-toe/rules.ts";
import { CELL_COUNT, MAX_BOARDS } from "../src/lib/tic-tac-toe/constants.ts";

const empty = () => new Array(CELL_COUNT).fill(null);

/**
 * The cells of ONE 3x3 board after a list of moves in turn order (X opens).
 *
 * Deliberately a plain cells array: `chooseAiCell` solves a single board, which
 * is a different object from a whole match state, and no match rules apply here.
 */
function boardFrom(cells) {
  const board = empty();
  cells.forEach((cell, ply) => {
    board[cell] = ply % 2 === 0 ? "X" : "O";
  });
  return board;
}

/** A deterministic LCG, so a failure is reproducible. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── chooseAiCell: contract ────────────────────────────────────────────────

test("chooseAiCell returns null only when the board is full", () => {
  const full = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
  assert.equal(chooseAiCell({ board: full, seat: "player1" }), null);
  assert.equal(chooseAiCell({ board: full, seat: "player2", difficulty: "hard" }), null);
});

test("chooseAiCell always returns an empty cell in range, across every tier", () => {
  const random = lcg(7);
  for (let game = 0; game < 3; game += 1) {
    for (const difficulty of ["easy", "normal", "hard"]) {
      const board = empty();
      let turn = "X";
      while (!findWinningLine(board) && board.some((c) => c === null)) {
        const seat = turn === "X" ? "player1" : "player2";
        const cell = chooseAiCell({ board, seat, difficulty, random });
        assert.ok(Number.isInteger(cell), "a cell must be returned mid-game");
        assert.ok(cell >= 0 && cell < CELL_COUNT, "in range");
        assert.equal(board[cell], null, "never an occupied cell");
        board[cell] = turn;
        turn = turn === "X" ? "O" : "X";
      }
    }
  }
});

test("chooseAiCell never mutates the board it is given", () => {
  const board = empty();
  board[4] = "X";
  const before = [...board];
  chooseAiCell({ board, seat: "player2", difficulty: "hard" });
  assert.deepEqual(board, before);
});

// ── chooseAiCell: hard ────────────────────────────────────────────────────

test("hard takes an immediate winning move", () => {
  // O (player2) holds 0 and 1; the win is cell 2. A clean roll (no slip) so the
  // assertion is deterministic.
  const board = boardFrom([3, 0, 4, 1]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }), 2);
});

test("hard blocks the opponent's immediate winning move", () => {
  // X (player1) holds 6 and 7; O must take 8 to deny the row.
  const board = boardFrom([6, 0, 7]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }), 8);
});

test("hard is very strong — it almost never loses, but is no longer unbeatable", () => {
  // `hard` keeps a small slip (an 8% chance per move of taking the 2nd or 3rd
  // best cell), so it can be beaten by a lucky opponent. 10% is the documented
  // ceiling: anything above it means a tier change made `hard` meaningfully
  // weaker, not just beatable.
  //
  // BOTH sides are seeded, so the measurement is the same on every run — a
  // statistical test that flips between runs cannot guard a regression.
  const opponent = lcg(20260401);
  const bot = lcg(20260401 * 7 + 13);
  let losses = 0;
  const games = 60;
  for (let game = 0; game < games; game += 1) {
    const botMark = game % 2 === 0 ? "X" : "O";
    const cells = empty();
    let turn = "X";
    while (!findWinningLine(cells) && cells.some((c) => c === null)) {
      let cell;
      if (turn === botMark) {
        cell = chooseAiCell({
          board: cells,
          // The Seat, not the Mark: `chooseAiCell` derives the mark itself.
          seat: turn === "X" ? "player1" : "player2",
          difficulty: "hard",
          random: bot,
        });
      } else {
        const open = cells.flatMap((c, i) => (c === null ? [i] : []));
        cell = open[Math.floor(opponent() * open.length)];
      }
      cells[cell] = turn;
      turn = turn === "X" ? "O" : "X";
    }
    const win = findWinningLine(cells);
    if (win && win.mark !== botMark) losses += 1;
  }
  assert.ok(losses <= games * 0.1, `hard must rarely lose (lost ${losses}/${games})`);
});

test("the tiers are ordered by strength: hard beats normal beats easy", () => {
  // Strength here is measured the way it matters — LOSSES against the same
  // seeded random opponent across the same seeded games. Wins alone are a poor
  // metric on a solved-draw board: a perfect tier draws most games, so its win
  // count can sit below a luckier shallow tier while it is clearly stronger.
  //
  // Every tier plays the SAME opponent rolls, so the only variable is the tier.
  const againstRandom = (difficulty) => {
    const opponent = lcg(777);
    const bot = lcg(777 * 7 + 13);
    let wins = 0;
    let losses = 0;
    const games = 60;
    for (let game = 0; game < games; game += 1) {
      const botMark = game % 2 === 0 ? "X" : "O";
      const cells = empty();
      let turn = "X";
      while (!findWinningLine(cells) && cells.some((c) => c === null)) {
        let cell;
        if (turn === botMark) {
          cell = chooseAiCell({
            board: cells,
            seat: turn === "X" ? "player1" : "player2",
            difficulty,
            random: bot,
          });
        } else {
          const open = cells.flatMap((c, i) => (c === null ? [i] : []));
          cell = open[Math.floor(opponent() * open.length)];
        }
        cells[cell] = turn;
        turn = turn === "X" ? "O" : "X";
      }
      const win = findWinningLine(cells);
      if (win && win.mark === botMark) wins += 1;
      else if (win) losses += 1;
    }
    return { wins, losses };
  };

  const easy = againstRandom("easy");
  const normal = againstRandom("normal");
  const hard = againstRandom("hard");

  assert.ok(hard.losses < normal.losses, `hard (${hard.losses} losses) must lose less than normal (${normal.losses})`);
  assert.ok(normal.losses < easy.losses, `normal (${normal.losses} losses) must lose less than easy (${easy.losses})`);
  assert.ok(hard.wins >= normal.wins, `hard (${hard.wins} wins) must not win less than normal (${normal.wins})`);
  assert.ok(normal.wins > easy.wins, `normal (${normal.wins} wins) must beat easy (${easy.wins})`);
});

// ── chooseAiCell: easy / normal ───────────────────────────────────────────

test("easy picks a cell without any deduction", () => {
  const board = boardFrom([3, 0, 4, 1]);
  const cell = chooseAiCell({ board, seat: "player2", difficulty: "easy", random: () => 0 });
  // The empty cells (in index order) are 2, 5, 6, 7, 8 — easy takes the first.
  assert.equal(cell, 2);
  const other = chooseAiCell({ board, seat: "player2", difficulty: "easy", random: () => 0.999 });
  assert.equal(other, 8);
});

test("easy does not always take an available win", () => {
  const board = boardFrom([3, 0, 4, 1]);
  const random = lcg(99);
  const chosen = new Set();
  for (let i = 0; i < 200; i += 1) {
    chosen.add(chooseAiCell({ board, seat: "player2", difficulty: "easy", random }));
  }
  assert.ok(chosen.size > 1, `easy varies its move (saw ${[...chosen].join(",")})`);
});

test("normal usually finds the winning move but can slip", () => {
  const board = boardFrom([3, 0, 4, 1]);
  let wins = 0;
  let slips = 0;
  const random = lcg(4242);
  for (let i = 0; i < 400; i += 1) {
    const cell = chooseAiCell({ board, seat: "player2", difficulty: "normal", random });
    assert.equal(board[cell], null);
    if (cell === 2) wins += 1;
    else slips += 1;
  }
  assert.ok(wins > slips, `expected more wins (${wins}) than slips (${slips})`);
  assert.ok(slips > 0, "normal must remain beatable");
});

test("difficulty is coerced onto the shared scale (unknown → normal)", () => {
  const board = boardFrom([3, 0, 4, 1]);
  for (const roll of [0, 0.5, 0.99]) {
    assert.equal(
      chooseAiCell({ board, seat: "player2", difficulty: "nonsense", random: () => roll }),
      chooseAiCell({ board, seat: "player2", difficulty: "normal", random: () => roll }),
    );
  }
  assert.equal(
    chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }),
    2,
  );
});

// ── Ultimate fixtures ─────────────────────────────────────────────────────

function fixtureBoard(cells) {
  assert.equal(cells.length, CELL_COUNT, "a fixture board must have nine cells");
  const { control, winningLine } = resolveBoardControl(cells);
  return {
    cells: [...cells],
    plies: cells.filter((cell) => cell !== null).length,
    control,
    winningLine,
  };
}

/** A hand-built authoritative position (the same shape the store persists). */
function craft({ boards = {}, currentTurn = "player1", ply = 0, nextBoard = null, phase = "playing" } = {}) {
  return {
    version: 100,
    phase,
    boards: Array.from({ length: MAX_BOARDS }, (_, slot) => boards[slot] ?? null),
    currentTurn,
    ply,
    winner: null,
    winningBoards: null,
    nextBoard,
    lastMove: null,
  };
}

const X_ROW = ["X", "X", "X", "O", "O", null, null, null, null];
const O_ROW = ["O", "O", "O", "X", "X", null, null, null, null];
const X_TWO = ["X", "X", null, "O", "O", null, null, null, null];
const O_TWO = ["O", "O", null, "X", "X", null, null, null, null];
const EMPTY_CELLS = empty();

/** Every move the rules allow right now, checked through `validateMove`. */
function legalMoves(state, seat) {
  const out = [];
  for (const boardIndex of playableBoardIndexes(state)) {
    for (let cellIndex = 0; cellIndex < CELL_COUNT; cellIndex += 1) {
      if (state.boards[boardIndex].cells[cellIndex] !== null) continue;
      if (!validateMove({ state, seat, boardIndex, cellIndex }).ok) continue;
      out.push({ boardIndex, cellIndex });
    }
  }
  return out;
}

/**
 * True when `seat` COULD end the match with one move in this position — i.e. the
 * threat exists, whether or not it is that seat's turn. Used to prove a fixture
 * really contains the danger the bot is supposed to defuse.
 */
function canWinNow(state, seat) {
  for (const boardIndex of playableBoardIndexes(state)) {
    for (let cellIndex = 0; cellIndex < CELL_COUNT; cellIndex += 1) {
      if (state.boards[boardIndex].cells[cellIndex] !== null) continue;
      if (applyMove({ state, seat, boardIndex, cellIndex }).matchCompleted) return true;
    }
  }
  return false;
}

/** True when `seat`, TO MOVE, has a move that ends the whole match right now. */
function hasImmediateMatchWin(state, seat) {
  for (const move of legalMoves(state, seat)) {
    if (applyMove({ state, seat, ...move }).matchCompleted) return true;
  }
  return false;
}

// ── chooseAiMove: the contract the server depends on ──────────────────────

test("chooseAiMove returns null only when there is no legal move", () => {
  const finished = craft({ phase: "finished" });
  assert.equal(chooseAiMove({ state: finished, seat: "player1" }), null);
  // A live match always has one.
  for (const difficulty of ["easy", "normal", "hard"]) {
    assert.ok(chooseAiMove({ state: createInitialState(), seat: "player1", difficulty }));
  }
});

test("chooseAiMove plays the REQUIRED destination while it is active", () => {
  // X opens cell 4 of board 0, so O must answer on board 4.
  let state = applyMove({
    state: createInitialState(),
    seat: "player1",
    boardIndex: 0,
    cellIndex: 4,
  }).state;
  assert.equal(state.nextBoard, 4);

  for (const difficulty of ["easy", "normal", "hard"]) {
    const move = chooseAiMove({ state, seat: "player2", difficulty, random: () => 0.5 });
    assert.equal(move.boardIndex, 4, `${difficulty} must play the forced destination`);
    assert.equal(
      validateMove({ state, seat: "player2", ...move }).ok,
      true,
      `${difficulty} must return a legal move`,
    );
  }
});

test("chooseAiMove chooses freely when the destination is already resolved", () => {
  // Board 5 is claimed by X, so X playing cell 5 hands O a free choice.
  const state = craft({
    boards: {
      0: fixtureBoard(["X", "O", null, null, null, null, null, null, null]),
      5: fixtureBoard(X_ROW),
    },
    currentTurn: "player1",
    ply: 4,
    nextBoard: 0,
  });
  const opened = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 5 }).state;
  assert.equal(opened.nextBoard, null, "the destination resolved → free choice");

  const move = chooseAiMove({ state: opened, seat: "player2", difficulty: "hard", random: () => 0.99 });
  assert.ok(move, "the bot must move");
  assert.notEqual(move.boardIndex, 5, "never a claimed board");
  assert.equal(validateMove({ state: opened, seat: "player2", ...move }).ok, true);
});

test("chooseAiMove never plays a resolved board, an occupied cell or an invalid slot", () => {
  const random = lcg(55577);
  for (const difficulty of ["easy", "normal", "hard"]) {
    let state = createInitialState();
    let steps = 0;
    while (state.phase === "playing" && steps < 200) {
      steps += 1;
      const seat = state.currentTurn;
      const move = chooseAiMove({ state, seat, difficulty, random });
      assert.ok(move, `${difficulty}: a move must exist (step ${steps})`);
      assert.ok(move.cellIndex >= 0 && move.cellIndex < CELL_COUNT, `${difficulty}: cell in range`);
      assert.ok(move.boardIndex >= 0 && move.boardIndex < MAX_BOARDS, `${difficulty}: board in range`);

      // The authority check: the server would accept exactly this move.
      const check = validateMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex });
      assert.equal(check.ok, true, `${difficulty}: rejected move (${followUp(check)})`);

      if (state.nextBoard !== null) {
        assert.equal(move.boardIndex, state.nextBoard, `${difficulty}: must obey the destination`);
      } else {
        assert.equal(state.boards[move.boardIndex].control, "active", `${difficulty}: never a decided board`);
      }
      state = applyMove({ state, seat, ...move }).state;
    }
    assert.equal(state.phase, "finished", `${difficulty}: the game must end`);
  }
});

test("chooseAiMove takes an immediate lattice win", () => {
  // X owns boards 0 and 1; claiming board 2 completes the top row.
  const state = craft({
    currentTurn: "player1",
    ply: 20,
    boards: {
      0: fixtureBoard(X_ROW),
      1: fixtureBoard(X_ROW),
      2: fixtureBoard(X_TWO),
    },
    nextBoard: 2,
  });
  assert.equal(hasImmediateMatchWin(state, "player1"), true, "the win must be available");

  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.deepEqual(move, { boardIndex: 2, cellIndex: 2 });
  const applied = applyMove({ state, seat: "player1", ...move });
  assert.equal(applied.matchCompleted, true);
  assert.deepEqual(applied.winningBoards, [0, 1, 2]);
});

test("chooseAiMove denies the opponent's immediate lattice win", () => {
  // O owns boards 0 and 1 and can claim board 2 at cell 2 to win the match. X
  // is to move, and the destination forces it into board 2 — exactly the board
  // it must defend.
  const state = craft({
    currentTurn: "player1",
    ply: 21,
    boards: {
      0: fixtureBoard(O_ROW),
      1: fixtureBoard(O_ROW),
      2: fixtureBoard(O_TWO),
      3: fixtureBoard(EMPTY_CELLS),
    },
    nextBoard: 2,
  });
  assert.equal(canWinNow(state, "player2"), true, "the threat must be real");

  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.equal(move.boardIndex, 2, "the bot must address the threatened board");
  const applied = applyMove({ state, seat: "player1", ...move }).state;
  assert.equal(hasImmediateMatchWin(applied, "player2"), false, "O must be denied the win");
  assert.equal(findLatticeWin(applied.boards), null);
});

test("chooseAiMove claims a mini-board when that is the best available move", () => {
  // X has two in a row on board 1 and can claim it at cell 2. Board 0 is empty
  // and could not possibly win anything, so claiming is clearly better.
  const state = craft({
    currentTurn: "player1",
    ply: 6,
    boards: {
      0: fixtureBoard(EMPTY_CELLS),
      1: fixtureBoard(X_TWO),
    },
    nextBoard: 1,
  });
  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.deepEqual(move, { boardIndex: 1, cellIndex: 2 });
  const applied = applyMove({ state, seat: "player1", ...move });
  assert.equal(applied.boardClaimed, "X");
  assert.equal(applied.state.boards[1].control, "X");
});

test("chooseAiMove can finish a full match, and the result is consistent", () => {
  const random = lcg(112233);
  let state = createInitialState();
  let steps = 0;
  while (state.phase === "playing" && steps < 200) {
    steps += 1;
    const seat = state.currentTurn;
    const move = chooseAiMove({ state, seat, difficulty: "normal", random });
    assert.ok(move, `a move must exist (step ${steps})`);
    state = applyMove({ state, seat, ...move }).state;
  }
  assert.equal(state.phase, "finished");
  if (state.winner) {
    const line = findLatticeWin(state.boards);
    assert.ok(line, "a win must have a lattice line");
    assert.equal(line.mark, markForSeat(state.winner));
    assert.deepEqual(state.winningBoards, line.line);
  } else {
    assert.equal(findLatticeWin(state.boards), null);
    assert.ok(state.boards.every((board) => board.control !== "active"), "a draw resolves every board");
  }
});

test("chooseAiMove follows every forced destination across a whole match", () => {
  // Both seats are the bot, so the destination chain is exercised end to end:
  // each move must be exactly the board the previous cell index requires.
  const random = lcg(31415);
  let state = createInitialState();
  let steps = 0;
  while (state.phase === "playing" && steps < 200) {
    steps += 1;
    const required = state.nextBoard;
    const seat = state.currentTurn;
    const move = chooseAiMove({ state, seat, difficulty: "easy", random });
    assert.ok(move);
    if (required !== null) assert.equal(move.boardIndex, required, `step ${steps}`);
    const applied = applyMove({ state, seat, ...move }).state;
    if (applied.phase === "playing") {
      // The destination the next seat inherits is exactly this move's cell.
      assert.equal(applied.nextBoard, nextBoardForCell(applied.boards, move.cellIndex));
    }
    state = applied;
  }
  assert.equal(state.phase, "finished");
});

test("chooseAiMove is deterministic under injected randomness and never mutates", () => {
  const build = () => {
    const state = createInitialState();
    return applyMove({ state, seat: "player1", boardIndex: 4, cellIndex: 0 }).state;
  };

  const a = build();
  const b = build();
  const before = JSON.parse(JSON.stringify(a));

  const first = chooseAiMove({ state: a, seat: "player2", difficulty: "normal", random: lcg(7) });
  const second = chooseAiMove({ state: b, seat: "player2", difficulty: "normal", random: lcg(7) });
  assert.deepEqual(first, second, "same state + same roll → same move");
  assert.deepEqual(a, before, "the bot never mutates the state it was given");
});

/** Small helper so a failed validation says why. */
function followUp(check) {
  return check.ok ? "ok" : check.error;
}
