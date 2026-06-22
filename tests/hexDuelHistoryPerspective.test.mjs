/**
 * Hex Duel perspective helper — unit tests.
 *
 * Validates that normalizeHexDuelForViewer correctly attributes:
 *   - viewer as player1 (host): moves/territory swap correctly
 *   - viewer as player2 (joiner): moves/territory swap correctly
 *   - win/loss derived from "winner" × viewerSide
 *   - falls back gracefully when result field is missing
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHexDuelForViewer,
  getViewerSide,
  didViewerWin,
} from "../src/lib/hexDuelHistoryPerspective.ts";

const P1 = "user_p1";
const P2 = "user_p2";

function makeRow(over = {}) {
  return {
    id: 1,
    player1Id: P1,
    player2Id: P2,
    wagerAmount: "10.00",
    winner: "player1",
    result: "win",
    payout: "19.00",
    isAiGame: false,
    aiDifficulty: null,
    player1Moves: 6,
    player2Moves: 4,
    player1Territory: 9,
    player2Territory: 5,
    durationSeconds: 120,
    status: "completed",
    isFunMode: false,
    startedAt: null,
    endedAt: null,
    createdAt: new Date().toISOString(),
    opponentName: null,
    ...over,
  };
}

test("getViewerSide: returns player1 when viewer is the host", () => {
  assert.equal(getViewerSide({ player1Id: P1, player2Id: P2 }, P1), "player1");
});

test("getViewerSide: returns player2 when viewer is the joiner", () => {
  assert.equal(getViewerSide({ player1Id: P1, player2Id: P2 }, P2), "player2");
});

test("getViewerSide: defaults to player1 when neither matches (defensive)", () => {
  assert.equal(
    getViewerSide({ player1Id: P1, player2Id: P2 }, "user_unknown"),
    "player1"
  );
});

test("didViewerWin: trusts server-recorded 'win' for the viewer when present", () => {
  // viewer as player2, winner=player1, but server recorded 'win' for viewer
  assert.equal(didViewerWin({ winner: "player1", result: "win" }, "player2"), true);
});

test("didViewerWin: trusts server-recorded 'loss' for the viewer when present", () => {
  // viewer is player1, engine winner is player2, server recorded 'loss' for viewer
  // → didViewerWin must return false (viewer did NOT win)
  assert.equal(
    didViewerWin({ winner: "player2", result: "loss" }, "player1"),
    false
  );
});

test("didViewerWin: derives win from winner === viewerSide when no result recorded", () => {
  assert.equal(didViewerWin({ winner: "player1", result: "" }, "player1"), true);
  assert.equal(didViewerWin({ winner: "player2", result: "" }, "player1"), false);
  assert.equal(didViewerWin({ winner: "player1", result: "" }, "player2"), false);
  assert.equal(didViewerWin({ winner: "player2", result: "" }, "player2"), true);
});

test("didViewerWin: 'draw' is treated as loss for the viewer", () => {
  assert.equal(didViewerWin({ winner: "draw", result: "" }, "player1"), false);
  assert.equal(didViewerWin({ winner: "draw", result: "" }, "player2"), false);
});

test("normalizeHexDuelForViewer: host viewer (player1) attributes moves/territory correctly", () => {
  const row = makeRow({ winner: "player1", result: "win" });
  const view = normalizeHexDuelForViewer(row, P1);
  assert.equal(view.viewerSide, "player1");
  assert.equal(view.isHost, true);
  assert.equal(view.viewerWon, true);
  assert.equal(view.viewerMoves, 6);
  assert.equal(view.opponentMoves, 4);
  assert.equal(view.viewerTerritory, 9);
  assert.equal(view.opponentTerritory, 5);
});

test("normalizeHexDuelForViewer: joiner viewer (player2) attributes moves/territory correctly", () => {
  const row = makeRow({ winner: "player1", result: "loss" });
  const view = normalizeHexDuelForViewer(row, P2);
  assert.equal(view.viewerSide, "player2");
  assert.equal(view.isHost, false);
  assert.equal(view.viewerWon, false);
  // Moves/territory swapped from joiner's POV:
  assert.equal(view.viewerMoves, 4);
  assert.equal(view.opponentMoves, 6);
  assert.equal(view.viewerTerritory, 5);
  assert.equal(view.opponentTerritory, 9);
});

test("normalizeHexDuelForViewer: joiner who actually won attributes correctly", () => {
  const row = makeRow({ winner: "player2", result: "win" });
  const view = normalizeHexDuelForViewer(row, P2);
  assert.equal(view.viewerWon, true);
  assert.equal(view.viewerMoves, 4);
  assert.equal(view.opponentMoves, 6);
});

test("normalizeHexDuelForViewer: AI mode with viewer as host", () => {
  const row = makeRow({
    player2Id: null,
    isAiGame: true,
    aiDifficulty: "hard",
    winner: "player1",
    result: "win",
  });
  const view = normalizeHexDuelForViewer(row, P1);
  assert.equal(view.opponentIsAi, true);
  assert.equal(view.opponentAiDifficulty, "hard");
});

test("normalizeHexDuelForViewer: AI mode with viewer as joiner (engine player1 in that case)", () => {
  // The engine always treats the human as player1 in AI mode (the page
  // forces localPlayerIsP1=true for non-multiplayer), so this scenario
  // shouldn't occur in production, but the helper must still produce
  // sensible output if it did.
  const row = makeRow({
    player1Id: "ai_user",
    player2Id: P2,
    isAiGame: true,
    aiDifficulty: "medium",
    winner: "player2",
    result: "win",
  });
  const view = normalizeHexDuelForViewer(row, P2);
  assert.equal(view.viewerSide, "player2");
  assert.equal(view.opponentIsAi, true);
  assert.equal(view.opponentAiDifficulty, "medium");
  assert.equal(view.viewerWon, true);
});

console.log("\n✅ Hex Duel perspective tests passed!\n");
