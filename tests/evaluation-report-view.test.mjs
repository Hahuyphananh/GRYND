/**
 * GameReportV1 → evaluation page view model
 * (src/lib/evaluation/reportViewModel.ts).
 *
 * This is the regression guard for the confirmed rendering bug: the shared
 * evaluation page gated its stat tiles on the CHESS shape (`objective.sufficient`),
 * which does not exist on a `GameReportV1`, so a Speed Typing performance report
 * returned with HTTP 200 rendered no metrics and a misleading fallback.
 *
 * These tests run against REAL evaluator output (the Speed Typing analyzer's own
 * pure function) rather than a hand-written payload, and pin:
 *
 *   1. Chess compatibility — a legacy chess payload is never treated as a report,
 *      so the chess renderer still owns it.
 *   2. A valid performance report maps its validated `metrics` and `players`.
 *   3. A missing metric is `value: null` with a reason; an ACTUAL zero is
 *      `value: "0"` and available. The two never blur.
 *   4. Missing metrics / missing players map to empty arrays, never filler.
 *   5. Malformed or unsupported payloads are rejected, not coerced.
 *   6. An unavailable AI branch leaves the objective metrics untouched.
 *
 * Run: npm run test:evaluation-report-view
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GAME_REPORT_SCHEMA_VERSION,
  looksLikeGameReportV1,
  metric,
  metricOrUnavailable,
  normalizeStoredGameReport,
  parseGameReportV1,
  unavailableMetric,
} from "../src/lib/evaluation/gameReport.ts";
import {
  buildGameReportView,
  formatMetricValue,
  playerLabel,
  reportViewHasContent,
  toReportMetricView,
} from "../src/lib/evaluation/reportViewModel.ts";
import {
  accuracyPercentFor,
  analyzeSpeedTypingGame,
  wpmFor,
} from "../src/lib/evaluation/games/speedTypingEvaluator.ts";
import { PASSAGE_VERSION, passageById } from "../src/lib/speed-typing/passages.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const P1 = "user_p1";
const P2 = "user_p2";

const PASSAGE = passageById("pt-02", PASSAGE_VERSION);
const L = PASSAGE.charCount;

// ════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════

function seat(overrides = {}) {
  return {
    charsTyped: 0,
    errors: 0,
    finished: false,
    finishedAtMs: null,
    elapsedMs: null,
    wpm: null,
    accuracy: null,
    forfeited: false,
    ...overrides,
  };
}

/** A finished, consistent Speed Typing race (the evaluator's own input shape). */
function raceInput(overrides = {}) {
  const goAtMs = Date.parse("2026-01-01T12:00:00.000Z");
  const p1 = seat({
    charsTyped: L,
    errors: 0,
    finished: true,
    finishedAtMs: goAtMs + 30_000,
    elapsedMs: 30_000,
    wpm: wpmFor(L, 30_000),
    accuracy: accuracyPercentFor(L, L),
  });
  const p2 = seat({ charsTyped: 100, errors: 5 });
  const base = {
    matchId: UUID,
    player1Id: P1,
    player2Id: P2,
    winnerId: P1,
    status: "finished",
    result: "player1",
    isAi: false,
    goAtMs,
    resolvedAtMs: goAtMs + 30_000,
    resolutionReason: "finish",
    passageId: "pt-02",
    passageVersion: PASSAGE_VERSION,
    passageCharCount: L,
    endedAtIso: "2026-01-01T12:00:30.000Z",
    seats: { player1: p1, player2: p2 },
    mirror: {
      player1CharsTyped: p1.charsTyped,
      player1Errors: p1.errors,
      player2CharsTyped: p2.charsTyped,
      player2Errors: p2.errors,
    },
  };
  return { ...base, ...overrides, seats: { ...base.seats, ...(overrides.seats ?? {}) } };
}

/** A stored, pre-contract chess payload (as the chess evaluator persists it). */
function legacyChessPayload() {
  return {
    gameId: UUID,
    sufficient: true,
    moveCount: 3,
    plyCount: 6,
    engine: { id: "stockfish-wasm", depth: 12, moveTimeMs: 50 },
    players: {
      white: {
        playedBy: "u-white",
        moveCount: 3,
        accuracyPercent: 91.2,
        averageCpLoss: 12,
        blunders: 0,
        mistakes: 1,
        bestMoves: 2,
        totalThinkTimeMs: null,
        averageThinkTimeMs: null,
        longestThinkMs: null,
      },
      black: {
        playedBy: "u-black",
        moveCount: 3,
        accuracyPercent: 80.5,
        averageCpLoss: 30,
        blunders: 1,
        mistakes: 0,
        bestMoves: 1,
        totalThinkTimeMs: null,
        averageThinkTimeMs: null,
        longestThinkMs: null,
      },
    },
    keyMoment: null,
    blunders: [],
    mistakes: [],
    moves: [
      { ply: 1, san: "e4", playedBy: "u-white", color: "white", evalBeforeCp: 0, evalAfterCp: 0, cpLoss: 0, classification: "best", wasEngineBestMove: true, thinkTimeMs: 200 },
    ],
    analysisMs: 4200,
  };
}

