/**
 * tic-tac-toe-rules.test.mjs
 *
 * The PURE Ultimate Tic-Tac-Toe rules engine, pinned exhaustively.
 *
 * The engine is the authoritative game logic: it decides which mini-board a move
 * may address, whose mark lands there, when a mini-board is claimed (three in a
 * line) or drawn (full, no line), which mini-board the opponent must play next,
 * when three collinear mini-boards win the match, and when the whole lattice
 * resolving with no line is a draw. It is pure — no DB, no I/O, no randomness —
 * so every branch can be pinned here.
 *
 * Everything is driven through the PUBLIC interface the server uses:
 * `validateMove` → `applyMove`, plus `replayMoves` for the move log. The
 * fixtures that start mid-game are hand-built POSITIONS (an authoritative state
 * shape), and the deciding move still goes through those same two functions, so
 * no assertion depends on a private helper.
 *
 * It also asserts the anti-cheat property directly: the mark is derived from the
 * acting SEAT, the required destination is derived from the previous move's cell
 * index, the board owners, lattice line, winner and draw are all derived from
 * the cells — and a tampered `control` field in the stored state is IGNORED.
 * Nothing here reads a client-supplied winner, board owner or result, because no
 * such value is ever passed in.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  activeBoardIndexes,
  allBoardsResolved,
  applyMove,
  boardControlAt,
  completedBoardIndexes,
  computeMatchResult,
  countCells,
  createEmptyBoard,
  createInitialState,
  findLatticeWin,
  findWinningLine,
  hasBothSeats,
  isBoardFull,
  isBoardResolved,
  isPlayableBoard,
  isValidBoardIndex,
  isValidCellIndex,
  isWellFormedBoard,
  isWellFormedState,
  latticeOf,
  markForSeat,
  nextBoardForCell,
  normalizeForViewer,
  otherSeat,
  playableBoardIndexes,
  replayMoves,
  requiredBoardIndex,
  resolveBoardControl,
  seatForMark,
  seatForPly,
  seatForUser,
  seatsFromMatch,
  statusForState,
  userIdForSeat,
  validateMove,
} from "../src/lib/tic-tac-toe/rules.ts";
import {
  BOARD_SIZE,
  CELL_COUNT,
  FIRST_SEAT,
  LATTICE_LINES,
  LATTICE_SIZE,
  LATTICE_SLOTS,
  MARKS,
  MATCH_STATUS,
  MAX_BOARDS,
  RESULT,
  WINNING_LINES,
} from "../src/lib/tic-tac-toe/constants.ts";

const SEATS = { player1Id: "user_alice", player2Id: "user_bob" };
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";

const SEAT_FOR_MARK = { X: "player1", O: "player2" };
const MARK_FOR_SEAT = { player1: "X", player2: "O" };

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * A hand-built mid-game POSITION.
 *
 * `boards` is keyed by lattice slot (0..8). Slots left out are `null`, which the
 * engine reads as an empty, active mini-board (that is also how a legacy
 * expansion-era row is tolerated). `nextBoard` is the forced destination, and
 * the ply is kept consistent with the seat to move: an even ply is always X's.
 */
function craft({
  boards = {},
  currentTurn = FIRST_SEAT,
  ply = 0,
  nextBoard = null,
  phase = "playing",
  version = 1,
  winner = null,
  winningBoards = null,
} = {}) {
  return {
    version,
    phase,
    boards: Array.from({ length: MAX_BOARDS }, (_, slot) =>
      Object.prototype.hasOwnProperty.call(boards, slot) ? boards[slot] : null,
    ),
    currentTurn,
    ply,
    winner,
    winningBoards,
    nextBoard,
    lastMove: null,
  };
}

/** A mini-board whose control/winningLine are derived exactly as the engine derives them. */
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

const emptyBoardCells = () => new Array(CELL_COUNT).fill(null);

/** A board CLAIMED by `mark` (top row) — the unit a lattice line is made of. */
function claimedBoard(mark) {
  const cells = emptyBoardCells();
  cells[0] = mark;
  cells[1] = mark;
  cells[2] = mark;
  return board(cells);
}

/** The classic nine-move draw on ONE mini-board. */
const DRAW_CELL_ORDER = [0, 4, 8, 2, 6, 3, 5, 7, 1];
const DRAW_CELLS = (() => {
  const cells = emptyBoardCells();
  DRAW_CELL_ORDER.forEach((cell, ply) => {
    cells[cell] = ply % 2 === 0 ? "X" : "O";
  });
  return cells;
})();

/**
 * A mini-board one move away from being CLAIMED by `mark` on `line`: two marks
 * already on the line, the third cell empty, and two opponent marks on cells
 * that cannot form a line. Returns the cells and the deciding cell index.
 */
function pendingBoard(mark, line) {
  const other = mark === "X" ? "O" : "X";
  const cells = emptyBoardCells();
  cells[line[0]] = mark;
  cells[line[1]] = mark;
  const spare = LATTICE_SLOTS.filter((cell) => !line.includes(cell) && cell !== line[2]);
  cells[spare[0]] = other;
  cells[spare[1]] = other;
  return { cells, finalCell: line[2] };
}

/** Drive ONE move through the public interface, asserting it is accepted. */
function play(state, { seat = state.currentTurn, boardIndex, cellIndex, expectedVersion } = {}) {
  const check = validateMove({ state, seat, boardIndex, cellIndex, expectedVersion });
  assert.equal(
    check.ok,
    true,
    `expected (${boardIndex},${cellIndex}) by ${seat} to be accepted, got: ${check.error}`,
  );
  return applyMove({ state, seat, boardIndex, cellIndex });
}

/** Validate a move and assert it is REFUSED with `status`. */
function refuse(state, { seat = state.currentTurn, boardIndex, cellIndex, expectedVersion, status } = {}) {
  const check = validateMove({ state, seat, boardIndex, cellIndex, expectedVersion });
  assert.equal(
    check.ok,
    false,
    `expected (${boardIndex},${cellIndex}) by ${seat} to be refused`,
  );
  if (status !== undefined) {
    assert.equal(check.status, status, `expected status ${status}, got ${check.status}: ${check.error}`);
  }
  return check;
}

/** Play a whole sequence of { seat, boardIndex, cellIndex }, asserting each one. */
function playSequence(state, moves) {
  let current = state;
  for (const move of moves) {
    current = play(current, move).state;
  }
  return current;
}

