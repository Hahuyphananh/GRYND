/**
 * Speed Typing performance evaluator
 * (src/lib/evaluation/games/speedTypingEvaluator.ts).
 *
 * Speed Typing is a PERFORMANCE report: there is nothing to search, so the
 * report is exact arithmetic over server-derived counts and server instants.
 * These tests pin:
 *
 *   1. The formulas, directly and against independently computed expectations.
 *   2. That a non-finisher gets NO fabricated wpm/completion time, while their
 *      accuracy and progress (which ARE grounded in raw counts) are reported.
 *   3. Every edge case: zero duration, missing timestamps, empty/malformed race
 *      state, counters that disagree with the mirror, counts beyond the passage,
 *      a frozen aggregate that disagrees with recomputation, and an unresolvable
 *      passage — none may throw or produce NaN/Infinity.
 *   4. That the report is a `performance` report: no moves, no engine, no rounds.
 *   5. The registry adapter, so a lobby key alone can never make a game eligible.
 *
 * Run: npm run test:speed-typing-evaluation
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  accuracyPercentFor,
  analyzeSpeedTypingGame,
  correctCharsFor,
  evaluateSpeedTypingMatch,
  wpmFor,
} from "../src/lib/evaluation/games/speedTypingEvaluator.ts";
import { PASSAGE_VERSION, passageById } from "../src/lib/speed-typing/passages.ts";
import { parseGameReportV1 } from "../src/lib/evaluation/gameReport.ts";
import {
  getEvaluationAnalyzer,
  getSupportedEvaluationGames,
  isEvaluationSupported,
} from "../src/lib/evaluation/registry.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const P1 = "user_p1";
const P2 = "user_p2";

const PASSAGE = passageById("pt-02", PASSAGE_VERSION);
const L = PASSAGE.charCount; // passage length, derived by the catalog itself

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

/**
 * A finished, consistent match. `player1` completes the passage with 2 errors in
 * 30 s; `player2` reaches 100 characters with 5 errors and never finishes.
 */
