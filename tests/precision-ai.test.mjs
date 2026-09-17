// Precision — pure game-engine rules.
//
// These tests used to drive the in-memory `precisionMatchStore` Map with
// `setTimeout`s. Both are gone: the rules now live in `src/lib/precision/engine.ts`
// as plain functions and the state lives in Postgres, so the rules are tested
// here directly (no database, no clock, no timers) and the persistence side is
// covered by the lifecycle guards in `precision-match-cleanup.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRoundResult,
  armRoundState,
  computeStopTelemetry,
  evaluateRound,
  finishMatchState,
  generateRoundNonce,
  isArmedRoundDue,
  isStopElapsedInRange,
  makeInitialMatch,
  revealArmedRoundState,
  rollRandomTarget,
} from "../src/lib/precision/engine.ts";
import {
  PRECISION_AI_USER_ID,
  isPrecisionAiMatch,
} from "../src/lib/precision/serverStore.ts";
import {
  MAX_STOP_MS,
  MAX_TARGET_MS,
  MIN_STOP_MS,
  MIN_TARGET_MS,
  ROUND_COUNTDOWN_MS,
  TARGET_WINS,
} from "../src/lib/precision/constants.ts";

const ROUND_GO = 1_000_000;

function players() {
  return [
    { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
    {
      seat: 2,
      userId: PRECISION_AI_USER_ID,
      name: "GRYND AI",
      isReady: true,
      isConnected: true,
    },
  ];
}

function aiMatch(id = "test-ai") {
  return makeInitialMatch(id, 0, players(), "ready_up", 1, true);
}

function pvpMatch(id = "test-pvp") {
  return makeInitialMatch(
    id,
    25,
    [
      { seat: 1, userId: "a", name: "A", isReady: true, isConnected: true },
      { seat: 2, userId: "b", name: "B", isReady: true, isConnected: true },
    ],
    "active",
    1,
  );
}

test("Precision AI identity is explicit and cannot be mistaken for PvP", () => {
  const ai = aiMatch();
  const pvp = { ...ai, isAiGame: false };
  assert.equal(isPrecisionAiMatch(ai), true);
  assert.equal(isPrecisionAiMatch(pvp), false);
  assert.equal(isPrecisionAiMatch(null), false);
  assert.equal(isPrecisionAiMatch(undefined), false);
});

test("a fresh match starts in ready_up with no round armed and no leaked target", () => {
  const match = aiMatch("test-fresh");
  assert.equal(match.phase, "ready_up");
  assert.equal(match.countdownEndsAt, null);
  assert.equal(match.armingStartedAt, null);
  assert.equal(match.roundGoInstant, null);
  // The rolled target is server-only: it is never on the public state until
  // the reveal, so a client cannot pre-read it during the countdown.
  assert.equal(match.targetMs, null);
  assert.equal(match.roundId, null);
  assert.equal(match.roundNonce, null);
  assert.equal(match.roundSequence, 0);
});

test("every rolled target is an integer inside the published window", () => {
  for (let i = 0; i < 250; i += 1) {
    const target = rollRandomTarget();
    assert.equal(Number.isInteger(target), true);
    assert.ok(target >= MIN_TARGET_MS && target <= MAX_TARGET_MS, `out of range: ${target}`);
  }
  // Deterministic injection point (used for future seeded/replayable rounds).
  assert.equal(rollRandomTarget(() => 0), MIN_TARGET_MS);
  assert.equal(rollRandomTarget(() => 0.999999), MAX_TARGET_MS);
});

test("arming stamps a fixed countdown envelope and hides the target", () => {
  const match = pvpMatch("test-arm");
  const now = 5_000;
  armRoundState(match, generateRoundNonce(), now);

  assert.equal(match.phase, "arming");
  assert.equal(match.armingStartedAt, now);
  assert.equal(match.countdownEndsAt, now + ROUND_COUNTDOWN_MS);
  assert.equal(match.targetMs, null, "the target must stay private while arming");
  assert.equal(match.roundSequence, 1);
  assert.equal(match.roundId, `m-test-arm-r-1`);
  assert.equal(typeof match.roundNonce, "string");
  assert.ok(match.roundNonce.length > 0);
  assert.equal(isArmedRoundDue(match, now + ROUND_COUNTDOWN_MS - 1), false);
  assert.equal(isArmedRoundDue(match, now + ROUND_COUNTDOWN_MS), true);
});

test("a lost timer cannot strand a round: any reader reveals it once due", () => {
  const match = pvpMatch("test-self-heal");
  const now = 1_000;
  armRoundState(match, generateRoundNonce(), now);
  const rolled = 4_321;

  // The countdown elapsed with nobody holding a handle — exactly the state a
  // stalled round was left in when the in-memory `setTimeout` died with its
  // serverless instance. The stored instants are all the next read needs.
  const dueAt = now + ROUND_COUNTDOWN_MS + 250;
  assert.equal(isArmedRoundDue(match, dueAt), true);
  revealArmedRoundState(match, rolled, dueAt);

  assert.equal(match.phase, "active");
  assert.equal(match.targetMs, rolled, "the target is published at the reveal");
  assert.equal(match.roundGoInstant, dueAt, "the GO instant is server-stamped at reveal time");
  assert.equal(match.countdownEndsAt, null);
  assert.equal(match.armingStartedAt, null);
  // The replay envelope survives the reveal so clients can echo it back.
  assert.equal(match.roundId, "m-test-self-heal-r-1");
  assert.equal(typeof match.roundNonce, "string");
  // Idempotent: the second reader (the opponent's poll) has nothing to do.
  assert.equal(isArmedRoundDue(match, dueAt + 5_000), false);
});

test("only an arming, undecided match can be revealed", () => {
  const match = pvpMatch("test-guard");
  assert.equal(isArmedRoundDue(match, Date.now()), false, "active is not arming");
  match.phase = "finished";
  assert.equal(isArmedRoundDue(match, Date.now() + 60_000), false, "finished is terminal");
});

test("server-stamped telemetry is measured against the GO instant, never the client", () => {
  const stopInstant = ROUND_GO + 3_900;
  const telemetry = computeStopTelemetry(ROUND_GO, stopInstant);
  assert.equal(telemetry.stopInstant, stopInstant);
  assert.equal(telemetry.elapsedMs, 3_900);
  // diffMs is graded once BOTH seats have submitted (the target is irrelevant
  // until the round can be decided).
  assert.equal(telemetry.diffMs, 0);
  assert.equal(isStopElapsedInRange(telemetry.elapsedMs), true);
  assert.equal(isStopElapsedInRange(MIN_STOP_MS - 1), false);
  assert.equal(isStopElapsedInRange(MAX_STOP_MS + 1), false);
  assert.equal(isStopElapsedInRange(Number.NaN), false);
});

test("the closest stop takes the round", () => {
  const match = pvpMatch("test-closest");
  match.targetMs = 5_000;
  const result = evaluateRound({
    score: match.score,
    seat1: { userId: "a", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_050) },
    seat2: { userId: "b", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 4_000) },
    targetMs: match.targetMs,
  });
  assert.equal(result.roundWinnerSeat, 1);
  assert.deepEqual(result.score, { seat1: 1, seat2: 0 });
  assert.equal(result.matchFinished, false);
  assert.equal(result.lastRoundStops.seat1.diffMs, 50);
  assert.equal(result.lastRoundStops.seat2.diffMs, 1_000);
  assert.equal(result.lastRoundStops.seat2.userId, "b");
});

