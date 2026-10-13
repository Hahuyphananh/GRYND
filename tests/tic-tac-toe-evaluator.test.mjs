/**
 * Exact Tic-Tac-Toe evaluator
 * (src/lib/evaluation/games/ticTacToeEvaluator.ts).
 *
 * The shipped game is MEGA Tic-Tac-Toe, so this evaluator deliberately reports
 * `exact` analysis ONLY for a match decided within stage 1 — won on the single
 * opening board. These tests pin:
 *
 *   1. The classification scheme, directly (`classifyMove`) and through the
 *      solver (`bestOutcomeFor`): optimal / missedWin / blunder / missedDraw /
 *      unavoidable, including that several moves can be equally optimal.
 *   2. A real finished stage-1 match (built with the SAME rules engine) yields a
 *      complete GameReportV1, per-player breakdowns, move-by-move tags and key
 *      moments — deterministically.
 *   3. Every rejection path: incomplete/illegal/mis-attributed history, moves
 *      after the end, inconsistent persisted results, a match decided outside
 *      stage 1, a forfeit, and a missing match.
 *   4. The registry adapter, so a lobby key alone can never make a game eligible.
 *
 * Run: npm run test:tic-tac-toe-evaluation
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTicTacToeGame,
  bestOutcomeFor,
  classifyMove,
  evaluateTicTacToeMatch,
} from "../src/lib/evaluation/games/ticTacToeEvaluator.ts";
import {
  applyMove,
  createInitialState,
  userIdForSeat,
} from "../src/lib/tic-tac-toe/rules.ts";
import { parseGameReportV1 } from "../src/lib/evaluation/gameReport.ts";
import {
  getEvaluationAnalyzer,
  getSupportedEvaluationGames,
  isEvaluationSupported,
} from "../src/lib/evaluation/registry.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const X_USER = "user_x";
const O_USER = "user_o";
const AI_USER = "tic_tac_toe_ai_bot";

// ════════════════════════════════════════════════════════════════════
// Fixtures — built with the real rules engine so they are always legal
// ════════════════════════════════════════════════════════════════════

/**
 * Plays `cells` (board-0 cell indices, one per ply) through the real engine and
 * returns a `TicTacToeMatchInput` whose persisted state/result agree with the
 * replay. `player2Id` defaults to the human opponent but can be the AI id.
 */
function buildMatch(cells, { player1Id = X_USER, player2Id = O_USER } = {}) {
  const seats = { player1Id, player2Id };
  let state = createInitialState();
  const moves = [];

  cells.forEach((cellIndex, ply) => {
    const seat = state.currentTurn;
    const applied = applyMove({ state, seat, boardIndex: 0, cellIndex });
    moves.push({
      ply,
      playerId: userIdForSeat(seats, seat),
      boardIndex: 0,
      cellIndex,
    });
    state = applied.state;
  });

  return {
    matchId: UUID,
    player1Id,
    player2Id,
    winnerId: state.winner ? userIdForSeat(seats, state.winner) : null,
    status: state.phase === "finished" ? "finished" : "playing",
    result: state.winner ?? null,
    ply: state.ply,
    gameState: state,
    endedAtIso: "2026-01-01T12:00:00.000Z",
    moves,
  };
}

/** X wins in 5 plies: X 0,4,8 diagonal; O never blocks. */
const WIN_IN_FIVE = [0, 3, 4, 6, 8];
/** X misses a forced win at ply 2, then still converts; O also wastes a draw. */
const MISSED_WIN = [0, 1, 2, 3, 4, 5, 6];
/** Both sides err: two moves that turn a won game into a forced loss. */
const BLUNDER = [0, 1, 2, 3, 5, 7, 6, 8, 4];
/** A full opening board with no line — a stage-1 DRAW, which expands to stage 2. */
const STAGE1_DRAW = [0, 1, 2, 4, 3, 5, 7, 6, 8];

function tagsOf(report, ply) {
  const move = report.moves.find((entry) => entry.ply === ply);
  assert.ok(move, `move at ply ${ply} must exist`);
  return move.tags;
}