function buildMatch(overrides = {}) {
  const goAtMs = Date.parse("2026-01-01T12:00:00.000Z");
  const p1 = seat({
    charsTyped: L,
    errors: 2,
    finished: true,
    finishedAtMs: goAtMs + 30_000,
    elapsedMs: 30_000,
    wpm: wpmFor(L - 2, 30_000),
    accuracy: accuracyPercentFor(L - 2, L),
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
  const seats = { ...base.seats, ...(overrides.seats ?? {}) };
  // The mirror is DERIVED from the seats by default (they are the same numbers
  // in production); a test that wants an inconsistency overrides it explicitly.
  const mirror = {
    player1CharsTyped: seats.player1.charsTyped,
    player1Errors: seats.player1.errors,
    player2CharsTyped: seats.player2.charsTyped,
    player2Errors: seats.player2.errors,
    ...(overrides.mirror ?? {}),
  };
  return { ...base, ...overrides, seats, mirror };
}

function metricOf(report, key, role = null) {
  const source = role
    ? report.players.find((p) => p.role === role).metrics
    : report.metrics;
  return source.find((m) => m.key === key);
}

function valueOf(report, key, role = null) {
  const m = metricOf(report, key, role);
  assert.ok(m, `metric ${key} (${role ?? "match"}) must exist`);
  assert.equal(m.available, true, `metric ${key} should be available`);
  return m.value;
}

// ════════════════════════════════════════════════════════════════════
// 1. Formulas
// ════════════════════════════════════════════════════════════════════

test("the formulas are defined once and never divide by zero", () => {
  assert.equal(correctCharsFor(10, 3), 7);
  assert.equal(correctCharsFor(3, 10), 0, "errors can never make correct negative");
  assert.equal(accuracyPercentFor(95, 100), 95);
  assert.equal(accuracyPercentFor(0, 0), null, "0 typed is undefined, not 0%");
  assert.equal(wpmFor(50, 60_000), 10); // 50/5 = 10 words in one minute
  assert.equal(wpmFor(50, 0), null, "zero duration must not divide by zero");
  assert.equal(wpmFor(50, null), null);
});

// ════════════════════════════════════════════════════════════════════
// 2. A known result
// ════════════════════════════════════════════════════════════════════

test("a known result is reported as a performance report with exact metrics", () => {
  const report = analyzeSpeedTypingGame(buildMatch());

  assert.equal(parseGameReportV1(report).ok, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.gameKey, "speed-typing");
  assert.equal(report.analysisType, "performance");
  assert.equal(report.status, "complete");
  // A performance report has no move-by-move data and no engine.
  assert.equal(report.moves, undefined);
  assert.equal(report.rounds, undefined);
  assert.equal(report.engine, null);
  assert.equal(report.ai, null);

  // Match-level facts.
  assert.equal(valueOf(report, "passageLength"), L);
  assert.equal(valueOf(report, "winnerSeat"), "player1");
  assert.equal(valueOf(report, "resolutionReason"), "finish");
  assert.equal(valueOf(report, "raceDurationMs"), 30_000);

  // Player 1 finished: wpm / accuracy / completion time, independently computed.
  const correct1 = L - 2;
  const expectedWpm1 = Math.round(correct1 / 5 / (30_000 / 60_000));
  const expectedAccuracy1 = Math.round((correct1 / L) * 100);
  assert.equal(valueOf(report, "charsTyped", "player1"), L);
  assert.equal(valueOf(report, "errors", "player1"), 2);
  assert.equal(valueOf(report, "correctChars", "player1"), correct1);
  assert.equal(valueOf(report, "accuracyPercent", "player1"), expectedAccuracy1);
  assert.equal(valueOf(report, "completionTimeMs", "player1"), 30_000);
  assert.equal(valueOf(report, "wpm", "player1"), expectedWpm1);
  assert.equal(valueOf(report, "outcome", "player1"), "win");
  assert.equal(valueOf(report, "outcome", "player2"), "loss");
});

test("a non-finisher gets groundable metrics only — no fabricated wpm or time", () => {
  const report = analyzeSpeedTypingGame(buildMatch());

  // Raw counts and accuracy ARE grounded in server-derived numbers.
  assert.equal(valueOf(report, "charsTyped", "player2"), 100);
  assert.equal(valueOf(report, "errors", "player2"), 5);
  assert.equal(valueOf(report, "correctChars", "player2"), 95);
  assert.equal(valueOf(report, "accuracyPercent", "player2"), 95);
  assert.equal(valueOf(report, "progressPercent", "player2"), Math.round((100 / L) * 100));

  // ...but a words-per-minute and a completion time for someone who never
  // completed the passage would be invented skill numbers, so they are absent.
  for (const key of ["wpm", "completionTimeMs"]) {
    const m = metricOf(report, key, "player2");
    assert.equal(m.available, false, `${key} must be unavailable for a non-finisher`);
    assert.match(m.reason, /did not complete/i);
  }
});

test("the formula is named in the metric label", () => {
  const report = analyzeSpeedTypingGame(buildMatch());
  assert.match(metricOf(report, "wpm", "player1").label, /correct chars ÷ 5/i);
  assert.match(metricOf(report, "accuracyPercent", "player1").label, /÷ typed chars/i);
});

test("a draw reports both seats as a draw", () => {
  const goAtMs = Date.parse("2026-01-01T12:00:00.000Z");
  const tied = buildMatch({
    result: "tie",
    winnerId: null,
    resolutionReason: "draw",
    seats: {
      player1: seat({ charsTyped: 50, errors: 1 }),
      player2: seat({ charsTyped: 50, errors: 1 }),
    },
  });
  const report = analyzeSpeedTypingGame(tied);
  assert.equal(report.status, "complete");
  assert.equal(valueOf(report, "winnerSeat"), "tie");
  assert.equal(valueOf(report, "outcome", "player1"), "draw");
  assert.equal(valueOf(report, "outcome", "player2"), "draw");
  assert.equal(valueOf(report, "isPractice"), false);
  assert.ok(goAtMs);
});

// ════════════════════════════════════════════════════════════════════
// 3. Edge cases — none may throw or produce NaN/Infinity
// ════════════════════════════════════════════════════════════════════

function assertAllMetricsFinite(report) {
  const all = [
    ...report.metrics,
    ...report.players.flatMap((p) => p.metrics),
  ];
  for (const m of all) {
    if (!m.available) continue;
    if (typeof m.value === "number") {
      assert.ok(Number.isFinite(m.value), `${m.key} must be finite (got ${m.value})`);
    }
  }
}

test("a zero-duration finish yields a real 0ms time and an unavailable wpm", () => {
  const goAtMs = Date.parse("2026-01-01T12:00:00.000Z");
  const report = analyzeSpeedTypingGame(
    buildMatch({
      seats: {
        player1: seat({
          charsTyped: L,
          errors: 0,
          finished: true,
          finishedAtMs: goAtMs,
          elapsedMs: 0,
          wpm: null,
          accuracy: 100,
        }),
      },
    }),
  );
  assert.equal(report.status, "complete");
  // The completion time is a genuine zero, distinct from "missing".
  assert.equal(valueOf(report, "completionTimeMs", "player1"), 0);
  const wpm = metricOf(report, "wpm", "player1");
  assert.equal(wpm.available, false);
  assert.match(wpm.reason, /duration/i);
  assertAllMetricsFinite(report);
});

test("missing server instants degrade time metrics, never the counts", () => {
  const report = analyzeSpeedTypingGame(buildMatch({ goAtMs: null, resolvedAtMs: null }));
  assert.equal(report.status, "complete");
  for (const key of ["raceDurationMs"]) {
    assert.equal(metricOf(report, key).available, false);
  }
  for (const key of ["completionTimeMs", "wpm"]) {
    assert.equal(metricOf(report, key, "player1").available, false);
  }
  // Counts and accuracy are unaffected by a missing clock.
  assert.equal(valueOf(report, "charsTyped", "player1"), L);
  assert.equal(valueOf(report, "accuracyPercent", "player1"), Math.round(((L - 2) / L) * 100));
  assertAllMetricsFinite(report);
});

test("an empty/malformed race state yields zeros, safely", () => {
  const report = analyzeSpeedTypingGame(
    buildMatch({
      seats: { player1: seat(), player2: seat() },
    }),
  );
  assert.equal(report.status, "complete");
  assert.equal(valueOf(report, "charsTyped", "player1"), 0);
  assert.equal(valueOf(report, "errors", "player1"), 0);
  assert.equal(valueOf(report, "correctChars", "player1"), 0);
  assert.equal(valueOf(report, "progressPercent", "player1"), 0);
  // Accuracy at zero characters typed is undefined, not 0%.
  assert.equal(metricOf(report, "accuracyPercent", "player1").available, false);
  assertAllMetricsFinite(report);
});

test("counters that disagree with the mirror are rejected, not reconciled", () => {
  const report = analyzeSpeedTypingGame(
    buildMatch({ mirror: { player1CharsTyped: 123 } }),
  );
  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "inconsistent_counters");
  assert.equal(report.metrics.length, 0);
});

test("counts beyond the passage length are rejected", () => {
  const report = analyzeSpeedTypingGame(
    buildMatch({
      seats: { player1: seat({ charsTyped: L + 1, errors: 0 }) },
      mirror: { player1CharsTyped: L + 1 },
    }),
  );
  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "inconsistent_counters");
});

