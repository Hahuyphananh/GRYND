import test from "node:test";
import assert from "node:assert/strict";
import { makeInitialMatch } from "../src/lib/precision/matchmaking.ts";
import {
  PRECISION_AI_USER_ID,
  armMatchRound,
  cancelArming,
  isPrecisionAiMatch,
  precisionAiTimers,
  precisionArmingTimers,
  precisionMatchStore,
  precisionPendingStops,
  precisionRoundTargets,
  promoteArmedRoundIfDue,
  recordRoundStop,
} from "../src/lib/precision/serverStore.ts";

test("Precision AI identity is explicit and cannot be mistaken for PvP", () => {
  const aiMatch = makeInitialMatch(
    "test-ai-match",
    0,
    [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: PRECISION_AI_USER_ID, name: "GRYND AI", isReady: true, isConnected: true },
    ],
    "ready_up",
    1,
    true,
  );
  const pvpMatch = { ...aiMatch, isAiGame: false };
  assert.equal(isPrecisionAiMatch(aiMatch), true);
  assert.equal(isPrecisionAiMatch(pvpMatch), false);
});

test("Precision AI stop uses the same server round-stop reducer", () => {
  const id = "test-ai-stop";
  const match = makeInitialMatch(
    id,
    0,
    [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: PRECISION_AI_USER_ID, name: "GRYND AI", isReady: true, isConnected: true },
    ],
    "active",
    1,
    true,
  );
  match.roundId = "m-test-ai-stop-r-1";
  match.roundNonce = "nonce-test";
  match.targetMs = 2500;
  match.roundGoInstant = Date.now() - 200;
  precisionMatchStore.set(id, match);
  precisionPendingStops.delete(id);

  const human = recordRoundStop(id, "human", match.roundId, match.roundNonce);
  const bot = recordRoundStop(id, PRECISION_AI_USER_ID, match.roundId, match.roundNonce);

  assert.equal(human.error, undefined);
  assert.equal(bot.error, undefined);
  assert.equal(bot.bothStopped, true);
  // Both stops are stamped from the wall clock, so they can land 1ms apart —
  // which makes one seat the winner instead of a tie. Both are valid outcomes
  // of this same reducer, so assert the CONTRACT (a tie replays the round with
  // no score change; a decided round awards exactly one point and re-arms)
  // rather than racing the clock.
  const expectedScore = bot.roundWinnerSeat === null ? 0 : 1;
  assert.equal(bot.match?.score.seat1 + bot.match?.score.seat2, expectedScore);
  assert.equal(bot.match?.phase, "arming");

  cancelArming(id);
  precisionPendingStops.delete(id);
  precisionMatchStore.delete(id);
});

// ── Self-healing arming → active transition ──────────────────────────────
// The arming countdown is opened by a Node `setTimeout` created in
// `armMatchRound`. That timer is the fast path only: if it never fires (a
// frozen/recycled serverless instance, a process restart) the match used to
// sit in `arming` forever — both clients' countdowns reached 0 and no round
// ever opened ("the timer gets stuck on 0"). `promoteArmedRoundIfDue` lets a
// READ perform the same reveal once the server-stamped countdown has
// elapsed, and `/api/precision/get-match` calls it before publishing.

function makeArmedAiMatch(id) {
  const match = makeInitialMatch(
    id,
    0,
    [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: PRECISION_AI_USER_ID, name: "GRYND AI", isReady: true, isConnected: true },
    ],
    "ready_up",
    1,
    true,
  );
  precisionMatchStore.set(id, match);
  armMatchRound(id);
  precisionPendingStops.delete(id);
  return match;
}

function dropArmedAiMatch(id) {
  cancelArming(id);
  precisionAiTimers.delete(id);
  precisionArmingTimers.delete(id);
  precisionPendingStops.delete(id);
  precisionMatchStore.delete(id);
}

test("an armed round is NOT promoted before its countdown elapses", () => {
  const id = "test-arm-not-due";
  const match = makeArmedAiMatch(id);

  assert.equal(match.phase, "arming");
  assert.equal(match.targetMs, null);
  assert.equal(promoteArmedRoundIfDue(id), false);
  assert.equal(match.phase, "arming");
  assert.equal(match.targetMs, null);
  assert.equal(match.roundGoInstant, null);

  dropArmedAiMatch(id);
});

test("a lost arming timer cannot strand the round: a read promotes it once due", () => {
  const id = "test-arm-self-heal";
  const match = makeArmedAiMatch(id);
  const rolledTarget = precisionRoundTargets.get(id);
  assert.equal(typeof rolledTarget, "number");

  // Simulate the arming `setTimeout` being lost (frozen instance / restart):
  // drop the handle without letting the callback run. The private rolled
  // target and the public countdown stamp survive — exactly the stranded
  // state a stalled round is left in.
  const lostTimer = precisionArmingTimers.get(id);
  clearTimeout(lostTimer);
  precisionArmingTimers.delete(id);
  assert.equal(match.phase, "arming");

  // Rewind the countdown to "already elapsed" (5s of arming in the past).
  match.countdownEndsAt = Date.now() - 1;
  assert.equal(promoteArmedRoundIfDue(id), true);

  assert.equal(match.phase, "active");
  assert.equal(match.targetMs, rolledTarget);
  assert.equal(typeof match.roundGoInstant, "number");
  assert.equal(match.countdownEndsAt, null);
  assert.equal(match.armingStartedAt, null);
  // The private target slot is dropped — the public field is now the source
  // of truth, matching the timer-driven path exactly.
  assert.equal(precisionRoundTargets.has(id), false);
  // The promoted round behaves exactly like a timer-opened one: the AI match
  // gets its bot stop scheduled, otherwise the round could never resolve.
  assert.equal(precisionAiTimers.has(id), true);
  // Idempotent: a second reader (the other client's poll) is a no-op.
  assert.equal(promoteArmedRoundIfDue(id), false);

  dropArmedAiMatch(id);
});