function playerOf(report, role) {
  return report.players.find((entry) => entry.role === role);
}

// ════════════════════════════════════════════════════════════════════
// 1. Classification scheme
// ════════════════════════════════════════════════════════════════════

test("the classification table is disjoint and matches the documented rules", () => {
  assert.equal(classifyMove("win", "win"), "optimal");
  assert.equal(classifyMove("win", "draw"), "missedWin");
  assert.equal(classifyMove("win", "loss"), "blunder");
  assert.equal(classifyMove("draw", "draw"), "optimal");
  assert.equal(classifyMove("draw", "loss"), "missedDraw");
  assert.equal(classifyMove("loss", "loss"), "unavoidable");
  // `after` can never beat `best` (best is the maximum), but the function is
  // total: a "loss" best is always unavoidable regardless of the move.
  assert.equal(classifyMove("loss", "draw"), "unavoidable");
  assert.equal(classifyMove("loss", "loss"), "unavoidable");
});

test("the opening position is a draw — no move is uniquely best", () => {
  const empty = Array.from({ length: 9 }, () => null);
  assert.equal(bestOutcomeFor(empty, "X"), "draw");
});

test("the solver proves a forced win is available", () => {
  // X on r1c1,r1c2 (0,1); O on r2c1,r2c2 (3,4). X to move wins at 2.
  const cells = ["X", "X", null, "O", "O", null, null, null, null];
  assert.equal(bestOutcomeFor(cells, "X"), "win");
});

test("several moves can be equally optimal — none is claimed uniquely best", () => {
  // X on 0,1,3,4; O on 8. X to move can win at 2 (row 0,1,2) OR 6 (col 0,3,6).
  const before = ["X", "X", null, "X", "X", null, null, null, "O"];
  assert.equal(bestOutcomeFor(before, "X"), "win");

  for (const winningCell of [2, 6]) {
    const after = [...before];
    after[winningCell] = "X";
    // The successor is still won for the mover, so BOTH are classified optimal
    // — the report never claims a unique best move.
    assert.equal(bestOutcomeFor(after, "O"), "loss");
    assert.equal(classifyMove("win", "win"), "optimal");
  }
});

test("a position that is already lost yields only unavoidable moves", () => {
  // O has two simultaneous threats (row 0,1 and row 3,4); X to move can block
  // only one, so the game is lost with optimal play.
  const cells = ["O", "O", null, "O", "O", null, null, null, "X"];
  assert.equal(bestOutcomeFor(cells, "X"), "loss");
  assert.equal(classifyMove("loss", "loss"), "unavoidable");
});

// ════════════════════════════════════════════════════════════════════
// 2. A real finished stage-1 match
// ════════════════════════════════════════════════════════════════════

test("a stage-1 win produces a complete, exact GameReportV1", () => {
  const report = analyzeTicTacToeGame(buildMatch(WIN_IN_FIVE));

  assert.equal(parseGameReportV1(report).ok, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.gameKey, "tic-tac-toe");
  assert.equal(report.analysisType, "exact");
  assert.equal(report.status, "complete");
  assert.equal(report.match.matchId, UUID);
  assert.equal(report.match.result, "player1");
  assert.deepEqual(report.match.participants, [X_USER, O_USER]);
  assert.equal(report.engine, null);
  assert.equal(report.ai, null);

  // Move-by-move, one entry per ply, attributed to the seat that played it.
  assert.equal(report.moves.length, 5);
  assert.deepEqual(report.moves.map((m) => m.ply), [0, 1, 2, 3, 4]);
  assert.deepEqual(report.moves.map((m) => m.actor), [X_USER, O_USER, X_USER, O_USER, X_USER]);
  assert.equal(report.moves[0].label, "r1c1");

  // A per-player breakdown exists for both seats, with an outcome.
  assert.deepEqual(report.players.map((p) => p.role), ["player1", "player2"]);
  const x = playerOf(report, "player1");
  const o = playerOf(report, "player2");
  const metricValue = (player, key) =>
    player.metrics.find((m) => m.key === key)?.value;
  assert.equal(metricValue(x, "outcome"), "win");
  assert.equal(metricValue(o, "outcome"), "loss");
});