test("a frozen aggregate that disagrees with recomputation is rejected", () => {
  const goAtMs = Date.parse("2026-01-01T12:00:00.000Z");
  const report = analyzeSpeedTypingGame(
    buildMatch({
      seats: {
        player1: seat({
          charsTyped: L,
          errors: 2,
          finished: true,
          finishedAtMs: goAtMs + 30_000,
          elapsedMs: 999_999, // contradicts finishedAt − goAt
          wpm: wpmFor(L - 2, 30_000),
          accuracy: accuracyPercentFor(L - 2, L),
        }),
      },
    }),
  );
  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "inconsistent_counters");
});

test("an unresolvable passage is reported, not guessed", () => {
  const report = analyzeSpeedTypingGame(buildMatch({ passageCharCount: null }));
  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "passage_unavailable");
  assert.equal(report.metrics.length, 0);
});

test("an unfinished match is not evaluable", () => {
  const report = analyzeSpeedTypingGame(buildMatch({ status: "playing" }));
  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "match_not_finished");
});

test("evaluation is deterministic — the same match yields the same report", () => {
  const input = buildMatch();
  assert.deepEqual(analyzeSpeedTypingGame(input), analyzeSpeedTypingGame(input));
});

test("a non-uuid match id never reaches the database and reports not-found", async () => {
  const report = await evaluateSpeedTypingMatch("not-a-uuid");
  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "game_not_found");
});

// ════════════════════════════════════════════════════════════════════
// 4. Registry eligibility
// ════════════════════════════════════════════════════════════════════

test("speed-typing is registered as a performance analyzer", () => {
  assert.ok(getSupportedEvaluationGames().includes("speed-typing"));
  assert.equal(isEvaluationSupported("speed-typing"), true);
  const analyzer = getEvaluationAnalyzer("speed-typing");
  assert.equal(analyzer.analysisType, "performance");
  assert.ok(analyzer.requires.some((source) => /speed_typing_matches/.test(source)));
  assert.equal(analyzer.validateInput(UUID).ok, true);
  assert.equal(analyzer.validateInput("nope").ok, false);
});

test("the adapter re-frames a report without inventing anything", () => {
  const analyzer = getEvaluationAnalyzer("speed-typing");
  const report = analyzeSpeedTypingGame(buildMatch());
  assert.deepEqual(analyzer.toGameReport(report), report);
  assert.equal(analyzer.toGameReport({ gameKey: "speed-typing" }), null);
});
