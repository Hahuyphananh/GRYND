/**
 * tic-tac-toe-rules.test.mjs
 *
 * The PURE Tic-Tac-Toe Duel engine, pinned exhaustively.
 *
 * The rules engine is the authoritative game logic: it decides whose turn it
 * is, whose mark lands where, whether a line was completed, whether the board
 * is a draw, and who won. It is pure (no DB, no I/O, no randomness), so every
 * branch can be pinned here — including all eight winning lines, both seats
 * winning, the nine-move draw, and every field a client must not be able to
 * decide.
 *
 * It also asserts the anti-cheat property directly: the mark is derived from the
 * acting SEAT, and the winner/draw are derived from the board the server owns.
 * Nothing here reads a client-supplied winner, result, score, turn, board or
 * completion flag, because no such value is ever passed in.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMove,
  computeMatchResult,
  createInitialState,
  findWinningLine,
  isBoardFull,
  isValidCellIndex,
  isWellFormedBoard,
  markForSeat,
  normalizeForViewer,
  otherSeat,
  replayMoves,
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
  MATCH_STATUS,
  RESULT,
  TIC_TAC_TOE_LOCK_NAMESPACE,
  WINNING_LINES,
} from "../src/lib/tic-tac-toe/constants.ts";

const SEATS = { player1Id: "user_alice", player2Id: "user_bob" };
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";

/** Mutating driver — `applyMove` is pure, so tests thread the state forward. */
function play(state, seat, cellIndex) {
  return applyMove({ state, seat, cellIndex }).state;
}

/** Seat for the nth ply: X (player1) opens, so even plies are player1. */
const seatAt = (ply) => (ply % 2 === 0 ? "player1" : "player2");

function playMoves(cells) {
  let state = createInitialState();
  cells.forEach((cellIndex, index) => {
    state = play(state, seatAt(index), cellIndex);
  });
  return state;
}

// ── Vocabulary ────────────────────────────────────────────────────────────

test("constants: the board is 3x3 and enumerates exactly the eight lines", () => {
  assert.equal(BOARD_SIZE, 3);
  assert.equal(CELL_COUNT, 9);
  assert.equal(WINNING_LINES.length, 8);
  for (const line of WINNING_LINES) {
    assert.equal(line.length, 3);
    for (const index of line) assert.ok(index >= 0 && index < CELL_COUNT);
  }
  // No duplicates.
  const asStrings = WINNING_LINES.map((line) => [...line].sort().join(","));
  assert.equal(new Set(asStrings).size, 8);
  // Every cell participates in at least one line.
  const covered = new Set(WINNING_LINES.flat());
  assert.equal(covered.size, CELL_COUNT);
});

test("constants: X is first and the lock namespace is the ASCII tag TICT", () => {
  assert.equal(FIRST_SEAT, "player1");
  assert.equal(markForSeat("player1"), "X");
  assert.equal(markForSeat("player2"), "O");
  // Distinct from Mini Golf's 0x4d474c46 ("MGLF") so the two games' matchmaking
  // locks can never contend.
  assert.equal(TIC_TAC_TOE_LOCK_NAMESPACE, 0x54494354);
  assert.notEqual(TIC_TAC_TOE_LOCK_NAMESPACE, 0x4d474c46);
});

test("seats: mapping, inversion and participation", () => {
  assert.equal(markForSeat("player2"), "O");
  assert.equal(seatForMark("X"), "player1");
  assert.equal(seatForMark("O"), "player2");
  assert.equal(seatForUser(SEATS, ALICE), "player1");
  assert.equal(seatForUser(SEATS, BOB), "player2");
  assert.equal(seatForUser(SEATS, MALLORY), null);
  assert.equal(seatForUser(SEATS, null), null);
  assert.equal(otherSeat("player1"), "player2");
  assert.equal(otherSeat("player2"), "player1");
  assert.equal(userIdForSeat(SEATS, "player1"), ALICE);
  assert.equal(userIdForSeat({ player1Id: ALICE, player2Id: null }, "player2"), null);
  assert.deepEqual(seatsFromMatch({ player1Id: ALICE }), {
    player1Id: ALICE,
    player2Id: null,
  });
});

test("seatForPly: X opens and the seats alternate", () => {
  assert.equal(seatForPly(0), "player1");
  assert.equal(seatForPly(1), "player2");
  assert.equal(seatForPly(2), "player1");
  assert.equal(seatForPly(8), "player1");
});