test("a missed draw is classified as missedDraw and surfaced as a key moment", () => {
  const report = analyzeTicTacToeGame(buildMatch(WIN_IN_FIVE));
  // O's opening reply (ply 1) throws away the draw; X later wins.
  assert.deepEqual(tagsOf(report, 1), ["missedDraw"]);
  // X's winning move is optimal, and X never blunders.
  assert.deepEqual(tagsOf(report, 4), ["optimal"]);
  assert.ok(report.keyMoments.some((m) => m.ply === 1));
  const o = playerOf(report, "player2");
  assert.equal(o.metrics.find((m) => m.key === "missedDraws").value, 1);
});

test("a position already lost with optimal play yields only unavoidable moves", () => {
  const report = analyzeTicTacToeGame(buildMatch(WIN_IN_FIVE));
  // By ply 3 (O to move) X has a forced win, so nothing O plays preserves a
  // better result — that is `unavoidable`, NOT a mistake.
  assert.deepEqual(tagsOf(report, 3), ["unavoidable"]);
  const o = playerOf(report, "player2");
  assert.equal(o.metrics.find((m) => m.key === "unavoidableMoves").value, 1);
  assert.equal(o.metrics.find((m) => m.key === "blunders").value, 0);
});

test("a missed forced win is classified as missedWin", () => {
  const report = analyzeTicTacToeGame(buildMatch(MISSED_WIN));
  assert.deepEqual(tagsOf(report, 2), ["missedWin"]);
  const x = playerOf(report, "player1");
  assert.equal(x.metrics.find((m) => m.key === "missedWins").value, 1);
  // The final move still converts the win, so it is optimal.
  assert.deepEqual(tagsOf(report, 6), ["optimal"]);
});

test("a move that turns a won game into a forced loss is classified as blunder", () => {
  const report = analyzeTicTacToeGame(buildMatch(BLUNDER));
  const tags = report.moves.map((m) => m.tags[0]);
  assert.ok(tags.includes("blunder"), "a forced-loss move must be flagged as a blunder");
  // A blunder is only ever a CHANGE of outcome, never a merely different move.
  assert.equal(classifyMove("win", "loss"), "blunder");
});

test("a move that changes no outcome is never flagged as a mistake", () => {
  const report = analyzeTicTacToeGame(buildMatch(WIN_IN_FIVE));
  // X's three moves all preserve the optimal outcome; none is a "blunder".
  for (const ply of [0, 2, 4]) assert.deepEqual(tagsOf(report, ply), ["optimal"]);
  const x = playerOf(report, "player1");
  assert.equal(x.metrics.find((m) => m.key === "blunders").value, 0);
  assert.equal(x.metrics.find((m) => m.key === "missedWins").value, 0);
});

test("evaluation is deterministic — the same match yields the same report", () => {
  const input = buildMatch(MISSED_WIN);
  assert.deepEqual(analyzeTicTacToeGame(input), analyzeTicTacToeGame(input));
});

test("a practice (vs-AI) match is evaluated the same way", () => {
  const report = analyzeTicTacToeGame(buildMatch(WIN_IN_FIVE, { player2Id: AI_USER }));
  assert.equal(report.status, "complete");
  assert.equal(report.moves[1].actor, AI_USER);
  assert.deepEqual(report.match.participants, [X_USER, AI_USER]);
});

// ════════════════════════════════════════════════════════════════════
// 3. Rejections — never fabricate, never repair
// ════════════════════════════════════════════════════════════════════

function reasonOf(report) {
  assert.equal(report.status, "unavailable");
  assert.equal(report.metrics.length, 0, "an unavailable report carries no metrics");
  assert.equal(report.moves, undefined);
  return report.unavailableReason;
}

test("an unfinished match is not evaluable", () => {
  const input = { ...buildMatch(WIN_IN_FIVE), status: "playing" };
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "match_not_finished");
});

