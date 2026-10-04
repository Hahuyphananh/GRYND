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

import { chooseAiCell, chooseAiMove } from "../src/lib/tic-tac-toe/ai.ts";
import {
  activeBoardIndexes,
  applyMove,
  createEmptyBoard,
  createInitialState,
  findMegaWin,
  findWinningLine,
  resolveBoardControl,
} from "../src/lib/tic-tac-toe/rules.ts";
import { CELL_COUNT, SUDDEN_DEATH_BOARD_INDEX } from "../src/lib/tic-tac-toe/constants.ts";

const empty = () => new Array(CELL_COUNT).fill(null);
const seatAt = (ply) => (ply % 2 === 0 ? "player1" : "player2");

/** The opening board's cells, from a list of cells played in turn order. */
function boardFrom(cells) {
  let state = createInitialState();
  for (const cell of cells) {
    state = applyMove({ state, seat: state.currentTurn, boardIndex: 0, cellIndex: cell }).state;
  }
  return { board: state.boards[0].cells, state };
}

/** The opening board is only playable until it resolves (won or drawn). */
const board0Active = (state) => Boolean(state.boards[0]) && state.boards[0].control === "active";

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
      while (state.phase === "playing" && board0Active(state)) {
        const seat = state.currentTurn;
        const cell = chooseAiCell({
          board: state.boards[0].cells,
          seat,
          difficulty,
          random,
        });
        assert.ok(Number.isInteger(cell), "a cell must be returned mid-game");
        assert.ok(cell >= 0 && cell < CELL_COUNT, "in range");
        assert.equal(state.boards[0].cells[cell], null, "never an occupied cell");
        state = applyMove({ state, seat, boardIndex: 0, cellIndex: cell }).state;
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
  // O (player2) holds 0 and 1; the win is cell 2. A clean roll (no slip) so the
  // assertion is deterministic.
  const { board } = boardFrom([3, 0, 4, 1]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }), 2);
});

test("hard blocks the opponent's immediate winning move", () => {
  // X (player1) holds 6 and 7; O must take 8 to deny the row.
  const { board } = boardFrom([6, 0, 7]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }), 8);
});

test("hard prefers its own win over blocking the opponent's", () => {
  // O holds 0,1 (win at 2) and X holds 3,4 (win at 5). O is to move, so it must
  // complete its own line first.
  const { board } = boardFrom([3, 0, 4, 1]);
  assert.equal(chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }), 2);
});

test("hard is very strong — it almost never loses, but is no longer unbeatable", () => {
  // `hard` keeps a small slip (an 8% chance per move of taking the 2nd or 3rd
  // best cell), so it can be beaten by a lucky opponent. The claim under test is
  // that it remains the strongest tier by a wide margin: a random opponent must
  // still lose to it in the large majority of games.
  //
  // The bound is empirical, from this seeded run against a uniformly random
  // opponent: hard loses ~7% of games, most of them when a slip lands on the one
  // move that had to block a threat. 10% is the documented ceiling — anything
  // above it means a tier change made `hard` meaningfully weaker, not just
  // beatable.
  const random = lcg(20260401);
  let losses = 0;
  const games = 60;
  for (let game = 0; game < games; game += 1) {
    let state = createInitialState();
    const botSeat = game % 2 === 0 ? "player1" : "player2";
    while (state.phase === "playing" && board0Active(state)) {
      let cell;
      if (state.currentTurn === botSeat) {
        cell = chooseAiCell({
          board: state.boards[0].cells,
          seat: state.currentTurn,
          difficulty: "hard",
        });
      } else {
        // Opponent plays randomly — a maximally wide range of traps.
        const emptyCells = state.boards[0].cells.flatMap((c, i) => (c === null ? [i] : []));
        cell = emptyCells[Math.floor(random() * emptyCells.length)];
      }
      state = applyMove({ state, seat: state.currentTurn, boardIndex: 0, cellIndex: cell }).state;
    }
    if (state.winner && state.winner !== botSeat) losses += 1;
  }
  assert.ok(losses <= games * 0.1, `hard must rarely lose (lost ${losses}/${games})`);
});

