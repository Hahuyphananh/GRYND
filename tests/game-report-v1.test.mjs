/**
 * GameReportV1 contract + analyzer registry
 * (src/lib/evaluation/gameReport.ts, src/lib/evaluation/registry.ts).
 *
 * This is the first step of the approved Phase 2 architecture: one versioned,
 * game-agnostic report envelope shared by exact evaluations (chess, move-by-
 * move) and deterministic performance reports (speed typing, no moves at all).
 *
 * The tests pin five things that later games depend on:
 *
 *   1. VALIDATION — the envelope, the analysis type, the status and every metric
 *      are checked at runtime; a malformed report is rejected, not coerced.
 *   2. ELIGIBILITY — support comes from the registry, never from the lobby. A
 *      game key that only exists in the lobby must NOT be evaluatable.
 *   3. BACKWARD COMPATIBILITY — pre-contract chess rows (`objective_data` holds
 *      the old chess payload) still normalize into the contract, complete and
 *      insufficient alike; unknown payloads normalize to `null`, never a guess.
 *   4. ZERO vs MISSING — an actual `0` is an available metric; a value the game
 *      never recorded is `available: false` with a reason. The two never blur.
 *   5. AI SEPARATION — optional AI text never changes objective metrics.
 *
 * Run: npm run test:game-report
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GAME_REPORT_SCHEMA_VERSION,
  chessObjectiveToGameReport,
  findMetric,
  isGameReportV1,
  looksLikeGameReportV1,
  metric,
  metricNumber,
  metricOrUnavailable,
  normalizeStoredGameReport,
  parseGameReportV1,
  unavailableMetric,
} from "../src/lib/evaluation/gameReport.ts";

import {
  EVALUATION_ANALYZERS,
  getEvaluationAnalyzer,
  getSupportedEvaluationGames,
  isEvaluationSupported,
} from "../src/lib/evaluation/registry.ts";

// ════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════

/** A minimal but valid performance report (no moves, no engine). */
function performanceReport() {
  return {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: "speed-typing",
    analysisType: "performance",
    status: "complete",
    match: { matchId: "match-1" },
    metrics: [
      metric("wpm", "Words per minute", 84.5, "wpm"),
      metric("accuracyPercent", "Accuracy", 97, "percent"),
      unavailableMetric("reactionTimeMs", "Reaction time", "Not recorded for this match.", "ms"),
    ],
  };
}

const UUID = "11111111-1111-1111-1111-111111111111";

/** A stored, pre-contract chess payload as the evaluator writes it today. */
function legacyChessSufficient() {
  const move = (ply, color, san, cpLoss, thinkTimeMs) => ({
    ply,
    moveNumber: Math.ceil(ply / 2),
    san,
    uci: san,
    playedBy: color === "white" ? "u-white" : "u-black",
    color,
    evalBeforeCp: 10,
    evalAfterCp: 10 - cpLoss,
    cpLoss,
    classification: cpLoss > 100 ? "blunder" : cpLoss > 50 ? "mistake" : "good",
    isKeyMoment: cpLoss > 100,
    wasEngineBestMove: cpLoss === 0,
    engineBestMoveUci: "e2e4",
    thinkTimeMs,
  });

  return {
    gameId: UUID,
    sufficient: true,
    moveCount: 3,
    plyCount: 6,
    engine: { id: "stockfish-wasm", depth: 12, moveTimeMs: 50 },
    players: {
      white: {
        playedBy: "u-white",
        color: "white",
        moveCount: 3,
        accuracyPercent: 91.2,
        averageCpLoss: 12,
        blunders: 0,
        mistakes: 1,
        bestMoves: 2,
        totalThinkTimeMs: 1200,
        averageThinkTimeMs: 400,
        longestThinkMs: 700,
      },
      black: {
        playedBy: "u-black",
        color: "black",
        moveCount: 3,
        accuracyPercent: 80.5,
        averageCpLoss: 30,
        blunders: 1,
        mistakes: 0,
        bestMoves: 1,
        // No think-time data was stored for this side.
        totalThinkTimeMs: null,
        averageThinkTimeMs: null,
        longestThinkMs: null,
      },
    },
    keyMoment: {
      ply: 4,
      moveNumber: 2,
      san: "Qxf7",
      uci: "d1f7",
      playedBy: "u-black",
      color: "black",
      cpLoss: 900,
      evalBeforeCp: 20,
      evalAfterCp: -880,
    },
    blunders: [move(4, "black", "Qxf7", 900, 500)],
    mistakes: [move(2, "white", "Nf3", 60, 300)],
    moves: [
      move(1, "white", "e4", 0, 200), // an actual zero — not "missing"
      move(2, "white", "Nf3", 60, 300),
      move(3, "black", "e5", 0, 250),
      move(4, "black", "Qxf7", 900, 500),
      move(5, "white", "Kxf7", 0, 350),
      move(6, "black", "Kd8", 10, 250),
    ],
    thresholds: { blunderCp: 100, mistakeCp: 50 },
    analysisMs: 4200,
  };
}

