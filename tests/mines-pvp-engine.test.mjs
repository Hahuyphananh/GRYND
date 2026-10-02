/**
 * Mines Duel — engine (pure constants/helpers) tests.
 *
 * The server rules live in `src/lib/mines-pvp/constants.js`. This file drives
 * the pure functions directly (board generation, scoring arithmetic, board
 * completion, the tiebreak ladder, the AI policy) with no DB.
 *
 * Rules under test (simultaneous, independent-board scoring):
 *   • 10×10 board, a FIXED 10 mines, four value tiers summing to 10.
 *   • Both seats get DIFFERENT mine positions, same distribution.
 *   • Safe +5, correct flag = mine value, wrong flag −10, mine −25, complete +100.
 *   • Scores clamp at 0.
 *   • Completion = every cell resolved (revealed ∪ correctly-flagged).
 *   • Deterministic tiebreak ladder, bottoming out in a draw.
 *
 * Run:  node --import tsx --test tests/mines-pvp-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_KIND,
  AI_PICK_DELAY_MS,
  GRID_CELLS,
  GRID_SIZE,
  MATCH_STATUS,
  MATCH_TIMER_MS,
  MATCH_TIMER_SECONDS,
  MAX_MINES,
  MIN_MINES,
  MINES_PER_MATCH,
  MINE_VALUES,
  MINE_VALUE_DISTRIBUTION,
  RESULT,
  SCORE,
  TERMINAL_STATES,
  WIN_REASON,
  aiCellRisk,
  applyScoreDelta,
  cellIndexToRowCol,
  chebyshevDistance,
  chooseAiActionForSeat,
  correctFlagsForSeat,
  decideScoredWinner,
  deduceKnownMines,
  flagsForSeat,
  generateBoard,
  generateBoardPair,
  isBoardComplete,
  isMine,
  mineValueAt,
  nearestMineDistance,
  normalizeFlags,
  resolveScoredMatch,
  revealedForSeat,
  rowColToCellIndex,
  samePositions,
  seatStats,
} from "../src/lib/mines-pvp/constants.js";

// ── Geometry + distribution ───────────────────────────────────────────

test("board is the existing 10×10 field", () => {
  assert.equal(GRID_SIZE, 10);
  assert.equal(GRID_CELLS, 100);
  assert.equal(MIN_MINES, 1);
  assert.equal(MAX_MINES, 99);
});

test("the mine-value distribution is internally consistent (10 mines)", () => {
  const total = MINE_VALUE_DISTRIBUTION.reduce((s, t) => s + t.count, 0);
  assert.equal(total, MINES_PER_MATCH);
  assert.equal(total, 10);
  // Four tiers preserved, rescaled from the inconsistent 8/5/3/1 config.
  assert.deepEqual(
    MINE_VALUE_DISTRIBUTION.map((t) => [t.value, t.count]),
    [
      [10, 5],
      [20, 3],
      [30, 1],
      [50, 1],
    ],
  );
  assert.equal(MINE_VALUES.length, 10);
  assert.equal(MINE_VALUES.reduce((s, v) => s + v, 0), 190);
});

test("scoring constants match the brief", () => {
  assert.equal(SCORE.SAFE_TILE, 5);
  assert.equal(SCORE.WRONG_FLAG, -10);
  assert.equal(SCORE.MINE_HIT, -25);
  assert.equal(SCORE.BOARD_COMPLETE, 100);
});

test("the match timer is one 180-second server clock", () => {
  assert.equal(MATCH_TIMER_SECONDS, 180);
  assert.equal(MATCH_TIMER_MS, 180000);
});

test("status vocabulary includes the simultaneous 'active' state", () => {
  assert.equal(MATCH_STATUS.ACTIVE, "active");
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.FINISHED), true);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.CANCELLED), true);
  assert.equal(TERMINAL_STATES.has(MATCH_STATUS.ACTIVE), false);
});

// ── Board generation ──────────────────────────────────────────────────

test("generateBoard: 10 unique sorted mines with a value each", () => {
  const board = generateBoard(MINES_PER_MATCH);
  assert.equal(board.size, 10);
  assert.equal(board.mines.length, MINES_PER_MATCH);
  assert.deepEqual(board.mines, [...board.mines].sort((a, b) => a - b));
  assert.equal(new Set(board.mines).size, MINES_PER_MATCH);
  for (const m of board.mines) {
    assert.ok(m >= 0 && m < GRID_CELLS);
    assert.ok(MINE_VALUES.includes(mineValueAt(board, m)));
  }
  // The four value tiers are present exactly as the distribution dictates.
  const values = board.mines.map((m) => mineValueAt(board, m));
  assert.equal(values.filter((v) => v === 10).length, 5);
  assert.equal(values.filter((v) => v === 20).length, 3);
  assert.equal(values.filter((v) => v === 30).length, 1);
  assert.equal(values.filter((v) => v === 50).length, 1);
});

test("generateBoard rejects a non-fixed count", () => {
  for (const n of [0, 3, 9, 11, 24]) {
    assert.throws(() => generateBoard(n), RangeError);
  }
});

test("generateBoardPair: same shape, DIFFERENT mine positions", () => {
  for (let i = 0; i < 50; i += 1) {
    const { board1, board2 } = generateBoardPair(MINES_PER_MATCH);
    assert.equal(board1.mines.length, board2.mines.length);
    assert.equal(samePositions(board1, board2), false);
    assert.equal(isMine(board1, board2.mines[0]) && samePositions(board1, board2), false);
  }
});

test("isMine / mineValueAt are defensive", () => {
  const board = generateBoard(MINES_PER_MATCH);
  assert.equal(isMine(board, null), false);
  assert.equal(isMine(board, "5"), false); // string rejected, not coerced
  assert.equal(isMine(board, -1), false);
  assert.equal(isMine(board, GRID_CELLS), false);
  const safe = Array.from({ length: GRID_CELLS }, (_, i) => i).find(
    (i) => !board.mines.includes(i),
  );
  assert.equal(mineValueAt(board, safe), null);
});

// ── Score arithmetic ──────────────────────────────────────────────────

test("applyScoreDelta clamps the floor at 0", () => {
  assert.equal(applyScoreDelta(0, -25), 0);
  assert.equal(applyScoreDelta(10, -10), 0);
  assert.equal(applyScoreDelta(10, -11), 0);
  assert.equal(applyScoreDelta(3, 5), 8);
  assert.equal(applyScoreDelta(20, 50), 70);
  // Non-finite input is a zero delta, never NaN.
  assert.equal(applyScoreDelta(7, Number.NaN), 7);
  assert.equal(applyScoreDelta(Number.NaN, 5), 5);
});

// ── Completion ────────────────────────────────────────────────────────

test("isBoardComplete: revealed ∪ correct flags must cover the board", () => {
  const board = { size: 10, mines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], values: {} };
  const allSafe = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  // Every safe tile revealed, every mine correctly flagged → complete.
  assert.equal(isBoardComplete(board, allSafe, board.mines), true);
  // A mine left unresolved → incomplete.
  assert.equal(isBoardComplete(board, allSafe, board.mines.slice(0, 9)), false);
  // A mine detonated (revealed) instead of flagged still counts.
  assert.equal(
    isBoardComplete(board, [...allSafe, 0], board.mines.slice(1)),
    true,
  );
  // A safe tile left unrevealed → incomplete.
  assert.equal(isBoardComplete(board, allSafe.slice(0, -1), board.mines), false);
});

// ── Flag / reveal set helpers ─────────────────────────────────────────

test("normalizeFlags is unique, sorted and tamper-safe", () => {
  assert.deepEqual(normalizeFlags([5, 5, 1, "3"]), [1, 3, 5]);
  assert.deepEqual(normalizeFlags([null, undefined, {}, [], -1, 100, 7]), [7]);
  assert.deepEqual(normalizeFlags("nope"), []);
});

test("per-seat reads canonicalise the row arrays", () => {
  const match = {
    p1Flags: [3, 1, 1],
    p2Flags: null,
    p1Revealed: [50],
    p2Revealed: [7, "8"],
    p1CorrectFlags: [1],
    p2CorrectFlags: [],
  };
  assert.deepEqual(flagsForSeat(match, "player1"), [1, 3]);
  assert.deepEqual(flagsForSeat(match, "player2"), []);
  assert.deepEqual(revealedForSeat(match, "player2"), [7, 8]);
  assert.deepEqual(correctFlagsForSeat(match, "player1"), [1]);
});

// ── Tiebreak ladder ───────────────────────────────────────────────────

test("decideScoredWinner: highest score", () => {
  assert.equal(
    decideScoredWinner({ score: 120 }, { score: 80 }),
    RESULT.PLAYER1,
  );
  assert.equal(
    decideScoredWinner({ score: 10 }, { score: 80 }),
    RESULT.PLAYER2,
  );
});

test("decideScoredWinner: ladder order", () => {
  // Equal score → fewer mines hit.
  assert.equal(
    decideScoredWinner(
      { score: 50, minesHit: 1 },
      { score: 50, minesHit: 2 },
    ),
    RESULT.PLAYER1,
  );
  // Equal score + hits → fewer incorrect flags.
  assert.equal(
    decideScoredWinner(
      { score: 50, minesHit: 1, incorrectFlags: 0 },
      { score: 50, minesHit: 1, incorrectFlags: 2 },
    ),
    RESULT.PLAYER1,
  );
  // Equal hits + wrong flags → more correct flags.
  assert.equal(
    decideScoredWinner(
      { score: 50, minesHit: 1, incorrectFlags: 1, correctFlags: 5 },
      { score: 50, minesHit: 1, incorrectFlags: 1, correctFlags: 3 },
    ),
    RESULT.PLAYER1,
  );
  // Equal otherwise → earlier completion.
  assert.equal(
    decideScoredWinner(
      {
        score: 50,
        minesHit: 1,
        incorrectFlags: 1,
        correctFlags: 5,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        score: 50,
        minesHit: 1,
        incorrectFlags: 1,
        correctFlags: 5,
        completedAt: "2026-01-01T00:01:00.000Z",
      },
    ),
    RESULT.PLAYER1,
  );
  // A completed seat beats an unfinished one on the timestamp rung.
  assert.equal(
    decideScoredWinner(
      {
        score: 50,
        minesHit: 1,
        incorrectFlags: 1,
        correctFlags: 5,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
      { score: 50, minesHit: 1, incorrectFlags: 1, correctFlags: 5 },
    ),
    RESULT.PLAYER1,
  );
  // Perfectly tied → a deterministic draw (no randomness).
  assert.equal(
    decideScoredWinner(
      { score: 50, minesHit: 1, incorrectFlags: 1, correctFlags: 5 },
      { score: 50, minesHit: 1, incorrectFlags: 1, correctFlags: 5 },
    ),
    RESULT.DRAW,
  );
});

test("seatStats + resolveScoredMatch read the row", () => {
  const match = {
    p1Score: 100,
    p2Score: 100,
    p1MinesHit: 0,
    p2MinesHit: 1,
    p1IncorrectFlagCount: 0,
    p2IncorrectFlagCount: 0,
    p1CorrectFlagCount: 2,
    p2CorrectFlagCount: 2,
    p1CompletedAt: null,
    p2CompletedAt: null,
    p1Completed: false,
    p2Completed: false,
  };
  assert.equal(seatStats(match, "player1").score, 100);
  assert.equal(resolveScoredMatch(match), RESULT.PLAYER1);
});

// ── Mine values ───────────────────────────────────────────────────────

test("mineValueAt returns each served tier (10 / 20 / 30 / 50)", () => {
  const board = {
    size: 10,
    mines: [0, 1, 2, 3],
    values: { "0": 10, "1": 20, "2": 30, "3": 50 },
  };
  assert.equal(mineValueAt(board, 0), 10);
  assert.equal(mineValueAt(board, 1), 20);
  assert.equal(mineValueAt(board, 2), 30);
  assert.equal(mineValueAt(board, 3), 50);
  // A malformed value falls back to the lowest tier, never NaN.
  assert.equal(mineValueAt({ size: 10, mines: [4], values: {} }, 4), 10);
});

// ── The brief's worked examples ───────────────────────────────────────

test("example: a higher score beats an EARLIER board completion", () => {
  // Player A cleared at 2:18 for 525; Player B never cleared and reached 550.
  const match = {
    p1Score: 525,
    p2Score: 550,
    p1MinesHit: 0,
    p2MinesHit: 0,
    p1IncorrectFlagCount: 0,
    p2IncorrectFlagCount: 0,
    p1CorrectFlagCount: 10,
    p2CorrectFlagCount: 4,
    p1Completed: true,
    p1CompletedAt: new Date("2026-01-01T00:02:18.000Z"),
    p2Completed: false,
    p2CompletedAt: null,
  };
  assert.equal(resolveScoredMatch(match), RESULT.PLAYER2);
});

test("example: a clearing player with the higher score still wins", () => {
  // Player A cleared for 625; Player B never cleared and finished on 580.
  const match = {
    p1Score: 625,
    p2Score: 580,
    p1MinesHit: 1,
    p2MinesHit: 0,
    p1IncorrectFlagCount: 1,
    p2IncorrectFlagCount: 0,
    p1CorrectFlagCount: 10,
    p2CorrectFlagCount: 5,
    p1Completed: true,
    p1CompletedAt: new Date("2026-01-01T00:02:40.000Z"),
    p2Completed: false,
    p2CompletedAt: null,
  };
  assert.equal(resolveScoredMatch(match), RESULT.PLAYER1);
});

// ── Clues ─────────────────────────────────────────────────────────────

test("nearestMineDistance + chebyshevDistance", () => {
  const board = { size: 10, mines: [0], values: {} };
  assert.equal(nearestMineDistance(board, 0), 0); // a mine
  assert.equal(nearestMineDistance(board, 1), 1);
  assert.equal(nearestMineDistance(board, 11), 1);
  assert.equal(nearestMineDistance(board, 22), 2);
  assert.equal(nearestMineDistance(board, -1), null);
  assert.equal(chebyshevDistance(0, 11), 1);
  assert.equal(chebyshevDistance(0, 22), 2);
  assert.equal(chebyshevDistance(0, null), null);
});

test("cell ↔ row/col round trip", () => {
  assert.deepEqual(cellIndexToRowCol(23), { row: 2, col: 3 });
  assert.equal(rowColToCellIndex(2, 3), 23);
  assert.equal(rowColToCellIndex(-1, 0), null);
});

// ── AI ────────────────────────────────────────────────────────────────

test("aiCellRisk: inside a clue's safety radius is risk 0", () => {
  const revealed = [{ cell: 0, hint: 2 }];
  assert.equal(aiCellRisk(1, revealed), 0); // distance 1 < 2 → provably safe
  assert.ok(aiCellRisk(2, revealed) > 0); // on the frontier
});

test("deduceKnownMines: the sole remaining ring cell is a mine", () => {
  // hint 1 at cell 0 → a mine sits on one of its neighbours. Rule out all
  // but cell 1 (already flagged/accounted for) → cell 11 must be the mine.
  const revealed = [{ cell: 0, hint: 1 }];
  const unknown = [11];
  assert.deepEqual(deduceKnownMines(revealed, unknown, [1, 10]), [11]);
});

test("chooseAiActionForSeat: hard flags a proven mine, easy never flags", () => {
  const revealed = [{ cell: 0, hint: 1 }];
  const resolved = [0, 1, 10];
  const hard = chooseAiActionForSeat({
    revealed,
    resolved,
    flags: [],
    difficulty: "hard",
    random: () => 0,
  });
  assert.equal(hard.kind, ACTION_KIND.FLAG);
  assert.equal(hard.cellIndex, 11);

  const easy = chooseAiActionForSeat({
    revealed,
    resolved,
    flags: [],
    difficulty: "easy",
    random: () => 0,
  });
  assert.equal(easy.kind, ACTION_KIND.REVEAL);
});

test("chooseAiActionForSeat returns null when the board is done", () => {
  const resolved = Array.from({ length: GRID_CELLS }, (_, i) => i);
  assert.equal(
    chooseAiActionForSeat({ revealed: [], resolved, flags: [], difficulty: "hard" }),
    null,
  );
});

test("legacy AI pacing constant stays exported", () => {
  assert.equal(typeof AI_PICK_DELAY_MS, "number");
});

test("legacy win-reason vocabulary is preserved for old rows", () => {
  assert.equal(WIN_REASON.SCORE, "score");
  assert.equal(WIN_REASON.RESIGN, "resign");
  assert.equal(WIN_REASON.MINE_HIT, "mine_hit");
});