// ── The opening position ──────────────────────────────────────────────────

test("createInitialState: empty board, X to move, no seed, no randomness", () => {
  const state = createInitialState();
  assert.equal(state.version, 1);
  assert.equal(state.phase, "playing");
  assert.equal(state.ply, 0);
  assert.equal(state.currentTurn, "player1");
  assert.equal(state.winner, null);
  assert.equal(state.winningLine, null);
  assert.equal(state.lastMove, null);
  assert.equal(state.board.length, CELL_COUNT);
  assert.ok(state.board.every((cell) => cell === null));
  // Tic-tac-toe has no dealt state, so two fresh matches are identical.
  assert.deepEqual(createInitialState(), createInitialState());
  assert.equal("seed" in state, false);
});

// ── Turn order ────────────────────────────────────────────────────────────

test("applyMove: the mark is derived from the acting seat, never supplied", () => {
  const start = createInitialState();
  const x = applyMove({ state: start, seat: "player1", cellIndex: 4 }).state;
  assert.equal(x.board[4], "X");
  const y = applyMove({ state: x, seat: "player2", cellIndex: 0 }).state;
  assert.equal(y.board[0], "O");
});

test("applyMove: turn alternates and version/ply advance monotonically", () => {
  let state = createInitialState();
  for (let ply = 0; ply < 5; ply += 1) {
    assert.equal(state.currentTurn, seatAt(ply), `turn at ply ${ply}`);
    assert.equal(state.ply, ply);
    assert.equal(state.version, ply + 1);
    state = play(state, seatAt(ply), ply);
  }
  assert.equal(state.ply, 5);
  assert.equal(state.version, 6);
  assert.equal(state.currentTurn, seatAt(5));
});

test("applyMove: lastMove records the seat, cell, mark and turn number", () => {
  let state = createInitialState();
  state = play(state, "player1", 3);
  assert.deepEqual(state.lastMove, {
    seat: "player1",
    cellIndex: 3,
    mark: "X",
    ply: 0,
  });
  state = play(state, "player2", 5);
  assert.deepEqual(state.lastMove, {
    seat: "player2",
    cellIndex: 5,
    mark: "O",
    ply: 1,
  });
});

test("applyMove: an out-of-range cell throws rather than corrupting the board", () => {
  const state = createInitialState();
  for (const bad of [-1, 9, 1.5, NaN]) {
    assert.throws(
      () => applyMove({ state, seat: "player1", cellIndex: bad }),
      RangeError,
      `cell ${bad}`,
    );
  }
});

// ── Winning ───────────────────────────────────────────────────────────────

test("every one of the eight lines wins for X, and reports the line", () => {
  for (const line of WINNING_LINES) {
    const fillers = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !line.includes(i));
    // X takes the line's three cells; O takes three cells outside it.
    const state = playMoves([
      line[0], fillers[0],
      line[1], fillers[1],
      line[2],
    ]);
    assert.equal(state.winner, "player1", `line ${line.join(",")}`);
    assert.equal(state.phase, "finished");
    assert.deepEqual(state.winningLine, [...line]);
    assert.equal(state.ply, 5);
  }
});

/**
 * Three cells outside `line` that do NOT themselves form a line.
 *
 * Needed so X's three moves cannot accidentally end the game before O's sixth
 * move lands.
 */
function harmlessFillers(line) {
  const outside = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !line.includes(i));
  for (let a = 0; a < outside.length; a += 1) {
    for (let b = a + 1; b < outside.length; b += 1) {
      for (let c = b + 1; c < outside.length; c += 1) {
        const set = [outside[a], outside[b], outside[c]];
        const formsLine = WINNING_LINES.some((l) => l.every((i) => set.includes(i)));
        if (!formsLine) return set;
      }
    }
  }
  throw new Error(`no harmless fillers for line ${line.join(",")}`);
}

test("every one of the eight lines wins for O as well", () => {
  for (const line of WINNING_LINES) {
    const fillers = harmlessFillers(line);
    // X plays three cells that can never make a line; O takes the line.
    const state = playMoves([
      fillers[0], line[0],
      fillers[1], line[1],
      fillers[2], line[2],
    ]);
    assert.equal(state.winner, "player2", `line ${line.join(",")}`);
    assert.deepEqual(state.winningLine, [...line]);
    assert.equal(state.ply, 6);
  }
});