function legacyChessInsufficient() {
  return {
    gameId: UUID,
    sufficient: false,
    reason: "too_few_moves",
    detail: "only 2 plies were played",
    moveCount: 1,
    plyCount: 2,
  };
}

// ════════════════════════════════════════════════════════════════════
// 1. Contract validation
// ════════════════════════════════════════════════════════════════════

test("the schema version is the pinned contract version", () => {
  assert.equal(GAME_REPORT_SCHEMA_VERSION, 1);
});

test("a valid report — including a moves-free performance report — parses", () => {
  const parsed = parseGameReportV1(performanceReport());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.report.gameKey, "speed-typing");
  assert.equal(parsed.report.analysisType, "performance");
  assert.equal(parsed.report.moves, undefined);
  assert.equal(parsed.report.engine, undefined);
  assert.equal(isGameReportV1(parsed.report), true);
  assert.equal(looksLikeGameReportV1(parsed.report), true);
});

test("a report survives a JSON round-trip (it fits a jsonb column)", () => {
  const report = parseGameReportV1(legacyWrapped()).report;
  const roundTripped = JSON.parse(JSON.stringify(report));
  assert.deepEqual(roundTripped, report);
  assert.equal(parseGameReportV1(roundTripped).ok, true);
});

/** Helper: a legacy chess payload already normalized to the contract. */
function legacyWrapped() {
  return chessObjectiveToGameReport(legacyChessSufficient());
}

test("invalid reports are rejected with explicit errors", () => {
  const cases = [
    ["not an object", 42, /report must be an object/],
    ["wrong version", { ...performanceReport(), schemaVersion: 2 }, /schemaVersion must be 1/],
    ["missing game key", { ...performanceReport(), gameKey: "" }, /gameKey/],
    [
      "unknown analysis type",
      { ...performanceReport(), analysisType: "vibes" },
      /analysisType/,
    ],
    ["unknown status", { ...performanceReport(), status: "maybe" }, /status/],
    ["missing match id", { ...performanceReport(), match: {} }, /match\.matchId/],
    ["metrics not an array", { ...performanceReport(), metrics: {} }, /metrics must be an array/],
  ];

  for (const [name, value, pattern] of cases) {
    const parsed = parseGameReportV1(value);
    assert.equal(parsed.ok, false, `${name} should be invalid`);
    assert.ok(
      parsed.errors.some((error) => pattern.test(error)),
      `${name} should report ${pattern}`,
    );
    assert.equal(isGameReportV1(value), false, `${name} should fail the guard`);
  }
});

test("a metric must be either available-with-value or unavailable-with-reason", () => {
  const availableNoValue = { ...performanceReport(), metrics: [{ key: "a", label: "A", available: true }] };
  const availableEmptyKey = { ...performanceReport(), metrics: [{ key: "", label: "A", available: true, value: 1 }] };
  const unavailableNoReason = { ...performanceReport(), metrics: [{ key: "a", label: "A", available: false }] };
  const nonBooleanAvailability = { ...performanceReport(), metrics: [{ key: "a", label: "A", available: "yes", value: 1 }] };
  const badUnit = { ...performanceReport(), metrics: [{ key: "a", label: "A", unit: "furlongs", available: true, value: 1 }] };

  assert.match(parseGameReportV1(availableNoValue).errors.join("; "), /value must be a number/);
  assert.match(parseGameReportV1(availableEmptyKey).errors.join("; "), /key must be a non-empty string/);
  assert.match(parseGameReportV1(unavailableNoReason).errors.join("; "), /reason must be a non-empty string/);
  assert.match(parseGameReportV1(nonBooleanAvailability).errors.join("; "), /available must be a boolean/);
  assert.match(parseGameReportV1(badUnit).errors.join("; "), /unit must be one of/);
});

test("nested sections are validated too", () => {
  const badPlayer = { ...performanceReport(), players: [{ playerId: "", metrics: [] }] };
  const badMove = { ...performanceReport(), moves: [{ ply: "one", label: "e4" }] };
  const badMoment = { ...performanceReport(), keyMoments: [{ ply: 1, label: "" }] };
  const badAi = { ...performanceReport(), ai: { available: true } };

  assert.match(parseGameReportV1(badPlayer).errors.join("; "), /playerId/);
  assert.match(parseGameReportV1(badMove).errors.join("; "), /ply must be a number/);
  assert.match(parseGameReportV1(badMoment).errors.join("; "), /label/);
  assert.match(parseGameReportV1(badAi).errors.join("; "), /ai\.summary/);
});