/** Deterministic PRNG, so the fuzz case is reproducible. */
function lcg(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/** Deep snapshot via JSON (states are plain data), for mutation checks. */
const snapshot = (state) => JSON.parse(JSON.stringify(state));

/**
 * A REAL 21-ply match played from the opening position, ending in X's left
 * column (boards 0, 3, 6). Every move below was accepted by the engine exactly
 * as written — including every forced destination, which is why no move names a
 * board the rules did not require.
 */
const X_WINS_SEQUENCE = [
  { seat: "player1", boardIndex: 0, cellIndex: 8 },
  { seat: "player2", boardIndex: 8, cellIndex: 5 },
  { seat: "player1", boardIndex: 5, cellIndex: 2 },
  { seat: "player2", boardIndex: 2, cellIndex: 6 },
  { seat: "player1", boardIndex: 6, cellIndex: 0 },
  { seat: "player2", boardIndex: 0, cellIndex: 0 },
  { seat: "player1", boardIndex: 0, cellIndex: 5 },
  { seat: "player2", boardIndex: 5, cellIndex: 3 },
  { seat: "player1", boardIndex: 3, cellIndex: 3 },
  { seat: "player2", boardIndex: 3, cellIndex: 8 },
  { seat: "player1", boardIndex: 8, cellIndex: 1 },
  { seat: "player2", boardIndex: 1, cellIndex: 6 },
  { seat: "player1", boardIndex: 6, cellIndex: 3 },
  { seat: "player2", boardIndex: 3, cellIndex: 0 },
  { seat: "player1", boardIndex: 0, cellIndex: 2 },
  { seat: "player2", boardIndex: 2, cellIndex: 3 },
  { seat: "player1", boardIndex: 3, cellIndex: 4 },
  { seat: "player2", boardIndex: 4, cellIndex: 3 },
  { seat: "player1", boardIndex: 3, cellIndex: 5 },
  { seat: "player2", boardIndex: 5, cellIndex: 0 },
  { seat: "player1", boardIndex: 6, cellIndex: 6 },
];

// ── Vocabulary, geometry and seats ────────────────────────────────────────

test("vocabulary: nine mini-boards in a fixed 3x3 lattice, eight lines in each space", () => {
  assert.equal(BOARD_SIZE, 3);
  assert.equal(CELL_COUNT, 9);
  assert.equal(LATTICE_SIZE, 3);
  assert.equal(MAX_BOARDS, 9);
  assert.deepEqual([...LATTICE_SLOTS], [0, 1, 2, 3, 4, 5, 6, 7, 8]);

  assert.equal(WINNING_LINES.length, 8);
  assert.equal(LATTICE_LINES.length, 8);
  // The two spaces share one geometry: rows, columns, then both diagonals.
  assert.deepEqual(
    LATTICE_LINES.map((line) => [...line]),
    WINNING_LINES.map((line) => [...line]),
  );
  assert.deepEqual(
    WINNING_LINES.map((line) => [...line]),
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ],
  );
});

test("seats: X is player1, O is player2, and the mapping round-trips", () => {
  assert.equal(MARKS.player1, "X");
  assert.equal(MARKS.player2, "O");
  assert.equal(FIRST_SEAT, "player1");
  assert.equal(markForSeat("player1"), "X");
  assert.equal(markForSeat("player2"), "O");
  assert.equal(seatForMark("X"), "player1");
  assert.equal(seatForMark("O"), "player2");
  assert.equal(otherSeat("player1"), "player2");
  assert.equal(otherSeat("player2"), "player1");
});

test("seats: a row maps to seats, and a stranger holds none", () => {
  assert.deepEqual(seatsFromMatch({ player1Id: ALICE, player2Id: BOB }), SEATS);
  assert.deepEqual(seatsFromMatch({ player1Id: ALICE }), {
    player1Id: ALICE,
    player2Id: null,
  });
  assert.equal(seatForUser(SEATS, ALICE), "player1");
  assert.equal(seatForUser(SEATS, BOB), "player2");
  assert.equal(seatForUser(SEATS, MALLORY), null);
  assert.equal(seatForUser(SEATS, null), null);
  assert.equal(seatForUser({ player1Id: ALICE, player2Id: null }, BOB), null);
  assert.equal(userIdForSeat(SEATS, "player1"), ALICE);
  assert.equal(userIdForSeat(SEATS, "player2"), BOB);
  assert.equal(hasBothSeats(SEATS), true);
  assert.equal(hasBothSeats({ player1Id: ALICE, player2Id: null }), false);
});

// ── 1. The opening position ───────────────────────────────────────────────