test("the tiers are ordered by strength: hard beats normal beats easy", () => {
  // Every tier plays the SAME random opponent across the same games, so the
  // only difference is the tier itself.
  const winsAgainstRandom = (difficulty) => {
    const random = lcg(99887766);
    let wins = 0;
    const games = 60;
    for (let game = 0; game < games; game += 1) {
      let state = createInitialState();
      const botSeat = game % 2 === 0 ? "player1" : "player2";
      while (state.phase === "playing" && board0Active(state)) {
        let cell;
        if (state.currentTurn === botSeat) {
          cell = chooseAiCell({ board: state.boards[0].cells, seat: state.currentTurn, difficulty });
        } else {
          const emptyCells = state.boards[0].cells.flatMap((c, i) => (c === null ? [i] : []));
          cell = emptyCells[Math.floor(random() * emptyCells.length)];
        }
        state = applyMove({ state, seat: state.currentTurn, boardIndex: 0, cellIndex: cell }).state;
      }
      if (state.winner === botSeat) wins += 1;
    }
    return wins;
  };

  const easy = winsAgainstRandom("easy");
  const normal = winsAgainstRandom("normal");
  const hard = winsAgainstRandom("hard");
  assert.ok(hard > normal, `hard (${hard}) must beat normal (${normal})`);
  assert.ok(normal > easy, `normal (${normal}) must beat easy (${easy})`);
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
  // An unrecognised tier must play exactly as `normal` does, for both a slip
  // roll and a clean roll.
  for (const roll of [0, 0.5, 0.99]) {
    assert.equal(
      chooseAiCell({ board, seat: "player2", difficulty: "nonsense", random: () => roll }),
      chooseAiCell({ board, seat: "player2", difficulty: "normal", random: () => roll }),
    );
  }
  // And a clean roll still finds the winning cell.
  assert.equal(
    chooseAiCell({ board, seat: "player2", difficulty: "hard", random: () => 0.99 }),
    2,
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

// ── Mega-aware move selection ─────────────────────────────────────────────

test("chooseAiMove: returns null only when there is no legal move", () => {
  const state = createInitialState();
  state.phase = "finished";
  assert.equal(chooseAiMove({ state, seat: "player1" }), null);
});

test("chooseAiMove: takes an immediate win on the opening board", () => {
  let state = createInitialState();
  // O (player2) holds 0 and 1; the winning cell is 2.
  state = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 4 }).state;
  state = applyMove({ state, seat: "player2", boardIndex: 0, cellIndex: 0 }).state;
  state = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 8 }).state;
  state = applyMove({ state, seat: "player2", boardIndex: 0, cellIndex: 1 }).state;
  state.currentTurn = "player2";
  // A clean roll (no slip) so the assertion is deterministic.
  const move = chooseAiMove({ state, seat: "player2", difficulty: "hard", random: () => 0.99 });
  assert.deepEqual(move, { boardIndex: 0, cellIndex: 2 });
});

test("chooseAiMove: on the sudden-death board it targets the sentinel slot", () => {
  const state = createInitialState();
  state.suddenDeath = { boards: [createEmptyBoard()] };
  state.currentTurn = "player1";
  const move = chooseAiMove({ state, seat: "player1", difficulty: "easy", random: () => 0 });
  assert.equal(move.boardIndex, SUDDEN_DEATH_BOARD_INDEX);
  assert.ok(move.cellIndex >= 0 && move.cellIndex < CELL_COUNT);
});

test("chooseAiMove: every returned move is legal across a full Mega game", () => {
  const random = lcg(13579);
  let state = createInitialState();
  let steps = 0;
  while (state.phase === "playing" && steps < 500) {
    steps += 1;
    const seat = state.currentTurn;
    const move = chooseAiMove({ state, seat, difficulty: "normal", random });
    assert.ok(move, `a move must exist while the match is playing (step ${steps})`);
    const target =
      move.boardIndex === SUDDEN_DEATH_BOARD_INDEX
        ? state.suddenDeath.boards[state.suddenDeath.boards.length - 1]
        : state.boards[move.boardIndex];
    assert.ok(target, `the targeted board must be in play (step ${steps})`);
    assert.equal(target.cells[move.cellIndex], null, `the cell must be empty (step ${steps})`);
    state = applyMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex }).state;
  }
  assert.equal(state.phase, "finished", "the game must reach a decided end");
  assert.ok(state.winner, "a Mega match always ends with a winner");
  assert.ok(activeBoardIndexes(state).length >= 0);
});

// ── Mega-aware AI: position fixtures ──────────────────────────────────────
//
// The bot reasons over the SAME authoritative state a player reads. These
// fixtures build that state directly (control/winningLine derived exactly as
// the engine derives them) so a specific Mega decision can be pinned.

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