// ════════════════════════════════════════════════════════════════════
// 2. Registry + eligibility
// ════════════════════════════════════════════════════════════════════

test("the registry supports exactly chess, tic-tac-toe and speed-typing today", () => {
  assert.deepEqual(getSupportedEvaluationGames(), ["chess", "tic-tac-toe", "speed-typing"]);
  assert.deepEqual(Object.keys(EVALUATION_ANALYZERS), ["chess", "tic-tac-toe", "speed-typing"]);
  assert.equal(isEvaluationSupported("chess"), true);
  assert.equal(isEvaluationSupported("tic-tac-toe"), true);
  assert.equal(isEvaluationSupported("speed-typing"), true);
});

test("the tic-tac-toe adapter declares its analysis type, trusted input and validator", () => {
  const analyzer = getEvaluationAnalyzer("tic-tac-toe");
  assert.ok(analyzer, "tic-tac-toe must be registered");
  assert.equal(analyzer.analysisType, "exact");
  assert.ok(analyzer.requires.some((table) => /tic_tac_toe_moves/.test(table)));
  assert.equal(analyzer.validateInput(UUID).ok, true);
  const bad = analyzer.validateInput("not-a-uuid");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /uuid/i);
  assert.equal(typeof analyzer.analyze, "function");
  assert.equal(typeof analyzer.toGameReport, "function");
});

test("the chess adapter declares its analysis type, trusted input and validator", () => {
  const analyzer = getEvaluationAnalyzer("chess");
  assert.ok(analyzer, "chess must be registered");
  assert.equal(analyzer.analysisType, "exact");
  assert.ok(analyzer.requires.some((table) => /chess_moves/.test(table)));
  assert.equal(analyzer.validateInput(UUID).ok, true);
  const bad = analyzer.validateInput("not-a-uuid");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /uuid/i);
  assert.equal(typeof analyzer.analyze, "function");
  assert.equal(typeof analyzer.toGameReport, "function");
});

test("the chess adapter re-frames its own payload as the contract", () => {
  const analyzer = getEvaluationAnalyzer("chess");
  const report = analyzer.toGameReport(legacyChessSufficient());
  assert.equal(report.gameKey, "chess");
  assert.equal(report.analysisType, "exact");
  assert.equal(report.status, "complete");
  assert.equal(parseGameReportV1(report).ok, true);
});

test("a lobby key alone does not make a game evaluatable", () => {
  // These keys exist in the lobby (src/app/casino/PageClient.jsx) but have no
  // registered analyzer, so they must stay unsupported — this is what keeps
  // "a game cannot become eligible merely because its key exists in the lobby".
  for (const key of ["keno", "mines-pvp", "uno", "four-in-a-row", "lane-runner"]) {
    assert.equal(isEvaluationSupported(key), false, key);
    assert.equal(getEvaluationAnalyzer(key), null, key);
  }
});

test("an unknown key and a blank key both resolve to no analyzer", () => {
  assert.equal(getEvaluationAnalyzer("chess ").gameKey, "chess", "trimmed lookup still finds chess");
  assert.equal(getEvaluationAnalyzer("chess") !== null, true);
  assert.equal(getEvaluationAnalyzer(""), null);
  assert.equal(getEvaluationAnalyzer(undefined), null);
  assert.equal(isEvaluationSupported("chess-pvp"), false);
});

// ════════════════════════════════════════════════════════════════════
// 3. Backward compatibility with stored chess rows
// ════════════════════════════════════════════════════════════════════

test("a stored pre-contract chess payload normalizes into the contract", () => {
  const report = normalizeStoredGameReport(legacyChessSufficient());
  assert.ok(report);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.gameKey, "chess");
  assert.equal(report.analysisType, "exact");
  assert.equal(report.status, "complete");
  assert.equal(report.match.matchId, UUID);
  assert.equal(report.engine.id, "stockfish-wasm");
  assert.equal(report.engine.depth, 12);

  // Players are broken out by side, with the evaluator's own numbers.
  assert.deepEqual(report.players.map((p) => p.role), ["white", "black"]);
  assert.equal(metricNumber(report.players[0].metrics, "accuracyPercent"), 91.2);

  // Every ply is preserved, in order, with its per-move metrics.
  assert.equal(report.moves.length, 6);
  assert.deepEqual(report.moves.map((m) => m.ply), [1, 2, 3, 4, 5, 6]);
  assert.equal(report.moves[0].label, "e4");
  assert.deepEqual(report.moves[3].tags, ["blunder"]);

  // Key moments are grounded in the evaluator's keyMoment + blunders.
  assert.ok(report.keyMoments.length >= 1);
  assert.ok(report.keyMoments.some((m) => m.ply === 4));
});

