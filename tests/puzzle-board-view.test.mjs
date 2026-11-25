// tests/puzzle-board-view.test.mjs
//
// THE SHARED BOARD'S PURE LOGIC.
//
// The board is a renderer of authoritative session views. These tests pin the
// parts that decide what the player sees: the shared clock, the objective
// meter, the post-move verdict, the settled outcome, and — most importantly —
// which of two server snapshots is newer when a poll races a move.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PUZZLE_BOARD_POLL_MS,
  formatPuzzleClock,
  puzzleOutcomeKey,
  puzzleProgressPercent,
  puzzleRemainingMs,
  puzzleVerdictKey,
  reconcilePuzzleView,
} from "../src/lib/solitaire-puzzle/boardView.ts";

function board(ply) {
  return {
    tableau: [],
    stockCount: 10,
    nextStockCard: null,
    waste: [],
    foundations: { spades: [], hearts: [], diamonds: [], clubs: [] },
    ply,
    resetCount: 0,
    progress: { foundationCards: 0, revealedTableau: 7, progressPercent: 0 },
    completed: false,
    canRedeal: false,
  };
}

function view(overrides = {}) {
  const base = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    mode: "ranked",
    status: "playing",
    seat: "player1",
    puzzleNumber: 1,
    puzzleCount: 5,
    puzzle: {
      slot: 0,
      level: "Level 1",
      category: "column",
      objectiveText: "Free a card.",
      concept: "",
      objective: {},
      constraints: {},
      par: 10,
    },
    board: board(3),
    ply: 3,
    progress: { current: 1, target: 3, measurable: true },
    solvedCount: 0,
    opponentSolvedCount: 0,
    startedAtMs: 1_000,
    deadlineAtMs: 361_000,
    serverNowMs: 1_000,
    result: null,
    ...overrides,
  };
  // Keep the seat cursor aligned with the board unless a test overrides it.
  return {
    ...base,
    ply: overrides.ply ?? overrides.board?.ply ?? base.ply,
  };
}

// ── Clock ─────────────────────────────────────────────────────────────────

test("the shared clock formats and clamps", () => {
  assert.equal(formatPuzzleClock(315_000), "5:15");
  assert.equal(formatPuzzleClock(59_000), "0:59");
  assert.equal(formatPuzzleClock(0), "0:00");
  assert.equal(formatPuzzleClock(-4_000), "0:00");
  assert.equal(PUZZLE_BOARD_POLL_MS, 2_000);
});

test("remaining time uses the server offset, not the raw device clock", () => {
  // The server runs 5s ahead of this device.
  assert.equal(puzzleRemainingMs(100_000, 5_000, 10_000), 85_000);
  assert.equal(puzzleRemainingMs(null, 5_000, 10_000), null);
});

// ── Objective + verdicts ──────────────────────────────────────────────────

test("objective progress is clamped to 0–100", () => {
  assert.equal(puzzleProgressPercent({ current: 1, target: 3 }), 33);
  assert.equal(puzzleProgressPercent({ current: 3, target: 3 }), 100);
  assert.equal(puzzleProgressPercent({ current: 9, target: 3 }), 100);
  assert.equal(puzzleProgressPercent({ current: -2, target: 3 }), 0);
  assert.equal(puzzleProgressPercent({ current: 1, target: 0 }), 0);
  assert.equal(puzzleProgressPercent(null), 0);
});

test("every engine verdict has a display key", () => {
  assert.equal(puzzleVerdictKey("illegal"), "illegal");
  assert.equal(puzzleVerdictKey("no-progress"), "noProgress");
  assert.equal(puzzleVerdictKey("progress"), "madeProgress");
  assert.equal(puzzleVerdictKey("complete"), "complete");
  assert.equal(puzzleVerdictKey(null), null);
});

// ── Settled outcome ───────────────────────────────────────────────────────