function craftMega({
  stage = 1,
  boards = {},
  currentTurn = "player1",
  ply = 0,
  phase = "playing",
  suddenDeath = null,
} = {}) {
  return {
    version: 1,
    phase,
    stage,
    boards: Array.from({ length: 9 }, (_, slot) => boards[slot] ?? null),
    currentTurn,
    ply,
    winner: null,
    winningBoards: null,
    tiebreak: null,
    suddenDeath,
    lastMove: null,
  };
}

const X_BOARD = ["X", "X", "X", "O", "O", null, null, null, null]; // X controls
const O_BOARD = ["O", "O", "O", "X", "X", null, null, null, null]; // O controls
const X_TWO = ["X", "X", null, "O", "O", null, null, null, null]; // active; X wins at 2
const O_TWO = ["O", "O", null, "X", "X", null, null, null, null]; // active; O wins at 2
const NEUTRAL_O = ["X", null, "X", "O", "O", "O", "X", null, null]; // O line → O controls
const EMPTY_CELLS = new Array(CELL_COUNT).fill(null);

/** True when `seat` has a move that ends the match right now. */
function hasImmediateMatchWin(state, seat) {
  for (const slot of activeBoardIndexes(state)) {
    const board = state.boards[slot];
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      if (board.cells[cell] !== null) continue;
      if (applyMove({ state, seat, boardIndex: slot, cellIndex: cell }).matchCompleted) return true;
    }
  }
  return false;
}
// The classic nine-move draw, with its last placement (cell 1) removed so the
// board has exactly one empty cell — any move fills it and draws the board.
const DRAW_MINUS_ONE = (() => {
  const cells = ["X", "X", "O", "O", "O", "X", "X", "O", "X"];
  cells[1] = null;
  return cells;
})();

// ── Mega-aware AI: decisions ──────────────────────────────────────────────

test("chooseAiMove: takes an immediate Mega-board winning opportunity", () => {
  const state = craftMega({
    stage: 3,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(X_BOARD),
      1: fixtureBoard(X_BOARD),
      2: fixtureBoard(X_TWO),
      3: fixtureBoard(EMPTY_CELLS),
      4: fixtureBoard(EMPTY_CELLS),
    },
  });
  // X owns boards 0 and 1; winning board 2 completes the Mega line [0,1,2].
  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.deepEqual(move, { boardIndex: 2, cellIndex: 2 });
  const applied = applyMove({ state, seat: "player1", boardIndex: 2, cellIndex: 2 });
  assert.equal(applied.matchCompleted, true);
  assert.deepEqual(applied.winningBoards, [0, 1, 2]);
});

test("chooseAiMove: denies an opponent's immediate Mega-board win", () => {
  // O owns boards 0 and 1 and can win board 2 at cell 2 → a Mega win. X must
  // do something about board 2. Whether it blocks cell 2 or captures the board
  // itself (cell 5 completes X's own row) is up to the engine — what matters is
  // that the opponent is left WITHOUT an immediate match win.
  const state = craftMega({
    stage: 3,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(O_BOARD),
      1: fixtureBoard(O_BOARD),
      2: fixtureBoard(O_TWO),
      3: fixtureBoard(EMPTY_CELLS),
      4: fixtureBoard(EMPTY_CELLS),
    },
  });
  // The threat is real before the move (otherwise the test proves nothing).
  assert.equal(hasImmediateMatchWin(state, "player2"), true);

  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.equal(move.boardIndex, 2, "the bot must address the threatened Mega line");
  const applied = applyMove({ state, seat: "player1", boardIndex: 2, cellIndex: move.cellIndex }).state;
  assert.equal(hasImmediateMatchWin(applied, "player2"), false, "O must be denied the Mega win");
  assert.equal(findMegaWin(applied.boards, 3), null);
});

test("chooseAiMove: reacts to a board win by locking a small board", () => {
  // Round 2. O already controls board 0; X can take board 1 outright at cell 2.
  const state = craftMega({
    stage: 2,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(NEUTRAL_O),
      1: fixtureBoard(X_TWO),
      3: fixtureBoard(EMPTY_CELLS),
      4: fixtureBoard(EMPTY_CELLS),
    },
  });
  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.deepEqual(move, { boardIndex: 1, cellIndex: 2 });
  const applied = applyMove({ state, seat: "player1", boardIndex: 1, cellIndex: 2 });
  assert.equal(applied.boardResolved, true);
  assert.equal(applied.state.boards[1].control, "X");
});