function metricViewFor(view, key, role = null) {
  const source = role
    ? view.players.find((player) => player.role === role).metrics
    : view.metrics;
  return source.find((entry) => entry.key === key);
}

// ════════════════════════════════════════════════════════════════════
// 1. Chess compatibility
// ════════════════════════════════════════════════════════════════════

test("a legacy chess payload is NOT a report and is never routed to the report renderer", () => {
  const chess = legacyChessPayload();
  // No schema version → the page's `looksLikeGameReportV1` gate stays false, so
  // the chess block (unchanged) renders it and this module never sees it.
  assert.equal(looksLikeGameReportV1(chess), false);
  assert.equal(buildGameReportView(chess).ok, false);
});

test("the legacy chess payload still normalizes into the contract (unchanged behavior)", () => {
  const report = normalizeStoredGameReport(legacyChessPayload());
  assert.ok(report);
  assert.equal(report.analysisType, "exact");
  assert.equal(report.status, "complete");
  assert.equal(parseGameReportV1(report).ok, true);
});

// ════════════════════════════════════════════════════════════════════
// 2. A valid Speed Typing performance report
// ════════════════════════════════════════════════════════════════════

test("a valid Speed Typing report maps its validated metrics, units and players", () => {
  const report = analyzeSpeedTypingGame(raceInput());
  assert.equal(report.analysisType, "performance");

  const result = buildGameReportView(report);
  assert.equal(result.ok, true, `should validate: ${result.errors.join("; ")}`);
  const view = result.view;

  // The heading matches how the report was judged — never "chess evaluation".
  assert.equal(view.title, "Performance Report");
  assert.equal(view.analysisType, "performance");
  assert.equal(view.status, "complete");

  // Match-wide metrics come straight from the report, with their units.
  assert.equal(metricViewFor(view, "passageLength").value, String(L));
  assert.equal(metricViewFor(view, "passageLength").unit, "");
  assert.equal(metricViewFor(view, "raceDurationMs").value, "30000");
  assert.equal(metricViewFor(view, "raceDurationMs").unit, "ms");
  assert.equal(metricViewFor(view, "isPractice").value, "No");

  // Players are mapped by their game-defined roles, and labelled readably.
  assert.deepEqual(view.players.map((player) => player.role), ["player1", "player2"]);
  assert.deepEqual(view.players.map((player) => player.label), ["Player 1", "Player 2"]);

  // The finisher has a real WPM with the schema's unit.
  const p1Wpm = metricViewFor(view, "wpm", "player1");
  assert.equal(p1Wpm.available, true);
  assert.equal(p1Wpm.value, String(wpmFor(L, 30_000)));
  assert.equal(p1Wpm.unit, "WPM");

  // The non-finisher gets NO fabricated WPM: unavailable, with a reason.
  const p2Wpm = metricViewFor(view, "wpm", "player2");
  assert.equal(p2Wpm.available, false);
  assert.equal(p2Wpm.value, null);
  assert.match(p2Wpm.reason, /complete the passage/i);

  assert.equal(reportViewHasContent(view), true);
});

test("an ACTUAL zero is available and renders as 0 — never as missing", () => {
  // Player 1 finishes the passage with zero errors. That is a real 0.
  const zeroErrors = raceInput({
    seats: { player1: seat({ charsTyped: L, errors: 0, finished: true, finishedAtMs: Date.parse("2026-01-01T12:00:30.000Z"), elapsedMs: 30_000, wpm: wpmFor(L, 30_000), accuracy: 100 }) },
  });
  const view = buildGameReportView(analyzeSpeedTypingGame(zeroErrors)).view;
  const errors = metricViewFor(view, "errors", "player1");
  assert.equal(errors.available, true);
  assert.equal(errors.value, "0");
});

test("a value the game never recorded is unavailable with value null (not zero)", () => {
  const report = analyzeSpeedTypingGame(
    raceInput({
      // No GO instant: completion time and wpm cannot exist for anyone.
      goAtMs: null,
      resolvedAtMs: null,
    }),
  );
  const view = buildGameReportView(report).view;
  const wpm = metricViewFor(view, "wpm", "player1");
  assert.equal(wpm.available, false);
  assert.equal(wpm.value, null);
  assert.equal(metricViewFor(view, "raceDurationMs").available, false);
  assert.equal(metricViewFor(view, "raceDurationMs").value, null);
});

// ════════════════════════════════════════════════════════════════════
// 3. Missing metrics / missing players
// ════════════════════════════════════════════════════════════════════

test("a report with no metrics and no players maps to empty arrays, never filler", () => {
  const bare = {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: "speed-typing",
    analysisType: "performance",
    status: "complete",
    match: { matchId: UUID },
    metrics: [],
  };
  const result = buildGameReportView(bare);
  assert.equal(result.ok, true);
  assert.deepEqual(result.view.metrics, []);
  assert.deepEqual(result.view.players, []);
  assert.equal(reportViewHasContent(result.view), false);
});