test("the outcome is derived from the server result and the server seat", () => {
  const result = (winnerSeat, resolutionReason = "finish") => ({
    winnerSeat,
    result: winnerSeat ?? "draw",
    resolutionReason,
    opponentId: "opponent",
    player1: { solved: 2, lastSolveAtMs: null },
    player2: { solved: 1, lastSolveAtMs: null },
    reward: null,
  });

  assert.equal(
    puzzleOutcomeKey(view({ result: result("player1") })),
    "win",
  );
  assert.equal(
    puzzleOutcomeKey(view({ result: result("player2") })),
    "loss",
  );
  assert.equal(puzzleOutcomeKey(view({ result: result(null) })), "draw");
  assert.equal(
    puzzleOutcomeKey(view({ seat: "player2", result: result("player2") })),
    "win",
  );
  assert.equal(
    puzzleOutcomeKey(view({ result: result("player2", "forfeit") })),
    "forfeitLoss",
  );
  assert.equal(
    puzzleOutcomeKey(view({ seat: "player2", result: result("player2", "forfeit") })),
    "forfeitWin",
  );
  assert.equal(puzzleOutcomeKey(view({ result: null })), null);
  assert.equal(puzzleOutcomeKey(null), null);
});

// ── Reconciliation of racing reads ────────────────────────────────────────

test("a first read is accepted as-is", () => {
  const incoming = view();
  assert.equal(reconcilePuzzleView(null, incoming), incoming);
  assert.equal(reconcilePuzzleView(incoming, null), incoming);
});

test("the seat cursor, not the dealt position, orders snapshots", () => {
  // The fixture's board ply may start high; only the viewer's session cursor
  // proves which snapshot is newer.
  const current = view({ ply: 6, board: board(194) });
  const stale = view({ ply: 5, board: board(195) });
  assert.equal(reconcilePuzzleView(current, stale), current);
});

test("a stale poll cannot undo an accepted move", () => {
  const current = view({ board: board(7) });
  const stale = view({ board: board(6), serverNowMs: 900 });
  assert.equal(reconcilePuzzleView(current, stale), current);
});

test("a newer move from the same puzzle is applied", () => {
  const current = view({ board: board(7) });
  const incoming = view({ board: board(8), serverNowMs: 2_000 });
  assert.equal(reconcilePuzzleView(current, incoming), incoming);
});

test("advancing to the next puzzle is never treated as a rollback", () => {
  // The next position may restart the board ply; the puzzle number moved on.
  const current = view({ puzzleNumber: 2, board: board(14) });
  const nextPuzzle = view({ puzzleNumber: 3, board: board(0) });
  assert.equal(reconcilePuzzleView(current, nextPuzzle), nextPuzzle);

  // A late read of the previous puzzle is still refused once we advanced.
  const stalePuzzle = view({ puzzleNumber: 2, board: board(15) });
  assert.equal(reconcilePuzzleView(nextPuzzle, stalePuzzle), nextPuzzle);
});

test("lifecycle only moves forward", () => {
  const waiting = view({ status: "waiting", board: null });
  const playing = view({ status: "playing" });
  assert.equal(reconcilePuzzleView(waiting, playing), playing);
  assert.equal(reconcilePuzzleView(playing, waiting), playing);

  const finished = view({
    status: "finished",
    result: {
      winnerSeat: "player1",
      result: "player1",
      resolutionReason: "deadline",
      opponentId: "opponent",
      player1: { solved: 2, lastSolveAtMs: null },
      player2: { solved: 1, lastSolveAtMs: null },
      reward: { ratingDelta: 12, trophiesDelta: 1 },
    },
  });
  // A live poll resolved after settlement cannot resurrect the match.
  assert.equal(reconcilePuzzleView(finished, playing), finished);
  // A later settled read (for example with the reward filled in) may refresh it.
  const refreshed = view({ ...finished, serverNowMs: 9_000 });
  assert.equal(reconcilePuzzleView(finished, refreshed), refreshed);
});