test("wins: X completes a horizontal, a vertical and a diagonal line", () => {
  // Horizontal — top row (0,1,2).
  const horizon = playMoves([0, 3, 1, 4, 2]);
  assert.equal(horizon.winner, "player1");
  assert.deepEqual(horizon.winningLine, [0, 1, 2]);
  // Vertical — first column (0,3,6).
  const vertical = playMoves([0, 1, 3, 2, 6]);
  assert.equal(vertical.winner, "player1");
  assert.deepEqual(vertical.winningLine, [0, 3, 6]);
  // Diagonal — main diagonal (0,4,8).
  const diagonal = playMoves([0, 1, 4, 2, 8]);
  assert.equal(diagonal.winner, "player1");
  assert.deepEqual(diagonal.winningLine, [0, 4, 8]);
});

test("wins: O completes a horizontal, a vertical and a diagonal line", () => {
  // Horizontal — top row (0,1,2), O moving second.
  const horizon = playMoves([3, 0, 4, 1, 7, 2]);
  assert.equal(horizon.winner, "player2");
  assert.deepEqual(horizon.winningLine, [0, 1, 2]);
  // Vertical — first column (0,3,6).
  const vertical = playMoves([1, 0, 2, 3, 4, 6]);
  assert.equal(vertical.winner, "player2");
  assert.deepEqual(vertical.winningLine, [0, 3, 6]);
  // Diagonal — main diagonal (0,4,8).
  const diagonal = playMoves([1, 0, 3, 4, 5, 8]);
  assert.equal(diagonal.winner, "player2");
  assert.deepEqual(diagonal.winningLine, [0, 4, 8]);
});

test("incomplete game: a partly-filled board stays playing and moveable", () => {
  const state = playMoves([4, 0, 8]);
  assert.equal(state.phase, "playing");
  assert.equal(state.winner, null);
  assert.equal(state.winningLine, null);
  assert.equal(state.ply, 3);
  assert.equal(state.currentTurn, "player2");
  assert.equal(statusForState(state), MATCH_STATUS.PLAYING);
  assert.equal(isBoardFull(state.board), false);
  // The server still offers the move to the seat whose turn it is.
  assert.equal(validateMove({ state, seat: "player2", cellIndex: 1 }).ok, true);
  assert.equal(validateMove({ state, seat: "player1", cellIndex: 1 }).ok, false);
});

test("a win on the ninth move still reports the winner, not a draw", () => {
  // X: 0,1,5,6,8  O: 2,3,4,7 — X completes 0,4,8? no; use a real last-move win.
  const state = playMoves([0, 3, 1, 4, 7, 5, 2, 6, 8]);
  // Board: X 0,1,7,2,8 ; O 3,4,5,6 → X has 0,1,2 (row) and 0,4,8? 4 is O.
  // X wins on the ninth move with the 0,1,2 row.
  assert.equal(state.ply, 9);
  assert.equal(state.winner, "player1");
  assert.deepEqual(state.winningLine, [0, 1, 2]);
});

test("applyMove reports matchCompleted/winnerSeat/winningLine/draw", () => {
  let state = createInitialState();
  state = play(state, "player1", 0);
  state = play(state, "player2", 3);
  state = play(state, "player1", 1);
  state = play(state, "player2", 4);
  const applied = applyMove({ state, seat: "player1", cellIndex: 2 });
  assert.equal(applied.matchCompleted, true);
  assert.equal(applied.winnerSeat, "player1");
  assert.deepEqual(applied.winningLine, [0, 1, 2]);
  assert.equal(applied.draw, false);
});

test("currentTurn is frozen on the mover once the match is finished", () => {
  const state = playMoves([0, 3, 1, 4, 2]);
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, "player1");
  // There is no next turn; the field stays pointing at the seat that just acted.
  assert.equal(state.currentTurn, "player1");
  assert.equal(state.ply, 5);
});

test("after a non-winning move the closed form and the stored turn agree", () => {
  let state = createInitialState();
  for (let ply = 0; ply < 8; ply += 1) {
    state = play(state, seatAt(ply), [4, 0, 8, 2, 6, 3, 5, 7][ply]);
    if (state.phase === "playing") {
      assert.equal(state.currentTurn, seatForPly(state.ply), `ply ${state.ply}`);
    }
  }
});