test("1. the opening position is NINE active, empty mini-boards", () => {
  const state = createInitialState();

  assert.equal(state.boards.length, MAX_BOARDS);
  assert.equal(state.ply, 0);
  assert.equal(state.version, 1);
  assert.equal(state.phase, "playing");
  assert.equal(state.winner, null);
  assert.equal(state.winningBoards, null);
  assert.equal(state.nextBoard, null, "the opening move may be played anywhere");
  assert.equal(state.lastMove, null);

  state.boards.forEach((mini, slot) => {
    assert.equal(mini.control, "active", `board ${slot} must be active`);
    assert.equal(mini.plies, 0, `board ${slot} must be empty`);
    assert.equal(mini.winningLine, null);
    assert.deepEqual(mini.cells, emptyBoardCells());
  });

  assert.deepEqual(activeBoardIndexes(state), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(completedBoardIndexes(state), []);
  assert.deepEqual(playableBoardIndexes(state), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(requiredBoardIndex(state), null);
  assert.equal(allBoardsResolved(state.boards), false);
  assert.equal(findLatticeWin(state.boards), null);
  assert.equal(statusForState(state), MATCH_STATUS.PLAYING);

  // Every state is independent: a second call cannot share boards with the first.
  assert.notEqual(state.boards[0], createInitialState().boards[0]);
});

// ── 2. X moves first ──────────────────────────────────────────────────────

test("2. X (player1) moves first — and O cannot open", () => {
  const state = createInitialState();
  assert.equal(state.currentTurn, "player1");
  assert.equal(markForSeat(FIRST_SEAT), "X");

  refuse(state, { seat: "player2", boardIndex: 0, cellIndex: 0, status: 409 });

  const applied = play(state, { boardIndex: 0, cellIndex: 4 });
  assert.equal(applied.state.lastMove.seat, "player1");
  assert.equal(applied.state.lastMove.mark, "X");
  assert.equal(applied.state.boards[0].cells[4], "X");
  assert.equal(applied.state.currentTurn, "player2");
});

// ── 3-4. Free choice, and the forced destination ──────────────────────────

test("3. with free choice, a valid move is accepted on ANY unfinished mini-board", () => {
  for (const slot of LATTICE_SLOTS) {
    const state = createInitialState();
    assert.deepEqual(playableBoardIndexes(state).includes(slot), true);

    const applied = play(state, { boardIndex: slot, cellIndex: 0 });
    assert.equal(applied.state.boards[slot].cells[0], "X", `slot ${slot} accepts the opening move`);
    assert.equal(applied.state.boards[slot].plies, 1);
    assert.equal(applied.state.ply, 1);
    // The other eight boards are untouched.
    for (const other of LATTICE_SLOTS) {
      if (other === slot) continue;
      assert.deepEqual(applied.state.boards[other].cells, emptyBoardCells());
    }
  }
});

test("4. a move sets the opponent's required destination to the SAME cell index", () => {
  const state = createInitialState();
  const applied = play(state, { boardIndex: 4, cellIndex: 6 });

  assert.equal(applied.state.nextBoard, 6);
  assert.equal(requiredBoardIndex(applied.state), 6);
  assert.deepEqual(playableBoardIndexes(applied.state), [6]);
  assert.deepEqual(activeBoardIndexes(applied.state), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(isPlayableBoard(applied.state, 6), true);
  assert.equal(isPlayableBoard(applied.state, 5), false);

  // ...and the chain continues: O must play board 6, and its cell decides X's.
  const reply = play(applied.state, { seat: "player2", boardIndex: 6, cellIndex: 2 });
  assert.equal(reply.state.nextBoard, 2);
  assert.deepEqual(playableBoardIndexes(reply.state), [2]);
  assert.equal(reply.state.currentTurn, "player1");
});

test("4b. cell 0, cell 4 and cell 8 send the opponent to board 1, board 5 and board 9", () => {
  // The three corners and the centre of the CELL grid map one-to-one onto the
  // same slots of the BOARD grid. Driven end to end — a real move, then the
  // opponent's forced move — so it pins the whole chain, not just the helper.
  for (const cell of [0, 4, 8]) {
    const opening = play(createInitialState(), { boardIndex: cell, cellIndex: cell });
    const moved = opening.state;

    assert.equal(moved.nextBoard, cell, `cell ${cell} requires board ${cell}`);
    assert.equal(requiredBoardIndex(moved), cell);
    assert.deepEqual(playableBoardIndexes(moved), [cell]);
    assert.equal(moved.currentTurn, "player2");

    // Every other board is refused while the destination is active...
    for (const slot of LATTICE_SLOTS) {
      if (slot === cell) continue;
      refuse(moved, { seat: "player2", boardIndex: slot, cellIndex: 0, status: 409 });
    }

    // ...and the opponent's reply inside it moves the chain on again. (Cell 4
    // of board 5 is already taken by the opening move, so the centre case uses
    // a different cell — the assertion is about the mapping, not the cell.)
    const replyCell = cell === 4 ? 2 : 4;
    const reply = play(moved, { seat: "player2", boardIndex: cell, cellIndex: replyCell });
    assert.equal(
      reply.state.nextBoard,
      replyCell,
      "the reply's cell names the next destination",
    );
    assert.deepEqual(playableBoardIndexes(reply.state), [replyCell]);
  }
});

test("6. a move outside the required destination is rejected while it is active", () => {
  const state = play(createInitialState(), { boardIndex: 0, cellIndex: 4 }).state;
  assert.equal(requiredBoardIndex(state), 4);

  const refusal = refuse(state, { seat: "player2", boardIndex: 5, cellIndex: 0, status: 409 });
  assert.match(refusal.error, /board 4/);

  refuse(state, { seat: "player2", boardIndex: 8, cellIndex: 0, status: 409 });
  // The right board is still accepted.
  play(state, { seat: "player2", boardIndex: 4, cellIndex: 0 });
});

test("7. a RESOLVED destination leaves the opponent free to choose any unfinished board", () => {
  // Board 5 is already claimed (by X) long before this turn; after X plays cell
  // 5 the destination would be board 5, which is resolved — so O may go
  // anywhere unfinished.
  const state = craft({
    boards: {
      0: board(["X", "O", null, null, null, null, null, null, null]),
      5: claimedBoard("X"),
    },
    currentTurn: "player1",
    ply: 4,
    nextBoard: 0,
  });
  assert.deepEqual(playableBoardIndexes(state), [0]);

  const applied = play(state, { boardIndex: 0, cellIndex: 5 });
  assert.equal(applied.state.nextBoard, null, "a resolved destination means free choice");
  assert.equal(requiredBoardIndex(applied.state), null);
  // Every board except the claimed one is on offer — board 0 included, since it
  // is still unfinished.
  assert.deepEqual(playableBoardIndexes(applied.state), [0, 1, 2, 3, 4, 6, 7, 8]);
  assert.equal(isPlayableBoard(applied.state, 5), false, "the claimed board is not offered");
  assert.equal(isPlayableBoard(applied.state, 3), true);

  // O really can pick any of them...
  const free = play(applied.state, { seat: "player2", boardIndex: 3, cellIndex: 0 });
  assert.equal(free.state.boards[3].cells[0], "O");

  // ...but a resolved board is still refused.
  refuse(applied.state, { seat: "player2", boardIndex: 5, cellIndex: 0, status: 409 });
});

test("the destination is derived from the cell, and normalises when the target is resolved", () => {
  const open = craft({});
  assert.equal(nextBoardForCell(open.boards, 0), 0);
  assert.equal(nextBoardForCell(open.boards, 8), 8);

  const withClaimed = craft({ boards: { 7: claimedBoard("O") } });
  assert.equal(nextBoardForCell(withClaimed.boards, 7), null);
  assert.equal(nextBoardForCell(withClaimed.boards, 6), 6);
  assert.equal(nextBoardForCell(withClaimed.boards, 99), null);
});

test("a stored destination that has since resolved is normalised to a free choice", () => {
  const state = craft({
    boards: { 2: claimedBoard("X") },
    currentTurn: "player2",
    ply: 3,
    nextBoard: 2,
  });
  assert.equal(requiredBoardIndex(state), null);
  assert.deepEqual(playableBoardIndexes(state).sort(), [0, 1, 3, 4, 5, 6, 7, 8]);
});

// ── 5, 8, 9. Mini-board resolution ────────────────────────────────────────

test("5. a move on an already resolved mini-board is rejected", () => {
  const state = craft({
    boards: { 3: claimedBoard("X"), 6: board(DRAW_CELLS) },
    currentTurn: "player1",
    ply: 6,
  });
  assert.deepEqual(completedBoardIndexes(state), [3, 6]);
  assert.deepEqual(activeBoardIndexes(state), [0, 1, 2, 4, 5, 7, 8]);

  refuse(state, { boardIndex: 3, cellIndex: 0, status: 409 });
  refuse(state, { boardIndex: 6, cellIndex: 0, status: 409 });
  // The same board is refused for the other seat too.
  refuse(craft({ boards: { 3: claimedBoard("X") }, currentTurn: "player2", ply: 3 }), {
    seat: "player2",
    boardIndex: 3,
    cellIndex: 4,
    status: 409,
  });
});

test("8. each of the EIGHT mini-board winning patterns claims the board", () => {
  for (const line of WINNING_LINES) {
    const cellsAndCell = pendingBoard("X", [...line]);

    // X claims it...
    const xState = craft({
      boards: { 4: board(cellsAndCell.cells) },
      currentTurn: "player1",
      ply: 4,
      nextBoard: 4,
    });
    const xApplied = play(xState, { boardIndex: 4, cellIndex: cellsAndCell.finalCell });
    assert.equal(xApplied.boardResolved, true, `line ${line} must resolve board 4`);
    assert.equal(xApplied.boardClaimed, "X");
    assert.equal(xApplied.state.boards[4].control, "X");
    assert.deepEqual(xApplied.state.boards[4].winningLine, [...line]);
    assert.equal(xApplied.state.boards[4].plies, 5);
    assert.equal(xApplied.matchCompleted, false);
    assert.equal(boardControlAt(xApplied.state, 4), "X");

    // ...and O claims the mirrored position.
    const oCells = pendingBoard("O", [...line]);
    const oState = craft({
      boards: { 4: board(oCells.cells) },
      currentTurn: "player2",
      ply: 5,
      nextBoard: 4,
    });
    const oApplied = play(oState, { seat: "player2", boardIndex: 4, cellIndex: oCells.finalCell });
    assert.equal(oApplied.boardClaimed, "O");
    assert.equal(oApplied.state.boards[4].control, "O");
    assert.deepEqual(oApplied.state.boards[4].winningLine, [...line]);
    assert.equal(oApplied.winnerSeat, null, "one board is not the match");
    assert.equal(findLatticeWin(oApplied.state.boards), null);
  }
});

test("8b. the same eight patterns are recognised on a raw cell array", () => {
  for (const line of WINNING_LINES) {
    const cells = emptyBoardCells();
    for (const cell of line) cells[cell] = "O";
    assert.deepEqual(findWinningLine(cells), { mark: "O", line: [...line] });
    assert.deepEqual(resolveBoardControl(cells), { control: "O", winningLine: [...line] });
    assert.equal(isBoardFull(cells), false);
    assert.equal(countCells(cells, "O"), 3);
  }
});

test("9. a mini-board filled with no winner becomes a DRAW and stays locked", () => {
  // The classic nine-move draw, with the last (winning-by-nothing) cell empty.
  const cells = [...DRAW_CELLS];
  cells[1] = null;
  assert.equal(resolveBoardControl(cells).control, "active");

  const state = craft({
    boards: { 7: board(cells) },
    currentTurn: "player1",
    ply: 8,
    nextBoard: 7,
  });
  const applied = play(state, { boardIndex: 7, cellIndex: 1 });

  assert.equal(applied.boardResolved, true);
  assert.equal(applied.boardClaimed, null, "a draw claims the board for nobody");
  assert.equal(applied.state.boards[7].control, "draw");
  assert.equal(applied.state.boards[7].winningLine, null);
  assert.equal(isBoardResolved(applied.state.boards[7]), true);
  assert.equal(findLatticeWin(applied.state.boards), null);
  assert.equal(applied.matchCompleted, false, "one drawn board does not end the match");
  // It is locked from here on.
  refuse(applied.state, { seat: "player2", boardIndex: 7, cellIndex: 0, status: 409 });
});

// ── 10-13. The lattice ────────────────────────────────────────────────────

test("10. each of the EIGHT lattice patterns ends the match immediately", () => {
  for (const line of LATTICE_LINES) {
    for (const mark of ["X", "O"]) {
      const seat = SEAT_FOR_MARK[mark];
      const [a, b, c] = line;
      const pending = pendingBoard(mark, [0, 1, 2]);

      const state = craft({
        boards: {
          [a]: claimedBoard(mark),
          [b]: claimedBoard(mark),
          [c]: board(pending.cells),
        },
        currentTurn: seat,
        ply: mark === "X" ? 12 : 13,
        nextBoard: c,
      });
      assert.equal(findLatticeWin(state.boards), null, "the fixture must start without a line");

      const applied = play(state, { seat, boardIndex: c, cellIndex: pending.finalCell });

      assert.equal(applied.boardClaimed, mark);
      assert.equal(applied.matchCompleted, true, `line ${line} must end the match for ${mark}`);
      assert.equal(applied.winnerSeat, seat);
      assert.deepEqual(applied.winningBoards, [...line]);
      assert.deepEqual(applied.state.winningBoards, [...line]);
      assert.equal(applied.state.phase, "finished");
      assert.equal(applied.state.winner, seat);
      assert.equal(applied.state.nextBoard, null, "a finished match requires no destination");
      assert.equal(computeMatchResult(applied.state).result, seat);
      assert.equal(statusForState(applied.state), MATCH_STATUS.FINISHED);
    }
  }
});

test("11. a lattice win is detected on the very move that claims the final board", () => {
  // Board 6 is the last one X needs for the left column (0, 3, 6).
  const pending = pendingBoard("X", [0, 1, 2]);
  const state = craft({
    boards: {
      0: claimedBoard("X"),
      3: claimedBoard("X"),
      6: board(pending.cells),
    },
    currentTurn: "player1",
    ply: 12,
    nextBoard: 6,
  });

  const applied = play(state, { boardIndex: 6, cellIndex: pending.finalCell });
  assert.equal(applied.matchCompleted, true);
  assert.deepEqual(applied.state.winningBoards, [0, 3, 6]);
  assert.equal(applied.state.phase, "finished");
  assert.equal(applied.state.ply, 13);
  assert.equal(applied.state.version, state.version + 1);

  // The transition is terminal — neither seat can add a move.
  refuse(applied.state, { seat: "player2", boardIndex: 0, cellIndex: 0, status: 409 });
  refuse(applied.state, { seat: "player1", boardIndex: 4, cellIndex: 4, status: 409 });
  assert.throws(
    () => applyMove({ state: applied.state, seat: "player2", boardIndex: 4, cellIndex: 4 }),
    RangeError,
    "the engine itself refuses to progress a finished match",
  );
});

test("11b. a REAL 21-ply match from the opening wins X the left column", () => {
  let state = createInitialState();

  X_WINS_SEQUENCE.forEach((move, index) => {
    assert.equal(move.seat, state.currentTurn, `ply ${index} must be ${state.currentTurn}'s`);
    if (index < X_WINS_SEQUENCE.length - 1) {
      assert.equal(state.phase, "playing");
    }
    state = play(state, move).state;
  });

  assert.equal(state.phase, "finished");
  assert.equal(state.winner, "player1");
  assert.deepEqual(state.winningBoards, [0, 3, 6]);
  assert.equal(state.ply, X_WINS_SEQUENCE.length);
  assert.equal(state.version, 1 + X_WINS_SEQUENCE.length);
  assert.equal(computeMatchResult(state).result, "player1");

  // Every mini-board X owns is a real line, and the column is complete.
  for (const slot of [0, 3, 6]) {
    assert.equal(state.boards[slot].control, "X");
    assert.ok(state.boards[slot].winningLine, `board ${slot} must have a winning line`);
  }

  // Game over: the next seat to move cannot.
  refuse(state, { seat: state.currentTurn, boardIndex: 0, cellIndex: 0, status: 409 });
});

test("12. a fully resolved lattice with no winning line is a DRAW", () => {
  // X owns 0, 1, 3; O owns 2, 5, 6; 4 and 7 are drawn; 8 is one fill from a draw.
  // Neither side has three collinear boards.
  const lastCells = [...DRAW_CELLS];
  lastCells[1] = null;

  const state = craft({
    boards: {
      0: claimedBoard("X"),
      1: claimedBoard("X"),
      3: claimedBoard("X"),
      2: claimedBoard("O"),
      5: claimedBoard("O"),
      6: claimedBoard("O"),
      4: board(DRAW_CELLS),
      7: board(DRAW_CELLS),
      8: board(lastCells),
    },
    currentTurn: "player1",
    ply: 8,
    nextBoard: 8,
  });
  assert.equal(findLatticeWin(state.boards), null);
  assert.deepEqual(completedBoardIndexes(state), [0, 1, 2, 3, 4, 5, 6, 7]);

  const applied = play(state, { boardIndex: 8, cellIndex: 1 });

  assert.equal(applied.state.boards[8].control, "draw");
  assert.equal(allBoardsResolved(applied.state.boards), true);
  assert.equal(findLatticeWin(applied.state.boards), null, "the fixture must have no line");
  assert.equal(applied.matchCompleted, true);
  assert.equal(applied.winnerSeat, null);
  assert.equal(applied.state.phase, "finished");
  assert.equal(applied.state.winner, null);
  assert.equal(applied.state.winningBoards, null);
  assert.deepEqual(computeMatchResult(applied.state), { result: RESULT.TIE, winnerSeat: null });
  assert.deepEqual(completedBoardIndexes(applied.state), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(activeBoardIndexes(applied.state), []);
});

test("12b. a lattice line beats the full-lattice draw on the very last board", () => {
  // The final unclaimed board completes X's row (0, 1, 2) — a WIN, not a draw,
  // even though the lattice is fully resolved by that same move.
  const pending = pendingBoard("X", [0, 1, 2]);
  const state = craft({
    boards: {
      0: claimedBoard("X"),
      1: claimedBoard("X"),
      2: board(pending.cells),
      3: claimedBoard("O"),
      5: claimedBoard("O"),
      4: board(DRAW_CELLS),
      6: board(DRAW_CELLS),
      7: board(DRAW_CELLS),
      8: board(DRAW_CELLS),
    },
    currentTurn: "player1",
    ply: 12,
    nextBoard: 2,
  });

  const applied = play(state, { boardIndex: 2, cellIndex: pending.finalCell });
  assert.equal(allBoardsResolved(applied.state.boards), true);
  assert.equal(applied.state.winner, "player1", "the line outranks the draw");
  assert.deepEqual(applied.state.winningBoards, [0, 1, 2]);
  assert.deepEqual(computeMatchResult(applied.state), { result: "player1", winnerSeat: "player1" });
});

test("13. no move can be played once the match has ended", () => {
  const pending = pendingBoard("O", [3, 4, 5]);
  const finished = play(
    craft({
      boards: { 3: claimedBoard("O"), 4: claimedBoard("O"), 5: board(pending.cells) },
      currentTurn: "player2",
      ply: 11,
      nextBoard: 5,
    }),
    { seat: "player2", boardIndex: 5, cellIndex: pending.finalCell },
  ).state;
  assert.equal(finished.phase, "finished");

  for (const seat of ["player1", "player2"]) {
    for (const boardIndex of [0, 4, 8]) {
      refuse(finished, { seat, boardIndex, cellIndex: 0, status: 409 });
    }
  }
  // A finished match with no winner (a draw) is terminal too.
  const drawn = craft({ phase: "finished", winner: null });
  refuse(drawn, { seat: "player1", boardIndex: 0, cellIndex: 0, status: 409 });
});

// ── 14. Invalid input is rejected safely ──────────────────────────────────

test("14. invalid board/cell indices are rejected with 400 (no coercion)", () => {
  const state = createInitialState();
  for (const bad of [-1, 9, 42, 1.5, "3", "", true, false, null, undefined, NaN, Infinity, [], {}]) {
    refuse(state, { boardIndex: bad, cellIndex: 0, status: 400 });
  }
  for (const bad of [-1, 9, 42, 1.5, "3", "", true, false, null, undefined, NaN, Infinity, [], {}]) {
    refuse(state, { boardIndex: 0, cellIndex: bad, status: 400 });
  }
  // The strictness is also exposed as predicates.
  assert.equal(isValidBoardIndex(0), true);
  assert.equal(isValidBoardIndex(8), true);
  assert.equal(isValidBoardIndex(-1), false);
  assert.equal(isValidBoardIndex(9), false);
  assert.equal(isValidBoardIndex("0"), false);
  assert.equal(isValidCellIndex(8), true);
  assert.equal(isValidCellIndex(9), false);
  assert.equal(isValidCellIndex(true), false);
});

test("14b. an occupied cell and an illegal seat are rejected", () => {
  // X opens on board 0's centre, sending O to board 4; O answers, sending X
  // back to board 0 — where the centre is already taken.
  const afterX = play(createInitialState(), { boardIndex: 0, cellIndex: 4 }).state;
  const afterO = play(afterX, { seat: "player2", boardIndex: 4, cellIndex: 0 }).state;
  const occupied = refuse(afterO, { seat: "player1", boardIndex: 0, cellIndex: 4, status: 409 });
  assert.match(occupied.error, /occupied/);

  refuse(createInitialState(), { seat: null, boardIndex: 0, cellIndex: 0, status: 403 });
  refuse(createInitialState(), { seat: "player3", boardIndex: 0, cellIndex: 0, status: 409 });
});

test("14c. malformed state is refused rather than guessed at", () => {
  const good = createInitialState();
  const malformed = [
    undefined,
    null,
    "state",
    42,
    {},
    { ...good, boards: "not-an-array" },
    { ...good, boards: good.boards.slice(0, 8) },
    { ...good, boards: [...good.boards, createEmptyBoard()] },
    { ...good, boards: [{ cells: [1, 2] }, ...good.boards.slice(1)] },
    { ...good, boards: [{ ...good.boards[0], cells: ["Y", ...good.boards[0].cells.slice(1)] }, ...good.boards.slice(1)] },
    { ...good, phase: "paused" },
    { ...good, currentTurn: "player3" },
    { ...good, version: "1" },
    { ...good, version: -1 },
    { ...good, ply: 1.5 },
    { ...good, ply: -1 },
    { ...good, nextBoard: 9 },
    { ...good, nextBoard: 1.5 },
  ];

  for (const bad of malformed) {
    assert.equal(isWellFormedState(bad), false, `must be malformed: ${JSON.stringify(bad?.phase)}`);
    refuse(bad, { seat: "player1", boardIndex: 0, cellIndex: 0, status: 500 });
  }
  assert.equal(isWellFormedState(good), true);
  // A null slot is NOT malformed: it is how a legacy expansion-era row reads.
  assert.equal(isWellFormedState(craft({ boards: { 0: claimedBoard("X") } })), true);
});

test("14d. applyMove refuses to index out of range or overwrite a cell", () => {
  const state = createInitialState();
  assert.throws(() => applyMove({ state, seat: "player1", boardIndex: 9, cellIndex: 0 }), RangeError);
  assert.throws(() => applyMove({ state, seat: "player1", boardIndex: -1, cellIndex: 0 }), RangeError);
  assert.throws(() => applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 9 }), RangeError);

  const occupied = play(state, { boardIndex: 0, cellIndex: 2 }).state;
  assert.throws(
    () => applyMove({ state: occupied, seat: "player2", boardIndex: 0, cellIndex: 2 }),
    RangeError,
  );
});

test("14e. a stale expectedVersion is refused, a correct one is accepted", () => {
  const state = createInitialState();
  assert.equal(state.version, 1);

  assert.equal(validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0, expectedVersion: 1 }).ok, true);
  assert.equal(validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0, expectedVersion: undefined }).ok, true);
  assert.equal(validateMove({ state, seat: "player1", boardIndex: 0, cellIndex: 0, expectedVersion: null }).ok, true);

  for (const bad of [0, 2, "1", true, 1.5, [1]]) {
    refuse(state, { boardIndex: 0, cellIndex: 0, expectedVersion: bad, status: 409 });
  }

  const next = play(state, { boardIndex: 0, cellIndex: 0 }).state;
  assert.equal(next.version, 2);
  refuse(next, { seat: "player2", boardIndex: 0, cellIndex: 1, expectedVersion: 1, status: 409 });
  assert.equal(
    validateMove({ state: next, seat: "player2", boardIndex: 0, cellIndex: 1, expectedVersion: 2 }).ok,
    true,
  );
});

