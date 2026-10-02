/**
 * Mines Duel — flow (state-machine) tests for the SIMULTANEOUS,
 * INDEPENDENT-BOARD scoring model.
 *
 * The real store (`src/lib/mines-pvp/serverStore.js`) pulls in
 * `drizzle-orm` + `src/db/client`, so this file mirrors its rules in plain
 * functions and drives them through an in-memory match. The mirror is kept
 * close to production so drift is caught in review; the source-contract
 * checks in `mines-pvp-api-contract.test.mjs` pin the real store's text.
 *
 * Rules under test:
 *   • Both seats act at the same time, each on their own board.
 *   • Safe +5, correct flag = mine value, wrong flag −10, mine −25 (clamped).
 *   • Completion = every cell resolved → +100, board locked, opponent continues.
 *   • Match ends when both boards complete OR the 180s timer expires.
 *   • Winner from the deterministic tiebreak ladder (can be a draw).
 *   • Visibility never leaks the opponent's board, mine positions or values.
 *
 * Run:  node --import tsx --test tests/mines-pvp-flow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRID_CELLS,
  MATCH_STATUS,
  MATCH_TIMER_SECONDS,
  MINES_PER_MATCH,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  SCORE,
  WIN_REASON,
  applyScoreDelta,
  correctFlagsForSeat,
  decideScoredWinner,
  flagsForSeat,
  generateBoardPair,
  isBoardComplete,
  isMine,
  mineValueAt,
  nearestMineDistance,
  normalizeFlags,
  revealedForSeat,
} from "../src/lib/mines-pvp/constants.js";

import { normaliseMatchForViewer } from "../src/lib/mines-pvp/matchView.js";

// ═══════════════════════════════════════════════════════════════════════
// In-memory mirror of the row + transitions
// ═══════════════════════════════════════════════════════════════════════

function makeMatch({ id = 1, player1Id = "p1", player2Id = "p2" } = {}) {
  const { board1, board2 } = generateBoardPair(MINES_PER_MATCH);
  return {
    id,
    player1Id,
    player2Id,
    stakeAmount: 0,
    minesCount: MINES_PER_MATCH,
    status: MATCH_STATUS.WAITING,
    board: board1, // legacy mirror of seat 1
    p1Board: board1,
    p2Board: board2,
    p1Revealed: [],
    p2Revealed: [],
    p1Flags: [],
    p2Flags: [],
    p1CorrectFlags: [],
    p2CorrectFlags: [],
    p1Score: 0,
    p2Score: 0,
    p1SafeRevealed: 0,
    p2SafeRevealed: 0,
    p1MinesHit: 0,
    p2MinesHit: 0,
    p1CorrectFlagCount: 0,
    p2CorrectFlagCount: 0,
    p1IncorrectFlagCount: 0,
    p2IncorrectFlagCount: 0,
    p1Completed: false,
    p2Completed: false,
    p1CompletedAt: null,
    p2CompletedAt: null,
    p1Locked: false,
    p2Locked: false,
    matchDeadline: null,
    matchTimerSeconds: MATCH_TIMER_SECONDS,
    result: null,
    winnerId: null,
    winReason: null,
    startedAt: null,
    endedAt: null,
  };
}

const seat = (match, userId) =>
  match.player1Id === userId ? "player1" : "player2";
const boardOf = (match, s) => (s === "player2" ? match.p2Board : match.p1Board);
const k = (s, base) => (s === "player2" ? `p2${base}` : `p1${base}`);

function isLocked(match, s) {
  return Boolean(match[k(s, "Locked")]);
}

function completeIfDone(match, s, revealed, correctFlags, score) {
  if (isBoardComplete(boardOf(match, s), revealed, correctFlags)) {
    match[k(s, "Completed")] = true;
    match[k(s, "CompletedAt")] = new Date();
    match[k(s, "Locked")] = true;
    return applyScoreDelta(score, SCORE.BOARD_COMPLETE);
  }
  return score;
}

function applyReveal(match, userId, cellIndex) {
  if (!PICKABLE_STATES.has(match.status)) return { error: "not active", status: 400 };
  const s = seat(match, userId);
  if (isLocked(match, s)) return { error: "locked", status: 400 };
  if (match[k(s, "Revealed")].includes(cellIndex)) return { error: "dup", status: 409 };
  if (match[k(s, "CorrectFlags")].includes(cellIndex)) return { error: "confirmed", status: 409 };

  const board = boardOf(match, s);
  const mine = isMine(board, cellIndex);
  let score = match[k(s, "Score")];
  if (mine) {
    score = applyScoreDelta(score, SCORE.MINE_HIT);
    match[k(s, "MinesHit")] += 1;
  } else {
    score = applyScoreDelta(score, SCORE.SAFE_TILE);
    match[k(s, "SafeRevealed")] += 1;
  }
  match[k(s, "Revealed")] = normalizeFlags([...match[k(s, "Revealed")], cellIndex]);
  match[k(s, "Flags")] = match[k(s, "Flags")].filter((c) => c !== cellIndex);
  score = completeIfDone(match, s, match[k(s, "Revealed")], match[k(s, "CorrectFlags")], score);
  match[k(s, "Score")] = score;
  maybeResolve(match);
  return { match, revealedMine: mine };
}

function applyFlag(match, userId, cellIndex) {
  if (!PICKABLE_STATES.has(match.status)) return { error: "not active", status: 400 };
  const s = seat(match, userId);
  if (isLocked(match, s)) return { error: "locked", status: 400 };
  if (match[k(s, "Revealed")].includes(cellIndex)) return { error: "revealed", status: 409 };
  if (match[k(s, "Flags")].includes(cellIndex)) return { error: "dup", status: 409 };

  const board = boardOf(match, s);
  const mine = isMine(board, cellIndex);
  let score = match[k(s, "Score")];
  if (mine) {
    const value = mineValueAt(board, cellIndex);
    score = applyScoreDelta(score, value);
    match[k(s, "CorrectFlags")] = normalizeFlags([...match[k(s, "CorrectFlags")], cellIndex]);
    match[k(s, "CorrectFlagCount")] += 1;
  } else {
    score = applyScoreDelta(score, SCORE.WRONG_FLAG);
    match[k(s, "IncorrectFlagCount")] += 1;
  }
  match[k(s, "Flags")] = normalizeFlags([...match[k(s, "Flags")], cellIndex]);
  score = completeIfDone(match, s, match[k(s, "Revealed")], match[k(s, "CorrectFlags")], score);
  match[k(s, "Score")] = score;
  maybeResolve(match);
  return { match, flagCorrect: mine, mineValue: mine ? mineValueAt(board, cellIndex) : null };
}

function statsOf(match, s) {
  return {
    score: match[k(s, "Score")],
    minesHit: match[k(s, "MinesHit")],
    incorrectFlags: match[k(s, "IncorrectFlagCount")],
    correctFlags: match[k(s, "CorrectFlagCount")],
    completedAt: match[k(s, "CompletedAt")],
    completed: match[k(s, "Completed")],
  };
}

function maybeResolve(match) {
  if (match.status !== MATCH_STATUS.ACTIVE) return match;
  const both = match.p1Completed && match.p2Completed;
  const expired =
    match.matchDeadline && new Date(match.matchDeadline).getTime() <= Date.now();
  if (!both && !expired) return match;
  const winner = decideScoredWinner(statsOf(match, "player1"), statsOf(match, "player2"));
  match.status = MATCH_STATUS.FINISHED;
  match.result = winner;
  match.winnerId =
    winner === RESULT.PLAYER1
      ? match.player1Id
      : winner === RESULT.PLAYER2
        ? match.player2Id
        : null;
  match.winReason = WIN_REASON.SCORE;
  match.endedAt = new Date();
  match.matchDeadline = null;
  return match;
}

function startMatch(match) {
  match.status = MATCH_STATUS.ACTIVE;
  match.matchDeadline = new Date(Date.now() + MATCH_TIMER_SECONDS * 1000);
  return match;
}

// A deterministic, easy-to-read board: mines 0-9 with values.
function fixedBoard(values) {
  return { size: 10, mines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], values };
}
const SAFE_A = 55;
const SAFE_B = 56;

// ═══════════════════════════════════════════════════════════════════════
// Setup / simultaneous play
// ═══════════════════════════════════════════════════════════════════════

test("the two seats get different boards with the same distribution", () => {
  const match = makeMatch();
  assert.equal(match.p1Board.mines.length, MINES_PER_MATCH);
  assert.equal(match.p2Board.mines.length, MINES_PER_MATCH);
  const same =
    match.p1Board.mines.join(",") === match.p2Board.mines.join(",");
  assert.equal(same, false);
});

test("both players act at the same time (no turns)", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p1", SAFE_B); // p1 can act again immediately
  applyReveal(match, "p2", 12);
  applyReveal(match, "p2", 13);
  assert.equal(match.p1SafeRevealed, 2);
  assert.equal(match.p2SafeRevealed, 2);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

test("actions before the match is active are refused", () => {
  const match = makeMatch();
  assert.equal(applyReveal(match, "p1", SAFE_A).status, 400);
  assert.equal(applyFlag(match, "p1", 0).status, 400);
});

// ═══════════════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════════════

test("a safe reveal scores +5", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  assert.equal(match.p1Score, SCORE.SAFE_TILE);
});

test("revealing a mine costs 25 (clamped) and does NOT end the match", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A); // +5
  const r = applyReveal(match, "p1", 0); // mine
  assert.equal(r.revealedMine, true);
  assert.equal(match.p1Score, 0); // 5 - 25 clamped to 0
  assert.equal(match.p1MinesHit, 1);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  // The player can keep playing.
  applyReveal(match, "p1", SAFE_B);
  assert.equal(match.p1Score, SCORE.SAFE_TILE);
});

test("a correct flag awards the mine's own value", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({ "0": 30 });
  match.p2Board = fixedBoard({ "0": 30 });
  startMatch(match);
  const r = applyFlag(match, "p1", 0);
  assert.equal(r.flagCorrect, true);
  assert.equal(r.mineValue, 30);
  assert.equal(match.p1Score, 30);
  assert.deepEqual(correctFlagsForSeat(match, "player1"), [0]);
});

test("a correct flag awards the mine's own tier (10 / 20 / 30 / 50)", () => {
  for (const value of [10, 20, 30, 50]) {
    const match = makeMatch();
    match.p1Board = fixedBoard({ "0": value });
    match.p2Board = fixedBoard({});
    startMatch(match);
    const r = applyFlag(match, "p1", 0);
    assert.equal(r.flagCorrect, true);
    assert.equal(r.mineValue, value);
    assert.equal(match.p1Score, value);
  }
});

test("a wrong flag costs 10 and is kept until the tile is revealed", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A); // +5
  const r = applyFlag(match, "p1", SAFE_B); // wrong
  assert.equal(r.flagCorrect, false);
  assert.equal(match.p1Score, 0); // 5 - 10 clamped
  assert.equal(match.p1IncorrectFlagCount, 1);
  assert.deepEqual(flagsForSeat(match, "player1"), [SAFE_B]);
  // Revealing the wrong-flagged tile resolves it (flag cleared).
  applyReveal(match, "p1", SAFE_B);
  assert.deepEqual(flagsForSeat(match, "player1"), []);
});

test("you cannot reveal a mine you already confirmed by flagging", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({ "0": 10 });
  match.p2Board = fixedBoard({ "0": 10 });
  startMatch(match);
  applyFlag(match, "p1", 0);
  assert.equal(applyReveal(match, "p1", 0).status, 409);
});

test("a safe tile cannot be revealed twice; a duplicate flag is rejected", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  assert.equal(applyReveal(match, "p1", SAFE_A).status, 409);
  applyFlag(match, "p1", SAFE_B);
  assert.equal(applyFlag(match, "p1", SAFE_B).status, 409);
});

// ═══════════════════════════════════════════════════════════════════════
// Completion + lock
// ═══════════════════════════════════════════════════════════════════════

test("clearing a board awards +100, locks it, and does not end the match", () => {
  const match = makeMatch();
  const board = fixedBoard({});
  match.p1Board = board;
  match.p2Board = board;
  startMatch(match);
  const safeCells = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  // Reveal every safe tile on p1's board.
  for (const c of safeCells) applyReveal(match, "p1", c);
  // Flag every mine correctly.
  for (const m of board.mines) applyFlag(match, "p1", m);

  assert.equal(match.p1Completed, true);
  assert.equal(match.p1Locked, true);
  // 90 safe × 5 + 10 mines × fallback value 10 + completion 100.
  assert.equal(
    match.p1Score,
    safeCells.length * SCORE.SAFE_TILE + board.mines.length * 10 + SCORE.BOARD_COMPLETE,
  );
  // p1 is locked out.
  assert.equal(applyReveal(match, "p1", 99).status, 400);
  assert.equal(applyFlag(match, "p1", 0).status, 400);
  // The match continues while p2 plays.
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  applyReveal(match, "p2", 55);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

test("board completion awards +100 exactly once and cannot re-trigger", () => {
  const match = makeMatch();
  const board = fixedBoard({});
  match.p1Board = board;
  match.p2Board = board;
  startMatch(match);
  const safe = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  for (const c of safe) applyReveal(match, "p1", c);
  for (const m of board.mines) applyFlag(match, "p1", m);
  // 90 safe × 5 + 10 mines × 10 + exactly one +100.
  const expected = safe.length * SCORE.SAFE_TILE + board.mines.length * 10 + 100;
  assert.equal(match.p1Score, expected);
  // Any further completion path is refused, and the score stays put.
  assert.equal(applyReveal(match, "p1", 99).status, 400);
  assert.equal(applyFlag(match, "p1", 0).status, 400);
  assert.equal(match.p1Score, expected);
  // Exactly one completion timestamp.
  assert.ok(match.p1CompletedAt instanceof Date);
});

test("example: higher score wins even when the opponent completed first", () => {
  const match = makeMatch();
  const board = fixedBoard({});
  match.p1Board = board;
  match.p2Board = board;
  startMatch(match);
  const safe = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  // A clears its board early (locks, +100) — NOT an automatic victory.
  for (const c of safe) applyReveal(match, "p1", c);
  for (const m of board.mines) applyFlag(match, "p1", m);
  assert.equal(match.p1Completed, true);
  assert.equal(match.p1Locked, true);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);

  // B keeps playing and reaches a higher score by the clock.
  match.p1Score = 525;
  match.p2Score = 550;
  match.matchDeadline = new Date(Date.now() - 1000);
  maybeResolve(match);

  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER2);
  assert.equal(match.winnerId, "p2");
});

test("example: a clearing player keeps the win on the higher score", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  match.p1Score = 625;
  match.p1Completed = true;
  match.p1Locked = true;
  match.p1CompletedAt = new Date();
  match.p2Score = 580;
  match.matchDeadline = new Date(Date.now() - 1000);
  maybeResolve(match);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER1);
  assert.equal(match.winnerId, "p1");
});

test("both boards complete → match ends immediately on score", () => {
  const match = makeMatch();
  const board = fixedBoard({});
  match.p1Board = board;
  match.p2Board = board;
  startMatch(match);
  const safe = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  for (const c of safe) applyReveal(match, "p1", c);
  for (const m of board.mines) applyFlag(match, "p1", m);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  for (const c of safe) applyReveal(match, "p2", c);
  for (const m of board.mines) applyFlag(match, "p2", m);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.winReason, WIN_REASON.SCORE);
});

// ═══════════════════════════════════════════════════════════════════════
// Timer + tiebreak
// ═══════════════════════════════════════════════════════════════════════

test("the timer expiring ends the match and settles by score", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p1", SAFE_B); // p1 ahead 10
  applyReveal(match, "p2", 12); // p2 5
  match.matchDeadline = new Date(Date.now() - 1000);
  maybeResolve(match);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.winnerId, "p1");
  assert.equal(match.result, RESULT.PLAYER1);
});

test("a fully tied match resolves to a deterministic draw", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p2", SAFE_A);
  match.matchDeadline = new Date(Date.now() - 1000);
  maybeResolve(match);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.DRAW);
  assert.equal(match.winnerId, null);
});

// ═══════════════════════════════════════════════════════════════════════
// Visibility
// ═══════════════════════════════════════════════════════════════════════

test("an active match never leaks either board or mine values", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyFlag(match, "p2", 0); // p2 correctly flags one of its own mines
  applyReveal(match, "p1", 0); // p1 detonates one of its own mines

  const asP1 = normaliseMatchForViewer(match, "p1");
  const asP2 = normaliseMatchForViewer(match, "p2");

  // No board (own or opponent) while live.
  assert.equal(asP1.board, null);
  assert.equal(asP1.opponentBoard, null);
  assert.equal(asP1.boards, null);
  assert.equal(asP2.board, null);
  assert.equal(asP2.opponentBoard, null);

  // Own resolved cells only, with a clue for safe cells.
  const p1Cells = asP1.myRevealed.map((r) => r.cell).sort((a, b) => a - b);
  assert.deepEqual(p1Cells, [0, SAFE_A].sort((a, b) => a - b));
  const safeEntry = asP1.myRevealed.find((r) => r.cell === SAFE_A);
  assert.equal(safeEntry.mine, false);
  assert.equal(typeof safeEntry.hint, "number");
  const mineEntry = asP1.myRevealed.find((r) => r.cell === 0);
  assert.equal(mineEntry.mine, true);

  // The opponent's mine positions/values are never present.
  assert.equal(JSON.stringify(asP2).includes('"p1Board"'), false);
  assert.equal(JSON.stringify(asP1).includes('"p2Board"'), false);
  // Only the opponent's PUBLIC progress is exposed.
  assert.equal(typeof asP1.opponentScore, "number");
  assert.equal(typeof asP1.opponentSafeRevealed, "number");
  assert.equal(asP1.opponentBoard, null);
});

test("a finished match reveals both boards for replay", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  match.matchDeadline = new Date(Date.now() - 1000);
  maybeResolve(match);

  const view = normaliseMatchForViewer(match, "p1");
  assert.ok(view.board);
  assert.ok(view.opponentBoard);
  assert.ok(view.boards.p1 && view.boards.p2);
  assert.equal(view.winReason, WIN_REASON.SCORE);
});

test("the viewer payload exposes the public per-seat scores to both seats", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({});
  match.p2Board = fixedBoard({});
  startMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p2", 12);
  applyReveal(match, "p2", 13);
  const asP1 = normaliseMatchForViewer(match, "p1");
  assert.equal(asP1.myScore, 5);
  assert.equal(asP1.opponentScore, 10);
  assert.equal(asP1.matchTimerSeconds, MATCH_TIMER_SECONDS);
});

test("READY_WINDOW_MS is the pre-match banner window", () => {
  assert.equal(READY_WINDOW_MS, 3000);
});