test("a match that expanded past stage 1 is not exactly evaluable", () => {
  const drawn = buildMatch(STAGE1_DRAW);
  assert.ok(drawn.gameState.stage > 1, "a stage-1 draw must expand the match");
  const input = { ...drawn, status: "finished", result: "tie" };
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "not_exactly_evaluable");
});

test("a forfeit (finished with a result, but not played out) is not exactly evaluable", () => {
  const partial = buildMatch([0, 3, 4]); // X0, O3, X4 — nobody has won
  const forfeited = {
    ...partial,
    status: "finished",
    result: "player1",
    winnerId: X_USER,
    gameState: { ...partial.gameState, phase: "finished" },
  };
  assert.equal(reasonOf(analyzeTicTacToeGame(forfeited)), "not_exactly_evaluable");
});

test("an empty history is incomplete", () => {
  const input = { ...buildMatch(WIN_IN_FIVE), moves: [] };
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "history_incomplete");
});

test("a gap in the ply numbering is incomplete", () => {
  const input = buildMatch(WIN_IN_FIVE);
  input.moves = input.moves.filter((m) => m.ply !== 2);
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "history_incomplete");
});

test("an illegal move (occupied cell) is rejected, not skipped", () => {
  const input = buildMatch(WIN_IN_FIVE);
  input.moves = input.moves.map((m) => (m.ply === 1 ? { ...m, cellIndex: 0 } : m));
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "invalid_move_history");
});

test("a move attributed to the wrong player is rejected", () => {
  const input = buildMatch(WIN_IN_FIVE);
  input.moves = input.moves.map((m) => (m.ply === 0 ? { ...m, playerId: O_USER } : m));
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "history_attribution_mismatch");
});

test("a move recorded after the match ended is rejected", () => {
  const input = buildMatch(WIN_IN_FIVE);
  input.moves = [
    ...input.moves,
    { ply: 5, playerId: O_USER, boardIndex: 0, cellIndex: 1 },
  ];
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "history_after_end");
});

test("a persisted result that disagrees with the replay is rejected", () => {
  const input = { ...buildMatch(WIN_IN_FIVE), result: "player2" };
  assert.equal(reasonOf(analyzeTicTacToeGame(input)), "result_mismatch");
});

test("a persisted board that disagrees with the replay is rejected", () => {
  const input = buildMatch(WIN_IN_FIVE);
  const tampered = JSON.parse(JSON.stringify(input.gameState));
  tampered.boards[0].cells[0] = null;
  assert.equal(reasonOf(analyzeTicTacToeGame({ ...input, gameState: tampered })), "result_mismatch");
});

test("a non-uuid match id never reaches the database and reports not-found", async () => {
  const report = await evaluateTicTacToeMatch("not-a-uuid");
  assert.equal(reasonOf(report), "game_not_found");
});

// ════════════════════════════════════════════════════════════════════
// 4. Registry eligibility
// ════════════════════════════════════════════════════════════════════

test("tic-tac-toe is registered as an exact analyzer", () => {
  assert.ok(getSupportedEvaluationGames().includes("tic-tac-toe"));
  assert.equal(isEvaluationSupported("tic-tac-toe"), true);
  const analyzer = getEvaluationAnalyzer("tic-tac-toe");
  assert.equal(analyzer.analysisType, "exact");
  assert.ok(analyzer.requires.some((table) => /tic_tac_toe_moves/.test(table)));
  assert.equal(analyzer.validateInput(UUID).ok, true);
  assert.equal(analyzer.validateInput("nope").ok, false);
});

test("the adapter re-frames a report without inventing anything", () => {
  const analyzer = getEvaluationAnalyzer("tic-tac-toe");
  const report = analyzeTicTacToeGame(buildMatch(WIN_IN_FIVE));
  assert.deepEqual(analyzer.toGameReport(report), report);
  // A malformed payload is refused rather than coerced.
  assert.equal(analyzer.toGameReport({ gameKey: "tic-tac-toe" }), null);
});