// ── 15. Turn order ────────────────────────────────────────────────────────

test("15. turns alternate, and the closed form agrees with the stored turn", () => {
  let state = createInitialState();
  const seats = [];
  for (let i = 0; i < 12; i += 1) {
    assert.equal(state.currentTurn, seatForPly(state.ply), `ply ${state.ply}`);
    const boardIndex = playableBoardIndexes(state)[0];
    const cellIndex = state.boards[boardIndex].cells.indexOf(null);
    seats.push(state.currentTurn);
    state = play(state, { boardIndex, cellIndex }).state;
  }
  assert.deepEqual(seats, [
    "player1",
    "player2",
    "player1",
    "player2",
    "player1",
    "player2",
    "player1",
    "player2",
    "player1",
    "player2",
    "player1",
    "player2",
  ]);
  assert.equal(state.ply, 12);
  assert.equal(state.lastMove.seat, "player2");
});

// ── 16. Purity ────────────────────────────────────────────────────────────

test("16. applyMove never mutates the state it was given", () => {
  const state = createInitialState();
  const before = snapshot(state);

  // Deep-freeze: any write to the previous state would throw in strict mode.
  const freeze = (value) => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(state);

  const applied = play(state, { boardIndex: 3, cellIndex: 5 });

  assert.deepEqual(snapshot(state), before, "the previous state must be untouched");
  assert.notEqual(applied.state, state);
  assert.notEqual(applied.state.boards, state.boards);
  assert.notEqual(applied.state.boards[3], state.boards[3], "the touched board is a copy");
  assert.notEqual(applied.state.boards[3].cells, state.boards[3].cells);
  assert.notEqual(applied.state.lastMove, state.lastMove);
  // An untouched board is copied too, so no later move can alias the old state.
  assert.notEqual(applied.state.boards[0], state.boards[0]);
  assert.deepEqual(applied.state.boards[0].cells, state.boards[0].cells);

  const nextBefore = snapshot(applied.state);
  play(applied.state, { seat: "player2", boardIndex: 5, cellIndex: 0 });
  assert.deepEqual(snapshot(applied.state), nextBefore);
});