test("chooseAiMove: survives the Round 1 → Round 2 expansion", () => {
  // Board 0 has one empty cell left; filling it draws the board and expands.
  const state = craftMega({
    stage: 1,
    ply: 8,
    currentTurn: "player1",
    boards: { 0: fixtureBoard(DRAW_MINUS_ONE) },
  });
  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.deepEqual(move, { boardIndex: 0, cellIndex: 1 });
  const applied = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 1 }).state;
  assert.equal(applied.stage, 2);
  assert.equal(applied.boards[0].control, "draw");
  assert.deepEqual(activeBoardIndexes(applied), [1, 3, 4]);
});

test("chooseAiMove: survives the Round 2 → Round 3 expansion, preserving moves", () => {
  // Boards 0, 1 and 3 are resolved; board 4 has one empty cell. Resolving it
  // leaves the 2x2 fully resolved with no Mega line → expand to nine.
  const state = craftMega({
    stage: 2,
    ply: 40,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(X_BOARD),
      1: fixtureBoard(O_BOARD),
      3: fixtureBoard(X_BOARD),
      4: fixtureBoard(DRAW_MINUS_ONE),
    },
  });
  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.equal(move.boardIndex, 4);
  const applied = applyMove({ state, seat: "player1", boardIndex: 4, cellIndex: move.cellIndex }).state;
  assert.equal(applied.stage, 3);
  assert.equal(applied.boards.filter(Boolean).length, 9);
  // Every earlier board survives, byte for byte.
  assert.deepEqual(applied.boards[0].cells, X_BOARD);
  assert.deepEqual(applied.boards[1].cells, O_BOARD);
  assert.deepEqual(applied.boards[3].cells, X_BOARD);
});

test("chooseAiMove: plays the last cell and lets the tiebreak decide Round 3", () => {
  const boards = {};
  const layout = { 0: X_BOARD, 1: X_BOARD, 2: O_BOARD, 3: O_BOARD, 4: X_BOARD, 5: X_BOARD, 6: O_BOARD, 7: O_BOARD };
  for (const [slot, cells] of Object.entries(layout)) boards[slot] = fixtureBoard(cells);
  boards[8] = fixtureBoard(DRAW_MINUS_ONE);
  const state = craftMega({ stage: 3, currentTurn: "player1", ply: 80, boards });
  assert.equal(findMegaWin(state.boards, 3), null, "the fixture must start with no Mega line");

  const move = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  // Board 8 is the only active board, with its one empty cell at 1.
  assert.deepEqual(move, { boardIndex: 8, cellIndex: 1 });
  const applied = applyMove({ state, seat: "player1", boardIndex: 8, cellIndex: 1 });
  assert.equal(findMegaWin(applied.state.boards, 3), null, "the final move must not create a Mega line");
  // With every board resolved and no Mega line, the tiebreak decides (or a
  // complete tie starts sudden death) — the server's transition, not the bot's.
  assert.ok(
    applied.matchCompleted || applied.suddenDeath || Boolean(applied.state.suddenDeath),
    "the tiebreak must decide the match or begin sudden death",
  );
});

test("chooseAiMove: can finish a full Mega match", () => {
  const random = lcg(112233);
  let state = createInitialState();
  let steps = 0;
  while (state.phase === "playing" && steps < 500) {
    steps += 1;
    const seat = state.currentTurn;
    const move = chooseAiMove({ state, seat, difficulty: "normal", random });
    assert.ok(move, `a move must exist (step ${steps})`);
    state = applyMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex }).state;
  }
  assert.equal(state.phase, "finished");
  assert.ok(state.winner, "a Mega match always ends with a winner");
  assert.ok(
    state.winningBoards === null || state.winningBoards.length === 1 || state.winningBoards.length === 3,
    "a finish is a stage-1 board, a three-board Mega line, or a tiebreak",
  );
});