test("an insufficient chess payload becomes an unavailable report, with no stats", () => {
  const report = normalizeStoredGameReport(legacyChessInsufficient());
  assert.ok(report);
  assert.equal(report.status, "unavailable");
  assert.equal(report.metrics.length, 0, "no metrics may be invented for an unavailable match");
  assert.equal(report.moves, undefined);
  assert.equal(report.unavailableReason, "only 2 plies were played");
  assert.equal(parseGameReportV1(report).ok, true);
});

test("a non-chess, non-contract payload normalizes to null rather than a guess", () => {
  // The in-flight claim marker is explicitly NOT a report.
  assert.equal(normalizeStoredGameReport({ pending: true }), null);
  assert.equal(normalizeStoredGameReport(null), null);
  assert.equal(normalizeStoredGameReport("chess"), null);
  assert.equal(normalizeStoredGameReport([1, 2, 3]), null);
  // A malformed GameReportV1 (right version tag, broken metrics) is rejected too.
  assert.equal(
    normalizeStoredGameReport({
      ...performanceReport(),
      metrics: [{ key: "wpm", label: "WPM", available: true }],
    }),
    null,
  );
});

test("an already-contract report normalizes to itself", () => {
  const original = parseGameReportV1(performanceReport()).report;
  const normalized = normalizeStoredGameReport(original);
  assert.deepEqual(normalized, original);
});

// ════════════════════════════════════════════════════════════════════
// 4. Zero vs missing
// ════════════════════════════════════════════════════════════════════

test("an actual zero is an available metric, not a missing one", () => {
  const report = normalizeStoredGameReport(legacyChessSufficient());
  const firstMove = report.moves[0];
  const cpLoss = findMetric(firstMove.metrics, "cpLoss");
  assert.equal(cpLoss.available, true);
  assert.equal(cpLoss.value, 0);
  // metricNumber must surface the zero, not null.
  assert.equal(metricNumber(firstMove.metrics, "cpLoss"), 0);

  const bestMove = findMetric(report.moves[0].metrics, "wasEngineBestMove");
  assert.equal(bestMove.available, true);
  assert.equal(bestMove.value, true);
});

test("a value the game never recorded is unavailable, with a reason", () => {
  const report = normalizeStoredGameReport(legacyChessSufficient());
  const black = report.players.find((p) => p.role === "black");
  const totalThink = findMetric(black.metrics, "totalThinkTimeMs");
  assert.equal(totalThink.available, false);
  assert.match(totalThink.reason, /think-time/);
  assert.equal(metricNumber(black.metrics, "totalThinkTimeMs"), null);
  // ...while white's recorded think time IS available.
  const white = report.players.find((p) => p.role === "white");
  assert.equal(findMetric(white.metrics, "totalThinkTimeMs").available, true);
});

test("metricOrUnavailable maps null/undefined/zero correctly", () => {
  const missing = metricOrUnavailable("k", "K", null, "not recorded");
  const absent = metricOrUnavailable("k", "K", undefined, "not recorded");
  const zero = metricOrUnavailable("k", "K", 0, "not recorded");
  assert.equal(missing.available, false);
  assert.equal(absent.available, false);
  assert.equal(zero.available, true);
  assert.equal(zero.value, 0);
});

// ════════════════════════════════════════════════════════════════════
// 5. Optional AI never affects objective metrics
// ════════════════════════════════════════════════════════════════════

test("adding AI text leaves objective metrics byte-for-byte identical", () => {
  const base = parseGameReportV1(performanceReport()).report;
  const withAi = parseGameReportV1({
    ...base,
    ai: { available: true, model: "groq", summary: "Nice typing.", sections: [] },
  }).report;

  assert.deepEqual(withAi.metrics, base.metrics);
  assert.equal(findMetric(withAi.metrics, "wpm").value, 84.5);
  assert.equal(withAi.ai.available, true);
});

test("an unavailable AI branch is the only honest representation of a failure", () => {
  const report = parseGameReportV1({
    ...performanceReport(),
    ai: { available: false, reason: "provider timeout" },
  }).report;
  assert.equal(report.ai.available, false);
  assert.equal(report.ai.reason, "provider timeout");
  // The metrics are untouched by the failure.
  assert.equal(report.metrics.length, 3);
});

test("a legacy chess report carries no AI by default", () => {
  const report = normalizeStoredGameReport(legacyChessSufficient());
  assert.equal(report.ai, null);
});