test("16b. a claiming move leaves the previous board and cells untouched", () => {
  const pending = pendingBoard("X", [0, 1, 2]);
  const state = craft({
    boards: { 4: board(pending.cells) },
    currentTurn: "player1",
    ply: 4,
    nextBoard: 4,
  });
  const before = snapshot(state);
  const applied = play(state, { boardIndex: 4, cellIndex: pending.finalCell });

  assert.deepEqual(snapshot(state), before);
  assert.deepEqual(state.boards[4].cells[pending.finalCell], null, "the old board keeps its hole");
  assert.equal(state.boards[4].control, "active");
  assert.equal(applied.state.boards[4].cells[pending.finalCell], "X");
});

// ── 17. Version and move history ──────────────────────────────────────────

test("17. version and ply advance by exactly one per accepted move", () => {
  let state = createInitialState();
  assert.equal(state.version, 1);
  assert.equal(state.ply, 0);

  X_WINS_SEQUENCE.slice(0, 8).forEach((move, index) => {
    const applied = play(state, move);
    assert.equal(applied.state.version, state.version + 1);
    assert.equal(applied.state.ply, state.ply + 1);
    assert.equal(applied.state.lastMove.ply, state.ply, "lastMove records the PRE-move ply");
    assert.equal(applied.state.lastMove.seat, move.seat);
    assert.equal(applied.state.lastMove.mark, MARK_FOR_SEAT[move.seat]);
    assert.equal(applied.state.lastMove.boardIndex, move.boardIndex);
    assert.equal(applied.state.lastMove.cellIndex, move.cellIndex);
    assert.equal(applied.state.version, index + 2);
    state = applied.state;
  });
});