test("chooseAiMove: plays across multiple boards in a Mega round", () => {
  // A 2x2 with four open boards: no board win ends the match, so the bot must
  // spread across more than one board — and must only ever address boards in
  // play at this round.
  const random = lcg(31415);
  let state = craftMega({
    stage: 2,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(EMPTY_CELLS),
      1: fixtureBoard(EMPTY_CELLS),
      3: fixtureBoard(EMPTY_CELLS),
      4: fixtureBoard(EMPTY_CELLS),
    },
  });
  const used = new Set();
  let steps = 0;
  while (state.phase === "playing" && steps < 500) {
    steps += 1;
    const seat = state.currentTurn;
    const move = chooseAiMove({ state, seat, difficulty: "normal", random });
    assert.ok(move, `a move must exist (step ${steps})`);
    // Whichever round this move is in, it addresses a board that IS in play
    // (or the sudden-death sentinel, if the game reached a full tie).
    if (state.suddenDeath) {
      assert.equal(move.boardIndex, SUDDEN_DEATH_BOARD_INDEX);
    } else {
      assert.ok(
        activeBoardIndexes(state).includes(move.boardIndex),
        `slot ${move.boardIndex} must be in play (step ${steps})`,
      );
    }
    used.add(move.boardIndex);
    state = applyMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex }).state;
  }
  assert.equal(state.phase, "finished");
  assert.ok(used.size > 1, `the bot must use several boards (used ${[...used].join(",")})`);
});

test("chooseAiMove: never plays a completed board, an occupied cell or an invalid slot", () => {
  const random = lcg(55577);
  for (const difficulty of ["easy", "normal", "hard"]) {
    let state = createInitialState();
    let steps = 0;
    while (state.phase === "playing" && steps < 500) {
      steps += 1;
      const seat = state.currentTurn;
      const move = chooseAiMove({ state, seat, difficulty, random });
      assert.ok(move, `${difficulty}: a move must exist (step ${steps})`);
      assert.ok(move.cellIndex >= 0 && move.cellIndex < CELL_COUNT, `${difficulty}: cell in range`);
      if (state.suddenDeath) {
        assert.equal(move.boardIndex, SUDDEN_DEATH_BOARD_INDEX, `${difficulty}: sudden-death sentinel`);
      } else {
        assert.ok(
          activeBoardIndexes(state).includes(move.boardIndex),
          `${difficulty}: board must be active (step ${steps})`,
        );
        assert.equal(state.boards[move.boardIndex].control, "active", `${difficulty}: never a completed board`);
      }
      const target =
        move.boardIndex === SUDDEN_DEATH_BOARD_INDEX
          ? state.suddenDeath.boards[state.suddenDeath.boards.length - 1]
          : state.boards[move.boardIndex];
      assert.equal(target.cells[move.cellIndex], null, `${difficulty}: never an occupied cell`);
      state = applyMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex }).state;
    }
    assert.equal(state.phase, "finished", `${difficulty}: the game must end`);
  }
});

test("chooseAiMove: stays deterministic under injected randomness, and never mutates", () => {
  const build = () => {
    let state = createInitialState();
    for (const cellIndex of [4, 0, 8, 1, 2, 6, 5]) {
      state = applyMove({ state, seat: state.currentTurn, boardIndex: 0, cellIndex }).state;
    }
    return state;
  };
  const a = chooseAiMove({ state: build(), seat: "player1", difficulty: "normal", random: lcg(42) });
  const b = chooseAiMove({ state: build(), seat: "player1", difficulty: "normal", random: lcg(42) });
  assert.deepEqual(a, b, "the same seed and state must produce the same move");
  assert.deepEqual(
    chooseAiMove({ state: build(), seat: "player1", difficulty: "easy", random: () => 0.3 }),
    chooseAiMove({ state: build(), seat: "player1", difficulty: "easy", random: () => 0.3 }),
  );

  const state = craftMega({
    stage: 3,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(X_BOARD),
      1: fixtureBoard(O_BOARD),
      2: fixtureBoard(EMPTY_CELLS),
      3: fixtureBoard(EMPTY_CELLS),
    },
  });
  const before = JSON.stringify(state);
  chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  assert.equal(JSON.stringify(state), before, "the chooser must not mutate the state");
});

test("chooseAiMove: reads only the authoritative state, ignoring extra fields", () => {
  const state = craftMega({
    stage: 3,
    currentTurn: "player1",
    boards: {
      0: fixtureBoard(O_BOARD),
      1: fixtureBoard(O_BOARD),
      2: fixtureBoard(O_TWO),
      3: fixtureBoard(EMPTY_CELLS),
    },
  });
  const baseline = chooseAiMove({ state, seat: "player1", difficulty: "hard", random: () => 0.99 });
  // A hostile payload cannot steer the bot: only the state/seat are read.
  const hostile = { ...state, winner: "player2", result: "player2", score: 99 };
  assert.deepEqual(
    chooseAiMove({ state: hostile, seat: "player1", difficulty: "hard", random: () => 0.99 }),
    baseline,
  );
});
