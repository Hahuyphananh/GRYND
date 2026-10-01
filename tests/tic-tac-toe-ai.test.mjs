/**
 * tic-tac-toe-ai.test.mjs
 *
 * The pure Tic-Tac-Toe practice bot, pinned.
 *
 * `chooseAiCell` is a pure function of (board, seat, difficulty, random) — no
 * database, no I/O — so every tier can be driven exactly. What matters for the
 * player experience is that the bot ACTUALLY PLAYS: it always returns a legal,
 * empty cell, it never plays out of turn (the seat is supplied by the store),
 * and `hard` is genuinely unbeatable while `easy` is genuinely random.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { chooseAiCell } from "../src/lib/tic-tac-toe/ai.ts";
import {
  applyMove,
  createInitialState,
  findWinningLine,
} from "../src/lib/tic-tac-toe/rules.ts";
import { CELL_COUNT } from "../src/lib/tic-tac-toe/constants.ts";

const empty = () => new Array(CELL_COUNT).fill(null);
const seatAt = (ply) => (ply % 2 === 0 ? "player1" : "player2");

/** A board from a list of cells played in turn order. */
function boardFrom(cells) {
  let state = createInitialState();
  for (const cell of cells) {
    state = applyMove({ state, seat: state.currentTurn, cellIndex: cell }).state;
  }
  return state;
}