test("an unavailable report carries only its reason and no metrics", () => {
  const report = analyzeSpeedTypingGame(raceInput({ status: "playing" }));
  const result = buildGameReportView(report);
  assert.equal(result.ok, true);
  assert.equal(result.view.status, "unavailable");
  assert.deepEqual(result.view.metrics, []);
  assert.equal(result.view.unavailableReason, "match_not_finished");
});

// ════════════════════════════════════════════════════════════════════
// 4. Missing vs zero at the metric level, and formatting
// ════════════════════════════════════════════════════════════════════

test("metric rows keep missing and zero apart, with units only where supported", () => {
  const zero = toReportMetricView(metric("cpLoss", "Centipawn loss", 0, "cp"));
  assert.equal(zero.available, true);
  assert.equal(zero.value, "0");
  assert.equal(zero.unit, "cp");
  assert.equal(zero.reason, null);

  const missing = toReportMetricView(
    unavailableMetric("thinkTimeMs", "Think time", "No think-time data was recorded.", "ms"),
  );
  assert.equal(missing.available, false);
  assert.equal(missing.value, null);
  assert.equal(missing.reason, "No think-time data was recorded.");
  assert.equal(missing.unit, "ms");

  // A unit with no suffix adds nothing rather than inventing a word.
  assert.equal(toReportMetricView(metric("wins", "Wins", 3, "count")).unit, "");
  assert.equal(toReportMetricView(metric("unknown", "Unknown", "draw")).unit, "");
});

test("formatMetricValue renders booleans as Yes/No and does not turn 0 into missing", () => {
  assert.equal(formatMetricValue(true), "Yes");
  assert.equal(formatMetricValue(false), "No");
  assert.equal(formatMetricValue(0), "0");
  assert.equal(formatMetricValue("finish"), "finish");
});

test("metricOrUnavailable maps a null to unavailable but a 0 to available", () => {
  const missing = toReportMetricView(metricOrUnavailable("k", "K", null, "not recorded"));
  const absent = toReportMetricView(metricOrUnavailable("k", "K", undefined, "not recorded"));
  const zero = toReportMetricView(metricOrUnavailable("k", "K", 0, "not recorded"));
  assert.equal(missing.value, null);
  assert.equal(absent.value, null);
  assert.equal(zero.available, true);
  assert.equal(zero.value, "0");
});

test("playerLabel humanizes roles and falls back to an index", () => {
  assert.equal(playerLabel("player1", 0), "Player 1");
  assert.equal(playerLabel("white", 1), "White");
  assert.equal(playerLabel(null, 1), "Player 2");
  assert.equal(playerLabel("", 2), "Player 3");
});

// ════════════════════════════════════════════════════════════════════
// 5. Malformed / unsupported payloads
// ════════════════════════════════════════════════════════════════════

test("a malformed report is rejected with errors, not coerced", () => {
  const brokenMetrics = buildGameReportView({
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: "speed-typing",
    analysisType: "performance",
    status: "complete",
    match: { matchId: UUID },
    metrics: [{ key: "wpm", label: "WPM", available: true }], // available with no value
  });
  assert.equal(brokenMetrics.ok, false);
  assert.equal(brokenMetrics.view, null);
  assert.ok(brokenMetrics.errors.some((error) => /value must be a number/.test(error)));
});

test("an unsupported analysis type or a non-object payload is rejected", () => {
  const unsupported = buildGameReportView({
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: "speed-typing",
    analysisType: "vibes",
    status: "complete",
    match: { matchId: UUID },
    metrics: [],
  });
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.errors.some((error) => /analysisType/.test(error)));

  assert.equal(buildGameReportView(null).ok, false);
  assert.equal(buildGameReportView("speed-typing").ok, false);
  assert.equal(buildGameReportView([1, 2, 3]).ok, false);
  assert.equal(buildGameReportView({ pending: true }).ok, false);
});

// ════════════════════════════════════════════════════════════════════
// 6. AI is separate from objective metrics
// ════════════════════════════════════════════════════════════════════

test("an unavailable AI explanation leaves the objective metrics intact", () => {
  const base = analyzeSpeedTypingGame(raceInput());
  const withAiFailure = {
    ...base,
    ai: { available: false, reason: "provider timeout" },
  };

  const result = buildGameReportView(withAiFailure);
  assert.equal(result.ok, true);
  const view = result.view;

  assert.equal(view.ai.available, false);
  assert.equal(view.ai.reason, "provider timeout");
  assert.equal(view.ai.summary, null);
  // The metrics are byte-for-byte what they were without the AI branch.
  const baseView = buildGameReportView(base).view;
  assert.deepEqual(view.metrics, baseView.metrics);
  assert.deepEqual(view.players, baseView.players);
  assert.equal(reportViewHasContent(view), true);
});

test("an available AI summary is carried separately and cannot alter metrics", () => {
  const base = analyzeSpeedTypingGame(raceInput());
  const view = buildGameReportView({
    ...base,
    ai: { available: true, model: "groq", summary: "Nice typing." },
  }).view;
  assert.equal(view.ai.available, true);
  assert.equal(view.ai.summary, "Nice typing.");
  assert.equal(view.ai.reason, null);
  assert.deepEqual(view.metrics, buildGameReportView(base).view.metrics);
});