test("17b. replayMoves rebuilds the exact state from the move log", () => {
  let state = createInitialState();
  const log = [];
  for (const move of X_WINS_SEQUENCE) {
    log.push({
      ply: state.ply,
      playerId: move.seat === "player1" ? ALICE : BOB,
      boardIndex: move.boardIndex,
      cellIndex: move.cellIndex,
    });
    state = play(state, move).state;
  }

  const replay = replayMoves(log);
  assert.deepEqual(replay.state, state);
  assert.deepEqual(replay.boards, state.boards);
  assert.equal(replay.ply, state.ply);
  assert.equal(replay.nextBoard, state.nextBoard);
  assert.equal(replay.winner, state.winner);
  assert.deepEqual(replay.winningBoards, state.winningBoards);

  // Order of the log does not matter: it is sorted by ply before replaying.
  const shuffled = [...log].reverse();
  assert.deepEqual(replayMoves(shuffled).state, state);
});

test("17c. replay ignores illegal, duplicated and post-match log entries", () => {
  let state = createInitialState();
  const log = [];
  for (const move of X_WINS_SEQUENCE.slice(0, 5)) {
    log.push({
      ply: state.ply,
      playerId: move.seat === "player1" ? ALICE : BOB,
      boardIndex: move.boardIndex,
      cellIndex: move.cellIndex,
    });
    state = play(state, move).state;
  }

  const dirty = [
    ...log,
    // The same move twice — the cell is taken, so the duplicate is skipped.
    { ...log[log.length - 1] },
    // A board that is not the required destination.
    { ply: state.ply, playerId: BOB, boardIndex: (state.nextBoard + 3) % 9, cellIndex: 0 },
    // Indices that do not exist.
    { ply: state.ply, playerId: BOB, boardIndex: 9, cellIndex: 0 },
    { ply: state.ply, playerId: BOB, boardIndex: 0, cellIndex: -1 },
    { ply: state.ply, playerId: BOB, boardIndex: "2", cellIndex: "2" },
  ];

  const replay = replayMoves(dirty);
  assert.deepEqual(replay.state, state, "the dirty entries must be skipped, not applied");
});