// ── Draw ──────────────────────────────────────────────────────────────────

test("a full board with no line is a draw, and can only be exactly nine moves", () => {
  const DRAW = [0, 4, 8, 2, 6, 3, 5, 7, 1];
  const state = playMoves(DRAW);
  assert.equal(state.ply, 9);
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, null);
  assert.equal(state.winningLine, null);
  assert.ok(isBoardFull(state.board));
  assert.equal(findWinningLine(state.board), null);
  assert.deepEqual(computeMatchResult(state), {
    result: RESULT.TIE,
    winnerSeat: null,
  });
  assert.equal(statusForState(state), MATCH_STATUS.FINISHED);
});

test("the fourth same-cell line is impossible: a win ends the match early", () => {
  // X completes a row on the fifth move; the remaining four cells stay empty.
  const state = playMoves([0, 3, 1, 4, 2]);
  assert.equal(state.ply, 5);
  assert.equal(state.board.filter((cell) => cell === null).length, 4);
  assert.ok(!isBoardFull(state.board));
});

// ── computeMatchResult / statusForState ───────────────────────────────────

test("computeMatchResult derives the winner from the board", () => {
  assert.deepEqual(computeMatchResult(playMoves([0, 3, 1, 4, 2])), {
    result: RESULT.PLAYER1,
    winnerSeat: "player1",
  });
  assert.deepEqual(computeMatchResult(playMoves([3, 0, 4, 1, 5, 2])), {
    result: RESULT.PLAYER2,
    winnerSeat: "player2",
  });
});

test("statusForState: playing until the board is decided", () => {
  assert.equal(statusForState(createInitialState()), MATCH_STATUS.PLAYING);
  assert.equal(statusForState(playMoves([0])), MATCH_STATUS.PLAYING);
  assert.equal(statusForState(playMoves([0, 3, 1, 4, 2])), MATCH_STATUS.FINISHED);
});

// ── Validation ────────────────────────────────────────────────────────────

test("isValidCellIndex accepts only integers 0..8 — no coercion", () => {
  for (const good of [0, 1, 8]) assert.equal(isValidCellIndex(good), true, String(good));
  for (const bad of [-1, 9, 1.5, NaN, Infinity, "0", "", "4", true, false, null, undefined, [], {}, [4]]) {
    assert.equal(isValidCellIndex(bad), false, JSON.stringify(bad));
  }
});

test("validateMove accepts a legal move and rejects a non-participant", () => {
  const state = createInitialState();
  const ok = validateMove({ state, seat: "player1", cellIndex: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.seat, "player1");

  const outsider = validateMove({ state, seat: null, cellIndex: 0 });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.status, 403);
  assert.match(outsider.error, /participant/i);
});