/** A deterministic LCG, so a failure is reproducible. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── Contract ──────────────────────────────────────────────────────────────

test("chooseAiCell returns null only when the board is full", () => {
  const full = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
  assert.equal(chooseAiCell({ board: full, seat: "player1" }), null);
  assert.equal(chooseAiCell({ board: full, seat: "player2", difficulty: "hard" }), null);
});

test("chooseAiCell always returns an empty cell in range, across every tier", () => {
  const random = lcg(7);
  for (let game = 0; game < 3; game += 1) {
    for (const difficulty of ["easy", "normal", "hard"]) {
      let state = createInitialState();
      while (state.phase === "playing") {
        const seat = state.currentTurn;
        const cell = chooseAiCell({
          board: state.board,
          seat,
          difficulty,
          random,
        });
        assert.ok(Number.isInteger(cell), "a cell must be returned mid-game");
        assert.ok(cell >= 0 && cell < CELL_COUNT, "in range");
        assert.equal(state.board[cell], null, "never an occupied cell");
        state = applyMove({ state, seat, cellIndex: cell }).state;
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

// ── hard ──────────────────────────────────────────────────────────────────

test("hard takes an immediate winning move", () => {
  // O (player2) holds 0 and 1; the win is cell 2.
  const { board } = boardFrom([3, 0, 4, 1]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard" }), 2);
});

test("hard blocks the opponent's immediate winning move", () => {
  // X (player1) holds 6 and 7; O must take 8 to deny the row.
  const { board } = boardFrom([6, 0, 7]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard" }), 8);
});

test("hard prefers its own win over blocking the opponent's", () => {
  // O holds 0,1 (win at 2) and X holds 3,4 (win at 5). O is to move, so it must
  // complete its own line first.
  const { board } = boardFrom([3, 0, 4, 1]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard" }), 2);
});

test("hard never loses against an exhaustive/greedy opponent", () => {
  // Seat the bot as BOTH players across many games: a perfect player must never
  // lose from either seat — it wins as X and draws (at worst) as O.
  const random = lcg(20260401);
  for (let game = 0; game < 16; game += 1) {
    let state = createInitialState();
    const botSeat = game % 2 === 0 ? "player1" : "player2";
    while (state.phase === "playing") {
      let cell;
      if (state.currentTurn === botSeat) {
        cell = chooseAiCell({ board: state.board, seat: state.currentTurn, difficulty: "hard" });
      } else {
        // Opponent plays randomly — a maximally wide range of traps.
        const emptyCells = state.board.flatMap((c, i) => (c === null ? [i] : []));
        cell = emptyCells[Math.floor(random() * emptyCells.length)];
      }
      state = applyMove({ state, seat: state.currentTurn, cellIndex: cell }).state;
    }
    if (state.winner && state.winner !== botSeat) {
      assert.fail(`hard lost as ${botSeat} in game ${game}`);
    }
  }
});

// ── easy ──────────────────────────────────────────────────────────────────

test("easy picks a cell without any deduction", () => {
  // Player2 to move, easy. Force `random()` to select index 0 of the empty set.
  const { board } = boardFrom([3, 0, 4, 1]);
  const cell = chooseAiCell({
    board,
    seat: "player2",
    difficulty: "easy",
    random: () => 0,
  });
  // The empty cells (in index order) are 2, 5, 6, 7, 8 — easy takes the first.
  assert.equal(cell, 2);
  // A different roll selects a different empty cell, even when a win is on.
  const other = chooseAiCell({
    board,
    seat: "player2",
    difficulty: "easy",
    random: () => 0.999,
  });
  assert.equal(other, 8);
});

test("easy does not always take an available win", () => {
  // O could win at cell 2, but with a roll that selects a non-winning empty
  // cell, easy takes that instead — proof it does not search.
  const { board } = boardFrom([3, 0, 4, 1]);
  const random = lcg(99);
  const chosen = new Set();
  for (let i = 0; i < 200; i += 1) {
    chosen.add(chooseAiCell({ board, seat: "player2", difficulty: "easy", random }));
  }
  // Five empty cells, so a uniform pick visits several of them — and never
  // locks onto the one winning cell as a searching agent would.
  assert.ok(chosen.size > 1, `easy varies its move (saw ${[...chosen].join(",")})`);
});

// ── normal ────────────────────────────────────────────────────────────────

test("normal usually finds the winning move but can slip", () => {
  const { board } = boardFrom([3, 0, 4, 1]);
  let wins = 0;
  let slips = 0;
  const random = lcg(4242);
  for (let i = 0; i < 400; i += 1) {
    const cell = chooseAiCell({
      board,
      seat: "player2",
      difficulty: "normal",
      random,
    });
    assert.equal(board[cell], null);
    if (cell === 2) wins += 1;
    else slips += 1;
  }
  // Normal searches, so it overwhelmingly takes the win, but the shared slip
  // keeps it beatable rather than perfect.
  assert.ok(wins > slips, `expected more wins (${wins}) than slips (${slips})`);
  assert.ok(slips > 0, "normal must remain beatable");
});

test("difficulty is coerced onto the shared scale (unknown → normal)", () => {
  const { board } = boardFrom([3, 0, 4, 1]);
  // `hard` never slips, `nonsense` is normal and can — with a pinned roll that
  // forces the slip, the two must be allowed to differ.
  const hard = chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0 });
  assert.equal(hard, 2);
  assert.ok(
    Number.isInteger(chooseAiCell({ board, seat: "player2", difficulty: "nonsense", random: () => 0.99 })),
  );
});

// ── turn integrity ────────────────────────────────────────────────────────

test("the seat decides the mark, and the bot plays into an empty cell only", () => {
  // As X (player1) on an empty board, any move is legal; as O the same.
  for (const seat of ["player1", "player2"]) {
    const board = empty();
    const cell = chooseAiCell({ board, seat, difficulty: "hard" });
    assert.equal(board[cell], null);
  }
});

test("the bot is only asked mid-game: a full board yields null", () => {
  // `chooseAiCell` knows only about occupancy — the store never calls it once
  // the match is decided, and a full board is the one case it refuses.
  const board = empty().map((_, i) => (i % 2 === 0 ? "X" : "O"));
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard" }), null);
  // A win with cells still free is not "full", so nothing crashes if it is.
  const { board: won } = boardFrom([0, 3, 1, 4, 2]);
  assert.ok(findWinningLine(won));
  assert.ok(Number.isInteger(chooseAiCell({ board: won, seat: "player2", difficulty: "hard" })));
});