// ── The engine derives; it never accepts ─────────────────────────────────

test("the mark comes from the SEAT, and a tampered board control is ignored", () => {
  // `applyMove` derives the mark from the seat it is told to act for...
  const applied = applyMove({
    state: createInitialState(),
    seat: "player2",
    boardIndex: 0,
    cellIndex: 0,
  });
  assert.equal(applied.state.boards[0].cells[0], "O", "player2 places O, never X");

  // ...and a stored `control` that disagrees with the cells is re-derived.
  const tampered = craft({
    boards: { 4: { ...board(emptyBoardCells()), control: "X", winningLine: [0, 1, 2], plies: 3 } },
    currentTurn: "player1",
    ply: 2,
  });
  assert.equal(boardControlAt(tampered, 4), "active");
  assert.equal(findLatticeWin(tampered.boards), null);
  assert.equal(allBoardsResolved(tampered.boards), false);
  const corrected = play(tampered, { boardIndex: 4, cellIndex: 4 });
  assert.equal(corrected.state.boards[4].control, "active");
  assert.equal(corrected.state.boards[4].plies, 1, "plies are counted from the cells");
});

test("a legacy null slot reads as an empty, active board instead of deadlocking", () => {
  const legacy = craft({ boards: { 0: board(["X", "O", null, null, null, null, null, null, null]) } });
  assert.equal(isWellFormedState(legacy), true);
  assert.deepEqual(activeBoardIndexes(legacy), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(latticeOf(legacy).length, 9);
  assert.deepEqual(latticeOf(legacy)[5].cells, emptyBoardCells());

  const applied = play(legacy, { boardIndex: 5, cellIndex: 0 });
  assert.equal(applied.state.boards[5].cells[0], "X");
  assert.equal(applied.state.boards.length, 9);
});

// ── The view projection ───────────────────────────────────────────────────

test("normalizeForViewer exposes the derived truth and the per-viewer flags", () => {
  const state = createInitialState();
  const forAlice = normalizeForViewer({ state, seats: SEATS, viewerId: ALICE });

  assert.equal(forAlice.version, 1);
  assert.equal(forAlice.status, MATCH_STATUS.PLAYING);
  assert.equal(forAlice.viewerSeat, "player1");
  assert.equal(forAlice.viewerMark, "X");
  assert.equal(forAlice.isViewerTurn, true);
  assert.equal(forAlice.viewerCanMove, true);
  assert.equal(forAlice.boards.length, 9);
  assert.equal(forAlice.nextBoard, null);
  assert.deepEqual(forAlice.playableBoards, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // No expansion-era vocabulary survives in the DTO: the view derives every
  // slot list from `boards` / `nextBoard` / `playableBoards`.
  for (const gone of ["stage", "stageBoardSlots", "megaSize", "tiebreak", "suddenDeath"]) {
    assert.equal(gone in forAlice, false, `the DTO must not carry ${gone}`);
  }
  assert.equal(forAlice.boardSize, 3);
  assert.equal(forAlice.cellCount, 9);
  assert.equal(forAlice.latticeSize, 3);
  assert.equal(forAlice.maxBoards, 9);
  assert.equal(forAlice.currentTurnUserId, ALICE);

  const afterMove = play(state, { boardIndex: 0, cellIndex: 4 }).state;
  const forBob = normalizeForViewer({ state: afterMove, seats: SEATS, viewerId: BOB });
  assert.equal(forBob.viewerSeat, "player2");
  assert.equal(forBob.isViewerTurn, true);
  assert.equal(forBob.viewerCanMove, true);
  assert.equal(forBob.nextBoard, 4);
  assert.deepEqual(forBob.playableBoards, [4]);
  assert.deepEqual(forBob.completedBoards, []);
  assert.equal(forBob.currentTurnUserId, BOB);

  const forAliceAgain = normalizeForViewer({ state: afterMove, seats: SEATS, viewerId: ALICE });
  assert.equal(forAliceAgain.isViewerTurn, false);
  assert.equal(forAliceAgain.viewerCanMove, false);
});

test("normalizeForViewer never offers a move on a terminal, cancelled or spectator view", () => {
  const finished = craft({ phase: "finished", winner: "player1", winningBoards: [0, 3, 6] });
  const done = normalizeForViewer({
    state: finished,
    seats: SEATS,
    viewerId: ALICE,
    status: MATCH_STATUS.FINISHED,
    result: "player1",
    winnerId: ALICE,
  });
  assert.equal(done.status, MATCH_STATUS.FINISHED);
  assert.equal(done.viewerCanMove, false);
  assert.equal(done.result, "player1");
  assert.equal(done.winnerId, ALICE);
  assert.deepEqual(done.winningBoards, [0, 3, 6]);

  const cancelled = normalizeForViewer({
    state: createInitialState(),
    seats: SEATS,
    viewerId: ALICE,
    status: "cancelled",
  });
  assert.equal(cancelled.viewerCanMove, false);

  const spectator = normalizeForViewer({ state: createInitialState(), seats: SEATS, viewerId: MALLORY });
  assert.equal(spectator.viewerSeat, null);
  assert.equal(spectator.viewerMark, null);
  assert.equal(spectator.viewerCanMove, false);
});

test("computeMatchResult and statusForState are derived from the state alone", () => {
  assert.deepEqual(computeMatchResult(createInitialState()), { result: RESULT.TIE, winnerSeat: null });
  const won = craft({ phase: "finished", winner: "player2" });
  assert.deepEqual(computeMatchResult(won), { result: "player2", winnerSeat: "player2" });
  assert.equal(statusForState(createInitialState()), MATCH_STATUS.PLAYING);
  assert.equal(statusForState(won), MATCH_STATUS.FINISHED);
});

test("board helpers are total and refuse malformed input", () => {
  assert.equal(isWellFormedBoard(emptyBoardCells()), true);
  assert.equal(isWellFormedBoard(["X", "O"]), false);
  assert.equal(isWellFormedBoard("board"), false);
  assert.equal(isWellFormedBoard(undefined), false);
  assert.equal(findWinningLine(["Y", ...emptyBoardCells().slice(1)]), null);
  assert.equal(isBoardFull(emptyBoardCells()), false);
  assert.deepEqual(resolveBoardControl(emptyBoardCells()), { control: "active", winningLine: null });
  assert.deepEqual(resolveBoardControl(DRAW_CELLS), { control: "draw", winningLine: null });
  assert.equal(countCells(DRAW_CELLS, "X"), 5);
  assert.equal(countCells(DRAW_CELLS, "O"), 4);
  assert.equal(createEmptyBoard().control, "active");
});

// ── The whole lifecycle, fuzzed ───────────────────────────────────────────

test("fuzz: random legal play keeps every invariant and replays exactly", () => {
  const invariants = (before, applied, seat) => {
    const after = applied.state;
    assert.equal(after.version, before.version + 1);
    assert.equal(after.ply, before.ply + 1);
    assert.equal(after.currentTurn, otherSeat(seat));
    assert.equal(after.lastMove.mark, markForSeat(seat));
    assert.equal(after.lastMove.seat, seat);
    assert.equal(after.lastMove.ply, before.ply);

    if (after.phase === "finished") {
      assert.equal(after.nextBoard, null);
      const line = findLatticeWin(after.boards);
      if (after.winner) {
        assert.ok(line, "a won match must have a lattice line");
        assert.equal(seatForMark(line.mark), after.winner);
        assert.deepEqual(after.winningBoards, line.line);
      } else {
        assert.equal(line, null, "a drawn match must have no lattice line");
        assert.equal(allBoardsResolved(after.boards), true);
      }
    } else {
      // A continuing match always offers at least one move, and the required
      // destination is exactly what this move's cell implies.
      assert.ok(playableBoardIndexes(after).length > 0);
      assert.equal(requiredBoardIndex(after), nextBoardForCell(after.boards, after.lastMove.cellIndex));
      assert.equal(after.winner, null);
    }

    // A resolved board is never active, and vice versa.
    for (const slot of LATTICE_SLOTS) {
      const control = after.boards[slot].control;
      assert.equal(activeBoardIndexes(after).includes(slot), control === "active");
      assert.equal(completedBoardIndexes(after).includes(slot), control !== "active");
    }
  };

  let finishedGames = 0;
  let wonGames = 0;

  for (const seed of [1, 2, 3, 7, 11, 42, 99, 1234]) {
    const random = lcg(seed);
    let state = createInitialState();
    const log = [];

    while (state.phase === "playing" && log.length < 300) {
      const boards = playableBoardIndexes(state);
      assert.ok(boards.length > 0, "a live match always has a legal move");
      const boardIndex = boards[Math.floor(random() * boards.length)];
      const cells = state.boards[boardIndex].cells;
      const empty = LATTICE_SLOTS.filter((cell) => cells[cell] === null);
      const cellIndex = empty[Math.floor(random() * empty.length)];
      const seat = state.currentTurn;

      const check = validateMove({ state, seat, boardIndex, cellIndex });
      assert.equal(check.ok, true, `seed ${seed}: ${followUp(check)}`);

      const before = snapshot(state);
      const applied = applyMove({ state, seat, boardIndex, cellIndex });
      assert.deepEqual(snapshot(state), before, "applyMove must not mutate its input");
      invariants(state, applied, seat);

      log.push({
        ply: state.ply,
        playerId: seat === "player1" ? ALICE : BOB,
        boardIndex,
        cellIndex,
      });
      state = applied.state;
    }

    assert.equal(state.phase, "finished", `seed ${seed} must reach a terminal position`);
    finishedGames += 1;
    if (state.winner) wonGames += 1;

    // The log alone reproduces the match.
    assert.deepEqual(replayMoves(log).state, state);
    assert.equal(replayMoves(log).ply, state.ply);
  }

  assert.equal(finishedGames, 8);
  assert.ok(wonGames > 0, "random play must produce some decisive matches");
});

/** Small helper so a failed fuzz assertion says why. */
function followUp(check) {
  return check.ok ? "ok" : check.error;
}
