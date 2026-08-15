/**
 * PvP Keno ("Keno Catch Duel") — engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers
 * in `src/lib/keno-pvp/constants.js` and `src/lib/keno-pvp/engine.js`.
 * The shared-draw generation, the tile glow schedule, the binary
 * catch grading (in the 0.5s glow window or not), the keno-multiplier
 * round scoring and the round/match decision rules are the contract
 * every other piece of the match system depends on, so they're tested
 * exhaustively (valid + invalid inputs, boundaries, determinism).
 *
 * The engine imports the keno multiplier table from
 * `src/lib/kenoMultipliers.ts` (TypeScript), so this suite runs with
 * the tsx loader, mirroring `test:reports`.
 *
 * Run:  node --import tsx --test tests/keno-pvp-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MATCH_STATUS,
  ACTIVE_STATES,
  ROUND_STATES,
  TERMINAL_STATES,
  MAX_ROUNDS,
  ROUNDS_TO_WIN,
  BALL_COUNT,
  BALL_INTERVAL_MS,
  CATCH_GRACE_MS,
  GLOW_MS,
  KENO_POOL_SIZE,
  ROUND_MS,
  ROUND_TIMER_SECONDS,
  READY_WINDOW_MS,
  FINISHED_GRACE_MS,
  HOUSE_FEE_PCT,
  WINNER_RATIO,
  HOUSE_RATIO,
  STAKE_PRESETS,
  MIN_STAKE,
  MAX_STAKE,
  KENO_PVP_LOCK_NAMESPACE,
  RESULT,
  computePayout,
  round2,
  pickPositiveInt,
  statusForRoundNumber,
  roundNumberForStatus,
  isRoundStatus,
} from "../src/lib/keno-pvp/constants.js";

import {
  CATCH_QUALITY,
  ballSchedule,
  botCatchesForElapsed,
  computeRoundStats,
  decideMatchResult,
  decideRoundWinner,
  generateDraw,
  gradeCatch,
} from "../src/lib/keno-pvp/engine.js";

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

test("status enum matches the keno_pvp_status pgEnum (migration 0061)", () => {
  assert.deepEqual(Object.values(MATCH_STATUS), [
    "waiting",
    "ready",
    "round_1",
    "round_2",
    "round_3",
    "round_4",
    "round_5",
    "finished",
    "cancelled",
  ]);
});

test("state sets partition the status machine correctly", () => {
  assert.equal(ACTIVE_STATES.size, 6); // ready + 5 rounds
  assert.equal(ROUND_STATES.size, 5);
  assert.equal(TERMINAL_STATES.size, 2);
  for (const s of ROUND_STATES) assert.ok(ACTIVE_STATES.has(s));
  for (const s of TERMINAL_STATES) assert.ok(!ACTIVE_STATES.has(s));
});

test("a match is best-of-5 with 3 round-wins needed", () => {
  assert.equal(MAX_ROUNDS, 5);
  assert.equal(ROUNDS_TO_WIN, 3);
});

test("statusForRoundNumber maps 1..5 → round_N and clamps out-of-range", () => {
  assert.equal(statusForRoundNumber(1), MATCH_STATUS.ROUND_1);
  assert.equal(statusForRoundNumber(3), MATCH_STATUS.ROUND_3);
  assert.equal(statusForRoundNumber(5), MATCH_STATUS.ROUND_5);
  assert.equal(statusForRoundNumber(0), MATCH_STATUS.ROUND_1); // clamps low
  assert.equal(statusForRoundNumber(99), MATCH_STATUS.ROUND_5); // clamps high
  assert.equal(statusForRoundNumber(undefined), MATCH_STATUS.ROUND_1);
});

test("roundNumberForStatus round-trips round_N and rejects other states", () => {
  assert.equal(roundNumberForStatus(MATCH_STATUS.ROUND_1), 1);
  assert.equal(roundNumberForStatus(MATCH_STATUS.ROUND_4), 4);
  assert.equal(roundNumberForStatus(MATCH_STATUS.ROUND_5), 5);
  assert.equal(roundNumberForStatus(MATCH_STATUS.ROUND_6), null); // beyond MAX_ROUNDS
  assert.equal(roundNumberForStatus(MATCH_STATUS.READY), null);
  assert.equal(roundNumberForStatus(MATCH_STATUS.FINISHED), null);
  assert.equal(isRoundStatus(MATCH_STATUS.ROUND_2), true);
  assert.equal(isRoundStatus(MATCH_STATUS.READY), false);
  assert.equal(isRoundStatus(MATCH_STATUS.CANCELLED), false);
});

test("stake + house-fee constants match the standard 90/10 split", () => {
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 1000000);
  assert.ok(STAKE_PRESETS.length > 0);
  assert.equal(HOUSE_FEE_PCT, 0.1);
  assert.equal(WINNER_RATIO, 0.9);
  assert.equal(HOUSE_RATIO, 0.1);
  assert.equal(typeof KENO_PVP_LOCK_NAMESPACE, "number");
  assert.ok(KENO_PVP_LOCK_NAMESPACE > 0);
  assert.deepEqual(Object.values(RESULT), ["player1", "player2", "draw"]);
});

test("round timing: 10 tiles each glowing 0.5s, spaced 1.4s apart, ≈ 13.1s round", () => {
  assert.equal(BALL_COUNT, 10);
  assert.equal(KENO_POOL_SIZE, 40);
  // The LAST tile stops glowing exactly at the round deadline.
  assert.equal(ROUND_MS, GLOW_MS + (BALL_COUNT - 1) * BALL_INTERVAL_MS);
  assert.equal(ROUND_MS, 13100);
  assert.equal(ROUND_TIMER_SECONDS, 14); // ceil(ROUND_MS / 1000)
  assert.equal(GLOW_MS, 500); // the visible 0.5s catch window
  assert.equal(CATCH_GRACE_MS, 200); // hidden network cushion
  assert.equal(BALL_INTERVAL_MS, 1400);
  assert.equal(READY_WINDOW_MS, 3000);
  assert.equal(FINISHED_GRACE_MS, 5000);
});

// ════════════════════════════════════════════════════════════════════
// Draw generation
// ════════════════════════════════════════════════════════════════════

test("generateDraw returns 10 unique numbers in 1..40", () => {
  for (let i = 0; i < 20; i += 1) {
    const draw = generateDraw();
    assert.equal(draw.length, BALL_COUNT);
    assert.equal(new Set(draw).size, BALL_COUNT);
    for (const n of draw) {
      assert.ok(Number.isInteger(n) && n >= 1 && n <= KENO_POOL_SIZE);
    }
  }
});

test("generateDraw is random (not a fixed sequence)", () => {
  const draws = new Set();
  for (let i = 0; i < 10; i += 1) {
    draws.add(generateDraw().join(","));
  }
  assert.ok(draws.size > 1, "expected more than one distinct draw");
});

// ════════════════════════════════════════════════════════════════════
// Ball release schedule
// ════════════════════════════════════════════════════════════════════

test("ballSchedule derives identical, evenly-spaced 0.5s glow windows from the round deadline", () => {
  const deadline = 10_000_000;
  const draw = [5, 12, 27, 3, 40, 9, 18, 33, 21, 7];
  const schedule = ballSchedule(deadline, draw);
  assert.equal(schedule.length, BALL_COUNT);
  for (let i = 0; i < schedule.length; i += 1) {
    const ball = schedule[i];
    assert.equal(ball.index, i);
    assert.equal(ball.number, draw[i]);
    assert.equal(ball.releaseMs, deadline - ROUND_MS + i * BALL_INTERVAL_MS);
    // Visible glow is exactly 0.5s; the catch window extends a hidden
    // network grace beyond it.
    assert.equal(ball.expiresMs, ball.releaseMs + GLOW_MS);
    assert.equal(ball.acceptedUntilMs, ball.expiresMs + CATCH_GRACE_MS);
  }
  // The final tile's VISIBLE glow ends exactly at the round deadline;
  // its hidden grace tail is clipped by round resolution.
  const last = schedule[schedule.length - 1];
  assert.equal(last.expiresMs, deadline);
  assert.equal(last.acceptedUntilMs, deadline + CATCH_GRACE_MS);
});

test("ballSchedule handles malformed input defensively", () => {
  assert.deepEqual(ballSchedule(10_000_000, null), []);
  assert.deepEqual(ballSchedule(10_000_000, []), []);
  assert.deepEqual(ballSchedule(NaN, [1, 2]), []);
});

// ════════════════════════════════════════════════════════════════════
// Catch-quality grading
// ════════════════════════════════════════════════════════════════════

function makeBall(deadline, draw, index) {
  return ballSchedule(deadline, draw)[index];
}

test("gradeCatch: 0.5s glow + hidden network grace is catchable (binary)", () => {
  const deadline = 10_000_000;
  const ball = makeBall(deadline, [7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 0);
  // Inside the glow window → caught.
  assert.equal(gradeCatch(ball.releaseMs, ball), CATCH_QUALITY.GOOD);
  assert.equal(gradeCatch(ball.releaseMs + GLOW_MS / 2, ball), CATCH_QUALITY.GOOD);
  assert.equal(gradeCatch(ball.expiresMs, ball), CATCH_QUALITY.GOOD);
  // Inside the hidden network grace (tapped while glowing, arrived a
  // beat late) → still caught.
  assert.equal(gradeCatch(ball.expiresMs + CATCH_GRACE_MS, ball), CATCH_QUALITY.GOOD);
  // Before the tile lights up → not catchable.
  assert.equal(gradeCatch(ball.releaseMs - 1, ball), null);
  // Past the grace tail → miss, not a catch.
  assert.equal(gradeCatch(ball.acceptedUntilMs + 1, ball), null);
  // Malformed inputs → not catchable.
  assert.equal(gradeCatch(NaN, ball), null);
  assert.equal(gradeCatch(123, null), null);
});

// ════════════════════════════════════════════════════════════════════
// Round scoring (keno multiplier + perfect bonus)
// ════════════════════════════════════════════════════════════════════

test("computeRoundStats uses the keno multiplier table for the number caught", () => {
  assert.deepEqual(computeRoundStats([]), { caught: 0, perfects: 0, score: 0 });
  // 1 catch → multiplier[1][1] = 3.
  assert.deepEqual(computeRoundStats([{ number: 5, quality: "good" }]), {
    caught: 1,
    perfects: 0,
    score: 3,
  });
  // 5 catches → multiplier[5][5] = 50.
  const five = [1, 2, 3, 4, 5].map((number) => ({ number, quality: "good" }));
  assert.deepEqual(computeRoundStats(five), { caught: 5, perfects: 0, score: 50 });
  // 10 catches → multiplier[10][10] = 5000.
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((number) => ({ number, quality: "good" }));
  assert.deepEqual(computeRoundStats(ten), { caught: 10, perfects: 0, score: 5000 });
});

test("computeRoundStats: no timing bonus — quality never affects the score", () => {
  // Even "perfect"-shaped history entries score the plain multiplier.
  const catches = [
    { number: 1, quality: "perfect" },
    { number: 2, quality: "perfect" },
    { number: 3, quality: "good" },
  ];
  // multiplier[3][3] = 10, perfects pinned at 0.
  assert.deepEqual(computeRoundStats(catches), {
    caught: 3,
    perfects: 0,
    score: 10,
  });
});

test("computeRoundStats ignores malformed entries", () => {
  assert.deepEqual(computeRoundStats(null), { caught: 0, perfects: 0, score: 0 });
  assert.deepEqual(computeRoundStats([null, { number: 1, quality: "good" }]), {
    caught: 1,
    perfects: 0,
    score: 3,
  });
});

// ════════════════════════════════════════════════════════════════════
// Round winner
// ════════════════════════════════════════════════════════════════════

test("decideRoundWinner: higher score wins", () => {
  const p1 = [1, 2, 3].map((number) => ({ number, quality: "good" })); // 10 pts
  const p2 = [1, 2].map((number) => ({ number, quality: "good" })); // 6 pts
  assert.equal(decideRoundWinner(p1, p2), RESULT.PLAYER1);
  assert.equal(decideRoundWinner(p2, p1), RESULT.PLAYER2);
});

test("decideRoundWinner: exact score ties draw (score is monotonic in catches)", () => {
  // Same catch count → same multiplier → draw.
  const a = [{ number: 1, quality: "good" }]; // 3
  const b = [{ number: 2, quality: "good" }]; // 3
  assert.equal(decideRoundWinner(a, b), RESULT.DRAW);
  // Nothing caught on either side → draw.
  assert.equal(decideRoundWinner([], []), RESULT.DRAW);
  assert.equal(decideRoundWinner(null, null), RESULT.DRAW);
  // Equal counts with different numbers → still draw.
  const x = [1, 2, 3].map((number) => ({ number, quality: "good" })); // 10
  const y = [7, 8, 9].map((number) => ({ number, quality: "good" })); // 10
  assert.equal(decideRoundWinner(x, y), RESULT.DRAW);
});

// ════════════════════════════════════════════════════════════════════
// Match result
// ════════════════════════════════════════════════════════════════════

test("decideMatchResult: first to ROUNDS_TO_WIN round wins takes the match", () => {
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 3, roundsWonPlayer2: 1, p1Score: 10, p2Score: 500 }),
    RESULT.PLAYER1,
  );
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 3, p1Score: 900, p2Score: 10 }),
    RESULT.PLAYER2,
  );
});

test("decideMatchResult: level after 5 rounds → aggregate score decides; equal → draw", () => {
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 100, p2Score: 90 }),
    RESULT.PLAYER1,
  );
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 80, p2Score: 90 }),
    RESULT.PLAYER2,
  );
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 80, p2Score: 80 }),
    RESULT.DRAW,
  );
  assert.equal(decideMatchResult({}), RESULT.DRAW);
});

test("decideMatchResult: forfeit tally forces the opponent to win", () => {
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 0, roundsWonPlayer2: ROUNDS_TO_WIN, p1Score: 0, p2Score: 0 }),
    RESULT.PLAYER2,
  );
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: ROUNDS_TO_WIN, roundsWonPlayer2: 0, p1Score: 0, p2Score: 0 }),
    RESULT.PLAYER1,
  );
});

// ════════════════════════════════════════════════════════════════════
// Payout
// ════════════════════════════════════════════════════════════════════

test("computePayout: normal win → winner gets stake + 90% of loser's stake", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(payout.winnerNet, 190);
  assert.equal(payout.loserNet, -100);
  assert.equal(payout.houseFee, 10);
  assert.equal(payout.prizePaid, 190);
  assert.equal(payout.refundEach, null);
});

test("computePayout: draw refunds both, no fee", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.DRAW });
  assert.equal(payout.winnerNet, null);
  assert.equal(payout.loserNet, null);
  assert.equal(payout.houseFee, 0);
  assert.equal(payout.prizePaid, 0);
  assert.equal(payout.refundEach, 100);
});

test("computePayout validates inputs", () => {
  assert.throws(() => computePayout({ stakeAmount: -1, result: RESULT.PLAYER1 }), RangeError);
  assert.throws(() => computePayout({ stakeAmount: 100, result: "bogus" }), RangeError);
});

// ════════════════════════════════════════════════════════════════════
// Practice bot
// ════════════════════════════════════════════════════════════════════

test("botCatchesForElapsed only catches released tiles, inside the glow window, never in the future", () => {
  const deadline = 10_000_000;
  const draw = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const schedule = ballSchedule(deadline, draw);

  // No time elapsed → nothing catchable.
  assert.deepEqual(botCatchesForElapsed(schedule, 0, []), []);

  // Elapsed covers the first 5 glow windows → the bot can only have
  // caught those tiles, each caughtAt inside [release, release+GLOW].
  const elapsed = schedule[4].expiresMs + 100;
  const catches = botCatchesForElapsed(schedule, elapsed, []);
  for (const c of catches) {
    const ball = schedule.find((b) => b.number === c.number);
    assert.ok(ball.releaseMs <= elapsed);
    const at = new Date(c.caughtAt).getTime();
    assert.ok(at >= ball.releaseMs && at <= ball.releaseMs + GLOW_MS);
    assert.ok(at <= elapsed);
    assert.equal(c.quality, "good");
  }

  // Mid-window: a catch is backdated but never past `elapsed`.
  const midElapsed = schedule[0].releaseMs + GLOW_MS / 2;
  const midCatches = botCatchesForElapsed(schedule, midElapsed, []);
  for (const c of midCatches) {
    assert.ok(new Date(c.caughtAt).getTime() <= midElapsed);
  }

  // alreadyCaught excludes those numbers.
  const caughtNumbers = catches.map((c) => c.number);
  const again = botCatchesForElapsed(schedule, elapsed, caughtNumbers);
  for (const c of again) {
    assert.ok(!caughtNumbers.includes(c.number));
  }
});

// ════════════════════════════════════════════════════════════════════
// Misc helpers
// ════════════════════════════════════════════════════════════════════

test("round2 / pickPositiveInt behave like the other PvP games", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2("12.345"), 12.35);
  assert.equal(round2(null), 0);
  assert.equal(pickPositiveInt(null, 10), 10);
  assert.equal(pickPositiveInt(0, 10), 10);
  assert.equal(pickPositiveInt("20", 10), 20);
  assert.equal(pickPositiveInt(15.9, 10), 15);
});

console.log("\n✅ All Keno Catch Duel engine tests passed!\n");
