/**
 * Memory Grid — engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers
 * in `src/lib/memory-grid/constants.js`. The round configuration
 * (grid sizes / active tiles / memorize windows), the pattern
 * generator, and the reconstruction scorer are the contract every
 * other piece of the match system depends on, so they're tested
 * exhaustively (valid + invalid inputs, edge cases at the
 * boundaries).
 *
 * Run:  node --test tests/memory-grid-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  // Round configuration (best-of-5, growing difficulty + a 6th
  // harder TIEBREAK round dealt on equal totals)
  ROUND_CONFIGS,
  ROUNDS_PER_MATCH,
  TIEBREAK_CONFIG,
  TIEBREAK_ROUND_NUMBER,
  roundConfig,
  // Phases
  PHASES,
  // Per-phase windows
  RECONSTRUCT_TIMER_SECONDS,
  RECONSTRUCT_DEADLINE_MS,
  RESULT_WINDOW_MS,
  // Stake matchmaking
  STAKE_PRESETS,
  MIN_STAKE,
  MAX_STAKE,
  // House fee / payout split (+ the tiebreak-draw fee)
  HOUSE_FEE_PCT,
  WINNER_RATIO,
  HOUSE_RATIO,
  OVERTIME_DRAW_FEE_PCT,
  // State machine
  MATCH_STATUS,
  SUBMIT_STATES,
  TERMINAL_STATES,
  READY_WINDOW_MS,
  FINISHED_GRACE_MS,
  // Advisory-lock namespace
  MEMORY_GRID_LOCK_NAMESPACE,
  // Result constants
  RESULT,
  // Pure helpers under test
  roundWinnerFromScores,
  matchWinnerFromTotals,
  generatePattern,
  activeSet,
  assessReconstruction,
  computeFinalRoundScore,
  speedMultiplierFromCompletion,
  reconstructionStarted,
  reconstructDeadlineFromStart,
  phaseStartedAt,
  computePayout,
  round2,
} from "../src/lib/memory-grid/constants.js";

// Server-only deterministic seed helpers (see src/lib/memory-grid/seeds.js).
import {
  randomHex,
  getServerSeedHash,
  derivePatternSeed,
} from "../src/lib/memory-grid/seeds.js";

// ═══════════════════════════════════════════════════════════════════
// Round configuration (the spec's exact table)
// ═══════════════════════════════════════════════════════════════════

test("a match is exactly 5 rounds with the spec'd grid sizes", () => {
  assert.equal(ROUNDS_PER_MATCH, 5);
  assert.deepEqual(
    ROUND_CONFIGS.map((r) => r.gridSize),
    [3, 4, 4, 5, 5],
  );
});

test("round configs carry the spec'd active-tile counts", () => {
  assert.deepEqual(
    ROUND_CONFIGS.map((r) => r.activeCount),
    [3, 5, 7, 10, 14],
  );
});

test("round configs carry the spec'd memorize durations (ms)", () => {
  assert.deepEqual(
    ROUND_CONFIGS.map((r) => r.memorizeMs),
    [2500, 3000, 3000, 3500, 4000],
  );
});

test("every active count fits inside its grid", () => {
  for (const cfg of ROUND_CONFIGS) {
    assert.ok(
      cfg.activeCount < cfg.gridSize * cfg.gridSize,
      `round ${cfg.roundNumber}: ${cfg.activeCount} active < ${cfg.gridSize * cfg.gridSize} tiles`,
    );
    // Difficulty grows monotonically.
    assert.equal(cfg.roundNumber, ROUND_CONFIGS.indexOf(cfg) + 1);
  }
});

test("roundConfig returns the right config per round and clamps defensively", () => {
  for (let n = 1; n <= 5; n += 1) {
    const cfg = roundConfig(n);
    assert.equal(cfg.roundNumber, n);
    assert.equal(cfg.gridSize, ROUND_CONFIGS[n - 1].gridSize);
  }
  // Out-of-range round numbers clamp to the nearest valid config.
  assert.equal(roundConfig(0).roundNumber, 1);
  assert.equal(roundConfig(undefined).roundNumber, 1);
});

test("TIEBREAK round — a 6th harder round dealt on equal totals", () => {
  assert.equal(TIEBREAK_ROUND_NUMBER, 6);
  // Harder than round 5 on both axes: bigger grid (6×6 vs 5×5) AND
  // a denser pattern (18 of 36 lit vs 14 of 25) in the same 4s
  // memorize window.
  assert.equal(TIEBREAK_CONFIG.gridSize, 6);
  assert.equal(TIEBREAK_CONFIG.activeCount, 18);
  assert.equal(TIEBREAK_CONFIG.memorizeMs, 4000);
  assert.ok(
    TIEBREAK_CONFIG.activeCount < TIEBREAK_CONFIG.gridSize * TIEBREAK_CONFIG.gridSize,
    "tiebreak active count fits inside its grid",
  );
  // roundConfig serves the tiebreak config for round 6 (and clamps
  // anything above it there too — never falls back to round 1).
  const cfg = roundConfig(6);
  assert.equal(cfg.gridSize, 6);
  assert.equal(cfg.activeCount, 18);
  assert.equal(roundConfig(99).roundNumber, TIEBREAK_ROUND_NUMBER);
  assert.equal(roundConfig(99).gridSize, 6);
});

// ═══════════════════════════════════════════════════════════════════
// Phases + windows
// ═══════════════════════════════════════════════════════════════════

test("every round has three phases: memorize + reconstruct + result", () => {
  assert.deepEqual(Object.values(PHASES).sort(), [
    "memorize",
    "reconstruct",
    "result",
  ]);
  // The result phase is the post-submission round-result screen —
  // long enough for both clients to poll the snapshot, short enough
  // that the match keeps moving.
  assert.ok(RESULT_WINDOW_MS >= 3000, "result window is poll-friendly");
  assert.ok(RESULT_WINDOW_MS <= 10000, "result window keeps the match moving");
});

test("timer constants are consistent", () => {
  assert.equal(RECONSTRUCT_TIMER_SECONDS, 15);
  assert.equal(RECONSTRUCT_DEADLINE_MS, 15000);
  assert.equal(READY_WINDOW_MS, 3000);
  assert.equal(FINISHED_GRACE_MS, 5000);
  assert.equal(RESULT_WINDOW_MS, 5000);
});

// ═══════════════════════════════════════════════════════════════════
// generatePattern
// ═══════════════════════════════════════════════════════════════════

test("generatePattern matches the round config for every round", () => {
  for (let n = 1; n <= ROUNDS_PER_MATCH; n += 1) {
    const cfg = roundConfig(n);
    const pattern = generatePattern(n);
    assert.equal(pattern.size, cfg.gridSize, `round ${n} grid size`);
    assert.equal(pattern.total, cfg.gridSize * cfg.gridSize);
    assert.equal(
      pattern.active.length,
      cfg.activeCount,
      `round ${n} active count`,
    );
  }
});

test("generatePattern picks distinct, in-range, sorted tile indices", () => {
  const pattern = generatePattern(5); // 5×5, 14 active
  assert.equal(pattern.active.length, 14);
  const seen = new Set();
  for (const i of pattern.active) {
    assert.ok(Number.isInteger(i));
    assert.ok(i >= 0 && i < pattern.total, `tile ${i} in [0, ${pattern.total})`);
    assert.ok(!seen.has(i), "no duplicate tiles");
    seen.add(i);
  }
  // Sorted (stable, deterministic presentation).
  assert.deepEqual(pattern.active, [...pattern.active].sort((a, b) => a - b));
});

test("generatePattern shuffles (two unseeded draws are not identically ordered)", () => {
  // Extremely unlikely to collide for any grid size — guards against
  // a generator that returns a fixed layout.
  const a = generatePattern(4);
  const b = generatePattern(4);
  const same = a.active.every((i, idx) => i === b.active[idx]);
  assert.equal(same, false);
});

// ═══════════════════════════════════════════════════════════════════
// Deterministic challenge generation (provably-fair seeds)
// ═══════════════════════════════════════════════════════════════════

test("randomHex returns 32 random bytes as hex (64 chars)", () => {
  const a = randomHex(32);
  const b = randomHex(32);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  // Cryptographically random — two draws must differ.
  assert.notEqual(a, b);
});

test("getServerSeedHash is a deterministic 64-char SHA-256 hex", () => {
  const seed = "deadbeef";
  const h1 = getServerSeedHash(seed);
  const h2 = getServerSeedHash(seed);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  assert.match(h1, /^[0-9a-f]{64}$/);
  // Different seeds → different hashes.
  assert.notEqual(getServerSeedHash(seed), getServerSeedHash("beefdead"));
});

test("derivePatternSeed is deterministic and a 32-bit unsigned int", () => {
  const args = { serverSeed: "a1b2c3", matchId: 42, roundNumber: 1 };
  assert.equal(
    derivePatternSeed(args),
    derivePatternSeed({ ...args }),
    "same inputs → same seed",
  );
  const seed = derivePatternSeed(args);
  assert.ok(Number.isInteger(seed));
  assert.ok(seed >= 0 && seed <= 0xffffffff, "seed in uint32 range");
});

test("derivePatternSeed varies across rounds and server seeds", () => {
  const base = { serverSeed: "abc123", matchId: 7 };
  const round1 = derivePatternSeed({ ...base, roundNumber: 1 });
  const round2 = derivePatternSeed({ ...base, roundNumber: 2 });
  const otherSeed = derivePatternSeed({
    serverSeed: "xyz789",
    matchId: 7,
    roundNumber: 1,
  });
  assert.notEqual(round1, round2, "round number changes the seed");
  assert.notEqual(round1, otherSeed, "server seed changes the seed");
});

test("generatePattern with a seed is deterministic — same seed, same pattern", () => {
  const seed = derivePatternSeed({ serverSeed: "abc123", matchId: 7, roundNumber: 3 });
  const a = generatePattern(3, { seed });
  const b = generatePattern(3, { seed });
  assert.deepEqual(a, b, "identical patterns for the same seed");
  // Both players would receive the exact same grid.
  assert.deepEqual(a.active, b.active);
});

test("different seeds produce different patterns", () => {
  const seedA = derivePatternSeed({ serverSeed: "aaaa", matchId: 1, roundNumber: 2 });
  const seedB = derivePatternSeed({ serverSeed: "bbbb", matchId: 1, roundNumber: 2 });
  const a = generatePattern(2, { seed: seedA });
  const b = generatePattern(2, { seed: seedB });
  const same = a.active.every((i, idx) => i === b.active[idx]);
  assert.equal(same, false, "different match seeds → different grids");
});

test("a whole match derives valid, spec-conformant patterns from one server seed", () => {
  const serverSeed = randomHex(32);
  const matchId = 123;
  for (let round = 1; round <= ROUNDS_PER_MATCH; round += 1) {
    const cfg = roundConfig(round);
    const seed = derivePatternSeed({ serverSeed, matchId, roundNumber: round });
    const pattern = generatePattern(round, { seed });
    assert.equal(pattern.size, cfg.gridSize, `round ${round} grid size`);
    assert.equal(pattern.total, cfg.gridSize * cfg.gridSize);
    assert.equal(pattern.active.length, cfg.activeCount, `round ${round} active count`);
    // Distinct, in-range, sorted indices.
    const seen = new Set();
    for (const i of pattern.active) {
      assert.ok(i >= 0 && i < pattern.total);
      assert.ok(!seen.has(i));
      seen.add(i);
    }
    // Determinism across the round — both players see the same grid.
    assert.deepEqual(
      pattern,
      generatePattern(round, { seed }),
      `round ${round} is reproducible`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// activeSet / assessReconstruction (authoritative full-grid scoring)
// ═══════════════════════════════════════════════════════════════════

test("activeSet collects the pattern's active tile indices", () => {
  const pattern = { size: 3, total: 9, active: [1, 4, 7] };
  assert.deepEqual([...activeSet(pattern)].sort((a, b) => a - b), [1, 4, 7]);
});

test("activeSet handles empty / malformed input", () => {
  assert.equal(activeSet(null).size, 0);
  assert.equal(activeSet({}).size, 0);
  assert.equal(activeSet({ active: null }).size, 0);
  assert.equal(activeSet({ active: [0, "2", -1] }).size, 1); // only 0
});

test("assessReconstruction — perfect reconstruction → 100% accuracy", () => {
  const pattern = { size: 3, total: 9, active: [1, 4, 7] };
  const a = assessReconstruction([1, 4, 7], pattern);
  assert.equal(a.total, 9);
  assert.equal(a.hits, 3); // TP
  assert.equal(a.misses, 0); // FN
  assert.equal(a.falsePositives, 0); // FP
  assert.equal(a.correct, 9); // 3 TP + 6 TN
  assert.equal(a.incorrect, 0);
  assert.equal(a.accuracy, 1);
  assert.equal(a.accuracyPct, 100); // accuracyPct IS the Accuracy Score
});

test("assessReconstruction — the spec's example: false positives count as errors", () => {
  // Correct grid (4×4, 6 active — row-major indices):
  //   1 0 1 0
  //   0 1 0 0
  //   1 0 0 1
  //   0 0 1 0
  // → active = [0, 2, 5, 8, 11, 14]
  const pattern = { size: 4, total: 16, active: [0, 2, 5, 8, 11, 14] };
  // Player grid (all 6 active tiles found, PLUS 2 false positives at
  // indices 3 and 9):
  //   1 0 1 1
  //   0 1 0 0
  //   1 1 0 1
  //   0 0 1 0
  const picks = [0, 2, 3, 5, 8, 9, 11, 14];
  const a = assessReconstruction(picks, pattern);
  assert.equal(a.total, 16);
  assert.equal(a.hits, 6); // every active tile found
  assert.equal(a.misses, 0);
  assert.equal(a.falsePositives, 2); // tiles 3 and 9 wrongly picked
  assert.equal(a.correct, 14); // 6 TP + 8 TN
  assert.equal(a.incorrect, 2); // 2 FP + 0 FN
  assert.equal(a.accuracy, 14 / 16);
  assert.equal(a.accuracyPct, 87.5); // 87.5 Accuracy Score before speed
});

test("selecting every tile can never score high — false positives dominate accuracy", () => {
  // Round 1 (3×3, 3 active): picking all 9 tiles = 3 TP + 0 TN →
  // 33.3% accuracy.
  const r1 = { size: 3, total: 9, active: [0, 4, 8] };
  const a1 = assessReconstruction([0, 1, 2, 3, 4, 5, 6, 7, 8], r1);
  assert.equal(a1.hits, 3);
  assert.equal(a1.falsePositives, 6);
  assert.equal(a1.correct, 3);
  assert.equal(a1.incorrect, 6);
  assert.equal(a1.accuracyPct, 33.3);
  // The final score is the exact accuracy percentage; speed does not
  // increase it.
  assert.equal(
    computeFinalRoundScore({ accuracy: a1.accuracy, completionTimeMs: 0, windowMs: 15000, pickedCount: 9 }),
    33.3,
  );

  // Round 5 (5×5, 14 active): picking all 25 tiles = 14 TP + 0 TN →
  // 56% accuracy — far below 100, and below what a real attempt earns.
  const r5 = { size: 5, total: 25, active: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] };
  const a5 = assessReconstruction(Array.from({ length: 25 }, (_, i) => i), r5);
  assert.equal(a5.correct, 14);
  assert.equal(a5.incorrect, 11);
  assert.equal(a5.accuracyPct, 56);
  const spamScore = computeFinalRoundScore({
    accuracy: a5.accuracy,
    completionTimeMs: 0,
    windowMs: 15000,
    pickedCount: 25,
  });
  assert.equal(spamScore, 56, "all-tiles spam scores its exact accuracy");
});

test("empty reconstruction → true-negative accuracy, but final score 0 (no free points)", () => {
  const pattern = { size: 3, total: 9, active: [1, 4, 7] };
  const a = assessReconstruction([], pattern);
  assert.equal(a.correct, 6); // 6 TN only
  assert.equal(a.incorrect, 3); // 3 FN
  assert.ok(Math.abs(a.accuracy - 6 / 9) < 1e-9);
  assert.equal(a.accuracyPct, 66.7);
  // An EMPTY submission (AFK auto-lock) is guarded to 0 via
  // pickedCount rather than receiving true-negative points.
  assert.equal(
    computeFinalRoundScore({ accuracy: a.accuracy, completionTimeMs: 1000, windowMs: 15000, pickedCount: 0 }),
    0,
  );
  // A real submission with the same accuracy gets exactly 66.7 points,
  // regardless of how quickly it was submitted.
  assert.equal(
    computeFinalRoundScore({ accuracy: a.accuracy, completionTimeMs: 1000, windowMs: 15000, pickedCount: 3 }),
    66.7,
  );
});

test("missed active tiles (false negatives) cost accuracy", () => {
  const pattern = { size: 4, total: 16, active: [0, 2, 5, 8, 11, 14] };
  // Only 3 of the 6 active tiles remembered, nothing else picked.
  const a = assessReconstruction([0, 2, 5], pattern);
  assert.equal(a.hits, 3);
  assert.equal(a.misses, 3);
  assert.equal(a.falsePositives, 0);
  assert.equal(a.correct, 13); // 3 TP + 10 TN
  assert.equal(a.incorrect, 3); // 3 FN
  assert.equal(a.accuracy, 13 / 16);
});

test("assessReconstruction ignores out-of-range / duplicate picks", () => {
  const pattern = { size: 3, total: 9, active: [1, 4, 7] };
  // Duplicates are irrelevant (a tile is picked or not); out-of-range
  // and negative indices are not real cells and never count as errors.
  const a = assessReconstruction([1, 1, 4, 99, -1], pattern);
  assert.equal(a.hits, 2);
  assert.equal(a.falsePositives, 0);
  assert.equal(a.correct, 8); // 2 TP + 6 TN
  assert.equal(a.incorrect, 1); // 1 FN
  const b = assessReconstruction([1, 99], pattern);
  assert.equal(b.hits, 1);
  assert.equal(b.falsePositives, 0);
  assert.equal(b.correct, 7); // 1 TP + 6 TN
  assert.equal(b.incorrect, 2); // 2 FN
});

test("assessReconstruction handles malformed input", () => {
  assert.deepEqual(assessReconstruction(null, null), {
    total: 0,
    hits: 0,
    misses: 0,
    falsePositives: 0,
    correct: 0,
    incorrect: 0,
    accuracy: 0,
    accuracyPct: 0,
  });
  assert.equal(assessReconstruction("nope", { active: [] }).accuracyPct, 0);
  assert.equal(assessReconstruction([1], null).accuracyPct, 0);
});

// ═══════════════════════════════════════════════════════════════════
// speedMultiplierFromCompletion / computeFinalRoundScore
// (accuracy-dominant, max 100 per round)
// ═══════════════════════════════════════════════════════════════════

test("speed tiers map completion-time fractions to the spec'd multipliers", () => {
  const W = 15000; // 15s reconstruct window
  const tier = (ms) => speedMultiplierFromCompletion(ms, W).tier;
  const mult = (ms) => speedMultiplierFromCompletion(ms, W).multiplier;

  assert.equal(tier(0), "very_fast");
  assert.equal(mult(0), 1.2); // up to +20%
  assert.equal(tier(W * 0.25), "very_fast"); // ≤ 25% of the window
  assert.equal(tier(W * 0.25 + 1), "fast");
  assert.equal(mult(W * 0.5), 1.15); // ≤ 50% → +15%
  assert.equal(tier(W * 0.75), "average");
  assert.equal(mult(W * 0.75), 1.1); // ≤ 75% → +10%
  assert.equal(tier(W * 0.99), "slow");
  assert.equal(mult(W * 0.99), 1.05); // < 100% → +5%
  assert.equal(tier(W), "very_slow"); // exactly at the deadline
  assert.equal(mult(W * 2), 1.0); // ≥ 100% → +0%
  // Unknown window / elapsed → no bonus.
  assert.equal(speedMultiplierFromCompletion(1000, 0).multiplier, 1);
  assert.equal(speedMultiplierFromCompletion(Number.NaN, W).multiplier, 1);
});

test("final score equals exact accuracy, clamped to [0, 100] for every round", () => {
  const W = 15000;
  const score = (accuracy, ms, picked) =>
    computeFinalRoundScore({ accuracy, completionTimeMs: ms, windowMs: W, pickedCount: picked });

  // Perfect accuracy caps at 100 regardless of speed.
  assert.equal(score(1, 0, 6), 100);
  assert.equal(score(1, W, 6), 100);
  // Speed no longer changes the score: 90% is always 90, and 80% is
  // always 80.
  assert.equal(score(0.9, 0, 6), 90);
  assert.equal(score(0.9, W, 6), 90);
  assert.equal(score(0.8, 0, 6), 80);
  // 0 accuracy → 0 no matter how fast.
  assert.equal(score(0, 0, 6), 0);
  // The function has NO round parameter — same 0..100 scale everywhere.
});

test("speed never changes the exact accuracy score", () => {
  const W = 15000;
  const fast75 = computeFinalRoundScore({ accuracy: 0.75, completionTimeMs: 0, windowMs: W, pickedCount: 6 });
  const slow75 = computeFinalRoundScore({ accuracy: 0.75, completionTimeMs: W, windowMs: W, pickedCount: 6 });
  assert.equal(fast75, 75);
  assert.equal(slow75, 75);
  const fast85 = computeFinalRoundScore({ accuracy: 0.85, completionTimeMs: 0, windowMs: W, pickedCount: 6 });
  assert.equal(fast85, 85);
});

// ═══════════════════════════════════════════════════════════════════
// Authoritative phase timing (server-authoritative + synchronized)
// ═══════════════════════════════════════════════════════════════════

test("reconstructionStarted — submissions legal only after the official reconstruct start", () => {
  const now = 1_700_000_000_000;
  // During reconstruct: legal.
  assert.equal(
    reconstructionStarted({ phase: "reconstruct", deadlineMs: now, nowMs: now }),
    true,
  );
  // During memorize BEFORE the deadline: NOT legal — the pattern is
  // still being revealed, you can't lock a reconstruction early.
  assert.equal(
    reconstructionStarted({ phase: "memorize", deadlineMs: now + 5000, nowMs: now }),
    false,
  );
  // During memorize AT / after the deadline: legal — the pattern-hide
  // instant is the authoritative reconstruct start.
  assert.equal(
    reconstructionStarted({ phase: "memorize", deadlineMs: now, nowMs: now }),
    true,
  );
  assert.equal(
    reconstructionStarted({ phase: "memorize", deadlineMs: now, nowMs: now + 1 }),
    true,
  );
  // No phase / malformed deadline → not legal.
  assert.equal(reconstructionStarted({ phase: null, deadlineMs: now, nowMs: now }), false);
  assert.equal(reconstructionStarted({ phase: "memorize", deadlineMs: null, nowMs: now }), false);
  assert.equal(reconstructionStarted({ phase: "ready", deadlineMs: now, nowMs: now }), false);
});

test("reconstructDeadlineFromStart anchors the window on the authoritative start", () => {
  const start = 1_700_000_000_000;
  assert.equal(reconstructDeadlineFromStart(start, 15000).getTime(), start + 15000);
  // Non-finite window falls back to the default reconstruct window.
  assert.equal(reconstructDeadlineFromStart(start, 0).getTime(), start + 15000);
  assert.equal(reconstructDeadlineFromStart(start, null).getTime(), start + 15000);
  // Non-finite start → null (no deadline can be derived).
  assert.equal(reconstructDeadlineFromStart(null, 15000), null);
  assert.equal(reconstructDeadlineFromStart(Number.NaN, 15000), null);
});

test("phaseStartedAt derives the synchronized phase start from the deadline", () => {
  const deadline = 1_700_000_000_000;
  assert.equal(
    phaseStartedAt({ phase: "memorize", roundDeadlineMs: deadline, phaseDurationMs: 2500 }),
    new Date(deadline - 2500).toISOString(),
  );
  assert.equal(
    phaseStartedAt({ phase: "reconstruct", roundDeadlineMs: deadline, phaseDurationMs: 15000 }),
    new Date(deadline - 15000).toISOString(),
  );
  // No live phase / missing info → null.
  assert.equal(phaseStartedAt({ phase: null, roundDeadlineMs: deadline, phaseDurationMs: 2500 }), null);
  assert.equal(phaseStartedAt({ phase: "memorize", roundDeadlineMs: null, phaseDurationMs: 2500 }), null);
  assert.equal(phaseStartedAt({ phase: "memorize", roundDeadlineMs: deadline, phaseDurationMs: null }), null);
});

// ═══════════════════════════════════════════════════════════════════
// roundWinnerFromScores (per-round winner)
// ═══════════════════════════════════════════════════════════════════

test("roundWinnerFromScores — higher round score wins the round", () => {
  assert.equal(roundWinnerFromScores(3, 2), RESULT.PLAYER1);
  assert.equal(roundWinnerFromScores(2, 3), RESULT.PLAYER2);
});

test("roundWinnerFromScores — equal round scores is a draw", () => {
  assert.equal(roundWinnerFromScores(4, 4), RESULT.DRAW);
  assert.equal(roundWinnerFromScores(0, 0), RESULT.DRAW);
});

test("roundWinnerFromScores coerces missing/null scores to 0", () => {
  assert.equal(roundWinnerFromScores(undefined, 1), RESULT.PLAYER2);
  assert.equal(roundWinnerFromScores(null, null), RESULT.DRAW);
});

test("matchWinnerFromTotals — the higher TOTAL cumulative score wins the match", () => {
  // Example from the prompt: A 247 vs B 231 → A wins.
  assert.equal(matchWinnerFromTotals(247, 231), RESULT.PLAYER1);
  assert.equal(matchWinnerFromTotals(231, 247), RESULT.PLAYER2);
  // Rounds-won is IRRELEVANT to the match result — totals decide.
  assert.equal(matchWinnerFromTotals(0, 0), RESULT.DRAW);
});

test("matchWinnerFromTotals — exactly equal totals is a DRAW (existing PvP tie pattern, no invented winner)", () => {
  assert.equal(matchWinnerFromTotals(500, 500), RESULT.DRAW);
  assert.equal(matchWinnerFromTotals(247, 247), RESULT.DRAW);
  assert.equal(matchWinnerFromTotals(0, 0), RESULT.DRAW);
  // Missing/null totals coerce to 0 → draw, never a random winner.
  assert.equal(matchWinnerFromTotals(undefined, undefined), RESULT.DRAW);
  assert.equal(matchWinnerFromTotals(null, 10), RESULT.PLAYER2);
  assert.equal(matchWinnerFromTotals("247", "231"), RESULT.PLAYER1);
});

// ═══════════════════════════════════════════════════════════════════
// computePayout (90/10 split, mirroring Mines Duel)
// ═══════════════════════════════════════════════════════════════════

test("computePayout — player1 wins: winner takes 1.9×, house 0.1×", () => {
  const p = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(p.stake, 100);
  assert.equal(p.winnerNet, 190);
  assert.equal(p.loserNet, -100);
  assert.equal(p.houseFee, 10);
  assert.equal(p.prizePaid, 190);
});

test("computePayout — player2 wins mirrors player1", () => {
  const p = computePayout({ stakeAmount: 50, result: RESULT.PLAYER2 });
  assert.equal(p.winnerNet, 95);
  assert.equal(p.loserNet, -50);
  assert.equal(p.houseFee, 5);
  assert.equal(p.prizePaid, 95);
});

test("computePayout — draw refunds both, no fee", () => {
  const p = computePayout({ stakeAmount: 100, result: RESULT.DRAW });
  assert.equal(p.winnerNet, null);
  assert.equal(p.loserNet, null);
  assert.equal(p.houseFee, 0);
  assert.equal(p.prizePaid, 0);
  assert.equal(p.refundEach, 100);
});

test("computePayout — TIEBREAK draw takes 5% of each player's wager", () => {
  // Equal totals after the 6th round → each player keeps 95% of
  // their stake; the house takes 5% per side (10% of the pot).
  const p = computePayout({
    stakeAmount: 100,
    result: RESULT.DRAW,
    drawFeePct: OVERTIME_DRAW_FEE_PCT,
  });
  assert.equal(p.refundEach, 95);
  assert.equal(p.houseFee, 10);
  assert.equal(p.winnerNet, null);
  assert.equal(p.prizePaid, 0);
  // Rounded to 2dp on odd stakes (mirrors keno-pvp's overtime fee).
  const odd = computePayout({
    stakeAmount: 40,
    result: RESULT.DRAW,
    drawFeePct: 0.05,
  });
  assert.equal(odd.refundEach, 38);
  assert.equal(odd.houseFee, 4);
  // Winning payouts ignore the draw fee entirely.
  const win = computePayout({
    stakeAmount: 100,
    result: RESULT.PLAYER1,
    drawFeePct: 0.05,
  });
  assert.equal(win.winnerNet, 190);
  assert.equal(win.houseFee, 10);
  assert.equal(win.refundEach, null);
});

test("computePayout — rounding to 2dp", () => {
  const p = computePayout({ stakeAmount: 33.33, result: RESULT.PLAYER1 });
  assert.equal(p.winnerNet, 63.33); // 33.33 + 29.997 → 63.33
  assert.equal(p.houseFee, 3.33);
});

test("computePayout rejects invalid inputs", () => {
  assert.throws(() =>
    computePayout({ stakeAmount: -1, result: RESULT.PLAYER1 }),
  );
  assert.throws(() => computePayout({ stakeAmount: 10, result: "banana" }));
  assert.throws(() => computePayout({ stakeAmount: 10, result: null }));
  // drawFeePct must be in [0, 1].
  assert.throws(() =>
    computePayout({
      stakeAmount: 100,
      result: RESULT.DRAW,
      drawFeePct: 1.5,
    }),
  );
  assert.throws(() =>
    computePayout({
      stakeAmount: 100,
      result: RESULT.DRAW,
      drawFeePct: -0.1,
    }),
  );
});

// ═══════════════════════════════════════════════════════════════════
// Constants sanity
// ═══════════════════════════════════════════════════════════════════

test("status enum matches the schema values (simultaneous play — no turns)", () => {
  assert.deepEqual(Object.values(MATCH_STATUS).sort(), [
    "active",
    "cancelled",
    "finished",
    "ready",
    "waiting",
  ]);
});

test("SUBMIT_STATES is exactly the simultaneous active state", () => {
  assert.deepEqual([...SUBMIT_STATES].sort(), [MATCH_STATUS.ACTIVE]);
});

test("stake presets / limits are in the expected range", () => {
  assert.ok(STAKE_PRESETS.length >= 4);
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 1000000);
  for (const s of STAKE_PRESETS) {
    assert.ok(s >= MIN_STAKE && s <= MAX_STAKE);
  }
});

test("house split constants sum to the loser's stake", () => {
  assert.equal(WINNER_RATIO + HOUSE_RATIO, 1);
  assert.equal(HOUSE_FEE_PCT, 0.1);
});

test("advisory-lock namespace is a positive 32-bit int", () => {
  assert.ok(MEMORY_GRID_LOCK_NAMESPACE > 0);
  assert.ok(MEMORY_GRID_LOCK_NAMESPACE <= 0x7fffffff);
});

test("round2 rounds correctly", () => {
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(3.33333), 3.33);
  assert.equal(round2(0), 0);
  assert.equal(round2("12.50"), 12.5);
  assert.equal(round2(Number.NaN), 0);
});