test("validateMove rejects an out-of-turn move", () => {
  const state = createInitialState();
  const res = validateMove({ state, seat: "player2", cellIndex: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /not your turn/i);
});

test("validateMove rejects an occupied cell", () => {
  const state = playMoves([4]);
  const res = validateMove({ state, seat: "player2", cellIndex: 4 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /occupied/i);
});

test("validateMove rejects every malformed cell index as a 400", () => {
  const state = createInitialState();
  for (const bad of [undefined, null, "0", "", true, [], {}, -1, 9, 1.5, NaN]) {
    const res = validateMove({ state, seat: "player1", cellIndex: bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("validateMove rejects a stale expectedVersion", () => {
  const state = playMoves([0, 1]);
  assert.equal(validateMove({ state, seat: "player1", cellIndex: 2, expectedVersion: 3 }).ok, true);
  const stale = validateMove({ state, seat: "player1", cellIndex: 2, expectedVersion: 2 });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.match(stale.error, /stale/i);
});

test("validateMove checks expectedVersion strictly — no Number() coercion", () => {
  // The current version is 3. A malformed token that `Number()` would have
  // coerced to 3 must NOT be accepted as the client's version.
  const state = playMoves([0, 1]);
  assert.equal(state.version, 3);
  for (const bad of ["3", "", true, false, [3], {}, 3.5, NaN, Infinity]) {
    const res = validateMove({ state, seat: "player1", cellIndex: 2, expectedVersion: bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.status, 409, JSON.stringify(bad));
    assert.match(res.error, /stale/i, JSON.stringify(bad));
  }
  // Omitted / null stay optional (the turn and occupancy checks still hold).
  assert.equal(validateMove({ state, seat: "player1", cellIndex: 2 }).ok, true);
  assert.equal(
    validateMove({ state, seat: "player1", cellIndex: 2, expectedVersion: null }).ok,
    true,
  );
  // The exact integer is accepted.
  assert.equal(
    validateMove({ state, seat: "player1", cellIndex: 2, expectedVersion: 3 }).ok,
    true,
  );
});

test("validateMove rejects any move once the match is finished", () => {
  const state = playMoves([0, 3, 1, 4, 2]);
  const res = validateMove({ state, seat: "player2", cellIndex: 5 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /finished/i);
});

test("validateMove never consults a client-supplied winner/result/board", () => {
  const state = createInitialState();
  const res = validateMove({
    state,
    seat: "player1",
    cellIndex: 0,
    // Fields a hostile client might attach — none of them exist as parameters.
    winner: "player1",
    result: "player1",
    board: ["X", "X", "X", null, null, null, null, null, null],
    ply: 9,
    currentTurn: "player2",
  });
  assert.equal(res.ok, true);
  // And the resulting board is the server's, not the client's.
  const after = applyMove({ state, seat: "player1", cellIndex: 0 }).state;
  assert.deepEqual(after.board, ["X", null, null, null, null, null, null, null, null]);
});

// ── Board well-formedness ─────────────────────────────────────────────────

test("isWellFormedBoard only accepts nine null/X/O cells", () => {
  assert.equal(isWellFormedBoard(["X", null, "O", null, "X", null, "O", null, "X"]), true);
  assert.equal(isWellFormedBoard(createInitialState().board), true);
  assert.equal(isWellFormedBoard([]), false);
  assert.equal(isWellFormedBoard(["X"]), false);
  assert.equal(isWellFormedBoard(new Array(9).fill("Z")), false);
  assert.equal(isWellFormedBoard("X".repeat(9)), false);
  assert.equal(isWellFormedBoard(null), false);
});

test("findWinningLine returns the first completed line or null", () => {
  assert.deepEqual(findWinningLine(["X", "X", "X", null, null, null, null, null, null]), {
    mark: "X",
    line: [0, 1, 2],
  });
  // O on the middle column (1, 4, 7).
  assert.deepEqual(
    findWinningLine([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ([1, 4, 7].includes(i) ? "O" : null))),
    { mark: "O", line: [1, 4, 7] },
  );
  // The anti-diagonal.
  assert.deepEqual(
    findWinningLine([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ([2, 4, 6].includes(i) ? "X" : null))),
    { mark: "X", line: [2, 4, 6] },
  );
  assert.equal(findWinningLine(new Array(9).fill(null)), null);
});

// ── View projection ───────────────────────────────────────────────────────

test("normalizeForViewer projects a seat, a mark and the move gate", () => {
  const state = playMoves([4]);
  const asAlice = normalizeForViewer({
    state,
    seats: SEATS,
    viewerId: ALICE,
    status: MATCH_STATUS.PLAYING,
  });
  // ALICE is player1 (X) and has just played cell 4, so it is BOB's turn.
  assert.equal(asAlice.viewerSeat, "player1");
  assert.equal(asAlice.viewerMark, "X");
  assert.equal(asAlice.isViewerTurn, false);
  assert.equal(asAlice.viewerCanMove, false);
  assert.equal(asAlice.currentTurnUserId, BOB);

  const asBob = normalizeForViewer({ state, seats: SEATS, viewerId: BOB });
  assert.equal(asBob.viewerSeat, "player2");
  assert.equal(asBob.viewerMark, "O");
  assert.equal(asBob.isViewerTurn, true);
  assert.equal(asBob.viewerCanMove, true);

  const asOutsider = normalizeForViewer({ state, seats: SEATS, viewerId: MALLORY });
  assert.equal(asOutsider.viewerSeat, null);
  assert.equal(asOutsider.viewerMark, null);
  assert.equal(asOutsider.viewerCanMove, false);
});

test("normalizeForViewer never lets the viewer move once finished", () => {
  const state = playMoves([0, 3, 1, 4, 2]);
  const dto = normalizeForViewer({ state, seats: SEATS, viewerId: ALICE });
  assert.equal(dto.phase, "finished");
  assert.equal(dto.viewerCanMove, false);
  assert.equal(dto.status, MATCH_STATUS.FINISHED);
  assert.equal(dto.winner, "player1");
  assert.deepEqual(dto.winningLine, [0, 1, 2]);
  assert.equal(dto.boardSize, BOARD_SIZE);
});

test("normalizeForViewer takes the settled outcome from the ROW, not the board", () => {
  // A conceded match: the board is unfinished, but the row is terminal. This is
  // how a forfeit or a disconnect resolution is reported.
  const state = playMoves([4]);
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

test("replayMoves reconstructs the board, ply, winner and line from the log", () => {
  const moves = [0, 4, 8, 2, 6, 3, 5, 7, 1].map((cellIndex, ply) => ({
    ply,
    playerId: ply % 2 === 0 ? ALICE : BOB,
    cellIndex,
  }));
  const rebuilt = replayMoves(moves);
  const state = playMoves([0, 4, 8, 2, 6, 3, 5, 7, 1]);
  assert.deepEqual(rebuilt.board, state.board);
  assert.equal(rebuilt.ply, state.ply);
  assert.equal(rebuilt.winner, state.winner);
  assert.equal(rebuilt.draw, true);
});

test("replayMoves agrees with applyMove across a winning game", () => {
  const cells = [0, 3, 1, 4, 2];
  const moves = cells.map((cellIndex, ply) => ({
    ply,
    playerId: ply % 2 === 0 ? ALICE : BOB,
    cellIndex,
  }));
  const rebuilt = replayMoves(moves);
  const state = playMoves(cells);
  assert.deepEqual(rebuilt.board, state.board);
  assert.equal(rebuilt.winner, "player1");
  assert.deepEqual(rebuilt.winningLine, [0, 1, 2]);
});

test("replayMoves is order- and duplicate-tolerant and ignores overflow", () => {
  const rebuilt = replayMoves([
    { ply: 1, playerId: BOB, cellIndex: 4 },
    { ply: 0, playerId: ALICE, cellIndex: 0 },
    // A duplicate cell is skipped rather than corrupting the board.
    { ply: 2, playerId: ALICE, cellIndex: 0 },
  ]);
  assert.equal(rebuilt.board[0], "X");
  assert.equal(rebuilt.board[4], "O");
  assert.equal(rebuilt.ply, 2);
});

test("replayMoves of a full draw is a draw", () => {
  const rebuilt = replayMoves(
    [0, 4, 8, 2, 6, 3, 5, 7, 1].map((cellIndex, ply) => ({ ply, playerId: "u", cellIndex })),
  );
  assert.equal(rebuilt.draw, true);
  assert.equal(rebuilt.winner, null);
});

test("an exhausting random-game fuzz keeps applyMove and replayMoves in lockstep", () => {
  // Deterministic LCG so a failure is reproducible without a seed dependency.
  let seed = 123456789;
  const next = (max) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };

  for (let game = 0; game < 400; game += 1) {
    const cells = [];
    const taken = new Set();
    let state = createInitialState();
    for (let ply = 0; ply < 9 && state.phase === "playing"; ply += 1) {
      let cell = next(CELL_COUNT);
      let guard = 0;
      while (taken.has(cell) && guard < 20) {
        cell = next(CELL_COUNT);
        guard += 1;
      }
      if (taken.has(cell)) break;
      taken.add(cell);
      const seat = seatAt(ply);
      const applied = applyMove({ state, seat, cellIndex: cell });
      state = applied.state;
      cells.push({ ply, playerId: seat === "player1" ? ALICE : BOB, cellIndex: cell });

      const rebuilt = replayMoves(cells);
      assert.deepEqual(rebuilt.board, state.board, `game ${game} ply ${ply}`);
      assert.equal(rebuilt.ply, state.ply);
      assert.equal(rebuilt.winner, state.winner, `game ${game} ply ${ply}`);
      if (state.winner) {
        assert.deepEqual(rebuilt.winningLine, state.winningLine);
        assert.equal(applied.matchCompleted, true);
        assert.equal(applied.draw, false);
      }
      if (state.phase === "finished" && !state.winner) {
        assert.equal(state.ply, CELL_COUNT);
        assert.equal(applied.draw, true);
      }
    }
  }
});