test("an equal diff replays the SAME round with a fresh replay envelope", () => {
  const match = pvpMatch("test-tie");
  match.targetMs = 5_000;
  const result = evaluateRound({
    score: match.score,
    seat1: { userId: "a", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_000) },
    seat2: { userId: "b", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_000) },
    targetMs: match.targetMs,
  });
  assert.equal(result.roundWinnerSeat, null);
  assert.deepEqual(result.score, { seat1: 0, seat2: 0 });
  assert.equal(result.matchFinished, false);

  applyRoundResult(match, result);
  const before = {
    round: match.currentRound,
    sequence: match.roundSequence,
    roundId: match.roundId,
    nonce: match.roundNonce,
  };
  // A tie does NOT advance currentRound — the caller re-arms the same round.
  armRoundState(match, generateRoundNonce(), ROUND_GO + 20);
  assert.equal(match.currentRound, before.round);
  assert.equal(match.roundSequence, before.sequence + 1);
  assert.notEqual(match.roundId, before.roundId);
  assert.notEqual(match.roundNonce, before.nonce);
});

test("first seat to the win target ends the match", () => {
  const match = pvpMatch("test-finish");
  match.score = { seat1: TARGET_WINS - 1, seat2: 1 };
  match.targetMs = 5_000;
  const result = evaluateRound({
    score: match.score,
    seat1: { userId: "a", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_001) },
    seat2: { userId: "b", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 9_000) },
    targetMs: match.targetMs,
  });
  assert.equal(result.matchFinished, true);
  assert.equal(result.matchWinnerSeat, 1);

  applyRoundResult(match, result);
  finishMatchState(match, result.matchWinnerSeat);
  assert.equal(match.phase, "finished");
  assert.equal(match.winnerSeat, 1);
  assert.deepEqual(match.score, { seat1: TARGET_WINS, seat2: 1 });
  // Terminal: the replay envelope and the revealed target are cleared so a
  // late STOP packet from the deciding round can never be replayed.
  assert.equal(match.roundId, null);
  assert.equal(match.roundNonce, null);
  assert.equal(match.targetMs, null);
  assert.equal(match.countdownEndsAt, null);
});

test("both seats reaching the target in one round is settled deterministically", () => {
  // Reachable case: the trailing seat scrapes to the target while the leader
  // is already there — level totals, so the round winner takes the match.
  const level = evaluateRound({
    score: { seat1: TARGET_WINS - 1, seat2: TARGET_WINS },
    seat1: { userId: "a", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_000) },
    seat2: { userId: "b", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_010) },
    targetMs: 5_000,
  });
  assert.equal(level.matchFinished, true);
  assert.equal(level.matchWinnerSeat, 1, "level totals → the round winner");

  // Defence-in-depth branch: a state that already holds more than the win
  // target (corruption / a future best-of-N) must never hand the match to the
  // seat with fewer wins.
  const skewed = evaluateRound({
    score: { seat1: TARGET_WINS + 1, seat2: TARGET_WINS - 1 },
    seat1: { userId: "a", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 9_000) },
    seat2: { userId: "b", stop: computeStopTelemetry(ROUND_GO, ROUND_GO + 5_000) },
    targetMs: 5_000,
  });
  assert.equal(skewed.matchFinished, true);
  assert.equal(skewed.matchWinnerSeat, 1, "the higher score wins a double reach");
});
