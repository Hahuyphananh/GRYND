// tests/precision-due-transitions.test.mjs
//
// Regression test for the SECOND half of the reported Precision bug:
//
//   "There is a large delay between the moment BOTH players have stopped and
//    the Round Results popup appearing."
//
// Root cause: the arming countdown and the bot's stop were stored INSTANTS that
// only ever turned into a transition as a side effect of a READ. So the round
// opened and the bot stopped whenever a client happened to poll `get-match`
// next, and a resolution a read performed was never announced at all — the read
// path has no socket access, and `precision:roundResult` was only ever emitted
// from the stop handler, in reply to a player's own packet.
//
// `resolveDueTransitions` is the caller the realtime server's scheduler uses to
// arrive ON TIME, and it must hand back everything needed to broadcast what
// happened: `nextDueAtMs` to arm the next timer, and the boolean flags that pick
// the event shape.
//
// These tests drive the REAL `resolveDueTransitions` against a fake database and
// a controlled clock, so "the deadline elapsed" is a fact rather than a sleep.
//
// Run: npm run test:precision-due
// (module mocking needs --experimental-test-module-mocks; without the flag the
// test skips instead of failing.)
//
// No file is deleted by this test; the fake `db` never touches Postgres.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { ROUND_COUNTDOWN_MS, ROUND_RESULT_REVEAL_MS } from "../src/lib/precision/constants.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:precision-due";

const MATCH_ID = "ai-match-1";
const USER_ID = "human";
const AI_ID = "AI_BOT";
/** An arbitrary but fixed server instant the round opened at. */
const GO = 1_700_000_000_000;
const TARGET_MS = 5_000;
/** The bot's deadline offset the tests use: the target plus a 150ms miss. */
const AI_ERR_MS = 150;
const AI_STOP_AT = GO + TARGET_MS + AI_ERR_MS;

/** A match in flight, round revealed. */
function aiRow({
  phase = "active",
  goInstant = GO,
  targetMs = TARGET_MS,
  aiStopAt = AI_STOP_AT,
  serverTargetMs = null,
  countdownEndsAt = null,
  humanStopElapsedMs = null,
  isAiGame = true,
  winnerSeat = null,
  currentRound = 1,
  score = { seat1: 0, seat2: 0 },
} = {}) {
  const pendingStops = {};
  if (humanStopElapsedMs !== null) {
    pendingStops[USER_ID] = {
      stopInstant: goInstant + humanStopElapsedMs,
      elapsedMs: humanStopElapsedMs,
      diffMs: 0,
    };
  }
  return {
    id: MATCH_ID,
    wager: 0,
    isAiGame,
    state: {
      matchId: MATCH_ID,
      phase,
      wager: 0,
      isAiGame,
      aiStop: null,
      players: [
        { seat: 1, userId: USER_ID, name: "You", isReady: true, isConnected: true },
        { seat: 2, userId: AI_ID, name: "GRYND AI", isReady: true, isConnected: true },
      ],
      turn: 1,
      score,
      currentRound,
      roundSequence: 1,
      roundId: `${MATCH_ID}-r-1`,
      roundNonce: "nonce-1",
      targetMs: phase === "active" ? targetMs : null,
      winnerSeat,
      lastRoundWinnerSeat: null,
      lastRoundTargetMs: null,
      armingStartedAt: phase === "arming" ? GO - ROUND_COUNTDOWN_MS : null,
      countdownEndsAt,
      roundGoInstant: phase === "active" ? goInstant : null,
      lastRoundStops: null,
      version: 1,
    },
    pendingStops,
    anomalyLedger: {},
    serverTargetMs,
    aiStopAt,
    payoutProcessedAt: null,
    endedAt: null,
    touchedAt: GO,
  };
}

test(
  "a due transition is applied — and resolvable — on the deadline, with no stop packet and no client read",
  { skip: SKIP_REASON },
  async (t) => {
    // The world: one wall clock, one row, and every write the store performs.
    const world = { clock: GO, row: null, writes: [] };

    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => (world.row ? [world.row] : []),
            }),
          }),
        }),
      }),
      update: () => ({
        set: (values) => {
          world.writes.push(values);
          // A real persist makes the new state visible to the next read.
          world.row = { ...world.row, ...values };
          return { where: async () => {} };
        },
      }),
    };

    t.mock.module("../src/db/client.ts", {
      namedExports: { db: { transaction: async (fn) => fn(tx) } },
    });
    t.mock.module("../src/lib/precision/canonicalLifecycle.ts", {
      namedExports: {
        mirrorPrecisionQueued: () => {},
        mirrorPrecisionTransition: () => {},
      },
    });

    const realDateNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => world.clock;
    // Deterministic bot jitter: rollBotReactionError() => 80 + floor(0.5 * 241) = 200.
    Math.random = () => 0.5;
    t.after(() => {
      Date.now = realDateNow;
      Math.random = realRandom;
    });

    const { resolveDueTransitions } = await import("../src/lib/precision/serverStore.ts");

    /** Run one scheduler call for the current row. */
    const call = async () => {
      world.writes = [];
      return resolveDueTransitions(MATCH_ID);
    };

    // ── 1. The bot's deadline arrives, the human already stopped ──────────
    // The player stopped dead on the target; the bot's stop is 150ms late. The
    // call lands exactly ON the bot's deadline — the scheduler's whole reason to
    // exist — and must grade the round without any packet from anyone.
    {
      world.row = aiRow({ humanStopElapsedMs: TARGET_MS });
      world.clock = AI_STOP_AT;
      const report = await call();

      assert.equal(report.matchId, MATCH_ID, "the id is echoed so a caller can't cross wires");
      assert.equal(report.changed, true, "the deadline was applied");
      assert.equal(report.aiStopApplied, true, "the bot's stop is what came due");
      assert.equal(report.decided, true, "both stops existed, so the round is decided");
      assert.equal(report.roundWinnerSeat, 1, "0ms off target beats 150ms off target");
      assert.equal(report.matchFinished, false, "best-of-5, round 1");
      assert.equal(report.nextRoundArmed, true, "the next round is counting down");
      assert.equal(
        report.revealed,
        false,
        "a decision re-arms the round (arming), so it is not a reveal"
      );

      const state = report.match;
      assert.equal(state.phase, "arming");
      assert.equal(state.score.seat1, 1, "the round was scored");
      assert.equal(state.currentRound, 2);
      assert.equal(state.lastRoundWinnerSeat, 1);
      assert.equal(state.lastRoundStops.seat1.elapsedMs, TARGET_MS);
      assert.equal(state.lastRoundStops.seat2.elapsedMs, TARGET_MS + AI_ERR_MS);
      assert.equal(
        state.lastRoundStops.seat2.stopInstant,
        AI_STOP_AT,
        "the bot's stop is the stored deadline, not the moment the call arrived"
      );

      // The next instant the scheduler must arm for: the cooldown gate plus the
      // new countdown, measured from the decision.
      assert.equal(
        report.nextDueAtMs,
        AI_STOP_AT + ROUND_RESULT_REVEAL_MS + ROUND_COUNTDOWN_MS,
        "the scheduler is told when the next round opens"
      );
    }

    // ── 2. A call BEFORE the deadline changes nothing and reports the instant ──
    // This is what lets the scheduler arm one timer instead of polling.
    {
      world.row = aiRow({ humanStopElapsedMs: TARGET_MS });
      world.clock = GO + 3_000;
      const report = await call();

      assert.equal(report.changed, false, "nothing is due yet");
      assert.equal(report.aiStopApplied, false);
      assert.equal(report.decided, false);
      assert.equal(
        report.nextDueAtMs,
        AI_STOP_AT,
        "the bot's deadline is what the scheduler must arm for"
      );
      assert.equal(world.writes.length, 0, "an early call must not write the row");
    }

    // ── 3. A TIE is a decision, and says so ───────────────────────────────
    // A tie leaves `lastRoundWinnerSeat` null and does NOT advance
    // `currentRound`, so a report derived from either of those would claim
    // "nothing happened" for a round that was in fact decided and re-armed — and
    // the players would never be told.
    {
      world.row = aiRow({ aiStopAt: GO + TARGET_MS, humanStopElapsedMs: TARGET_MS });
      world.clock = GO + TARGET_MS;
      const report = await call();

      assert.equal(report.changed, true);
      assert.equal(report.decided, true, "a tie is still a decision");
      assert.equal(report.roundWinnerSeat, null);
      assert.equal(report.matchFinished, false);
      assert.equal(report.nextRoundArmed, true, "the same round replays with a fresh target");
      assert.equal(report.match.currentRound, 1, "a tie does not advance the round");
      assert.equal(report.match.lastRoundWinnerSeat, null);
      assert.equal(report.match.phase, "arming");
    }

    // ── 4. How LATE the call lands is irrelevant to the bot's graded time ──
    // The bot's stop is a stored instant, so a scheduler that fires late (or a
    // poll that gets there first) must record the same number.
    {
      const recorded = [];
      for (const lateness of [0, 3_000]) {
        world.row = aiRow({ humanStopElapsedMs: TARGET_MS });
        world.clock = AI_STOP_AT + lateness;
        const report = await call();
        recorded.push(report.match.lastRoundStops.seat2);
      }
      assert.deepEqual(
        recorded[0],
        recorded[1],
        "a late call must not make the bot slower than its deadline"
      );
      assert.equal(recorded[1].elapsedMs, TARGET_MS + AI_ERR_MS);
    }

    // ── 5. An elapsed countdown is revealed, and the bot's stop is then due ──
    {
      world.row = aiRow({
        phase: "arming",
        countdownEndsAt: GO,
        serverTargetMs: 4_000,
        targetMs: null,
        aiStopAt: null,
      });
      world.clock = GO + 25;
      const report = await call();

      assert.equal(report.changed, true);
      assert.equal(report.revealed, true, "arming -> active is a reveal");
      assert.equal(report.aiStopApplied, false, "the bot has not stopped yet");
      assert.equal(report.decided, false);
      assert.equal(report.match.phase, "active");
      assert.equal(report.match.targetMs, 4_000, "the rolled target is published at the reveal");
      assert.equal(report.match.roundGoInstant, GO + 25, "the GO is the revealing instant");
      assert.equal(report.match.aiStop, null, "the bot's time is not public until it stops");
      assert.equal(
        report.nextDueAtMs,
        GO + 25 + 4_000 + 200,
        "the bot's deadline (target + its 200ms jitter) is the next instant due"
      );
    }

    // ── 6. A human duel mid-round has nothing for a timer to do ───────────
    // The single remaining transition is the opponent's own stop packet, which
    // arrives as its own event — so the scheduler must STOP rather than spin.
    {
      world.row = aiRow({ isAiGame: false, aiStopAt: null, humanStopElapsedMs: TARGET_MS });
      world.clock = GO + 3_000;
      const report = await call();

      assert.equal(report.changed, false);
      assert.equal(report.nextDueAtMs, null, "nothing pending — do not arm a timer");
    }

    // ── 7. A finished match has nothing pending ───────────────────────────
    {
      world.row = aiRow({
        phase: "finished",
        winnerSeat: 1,
        currentRound: 3,
        score: { seat1: 3, seat2: 0 },
        aiStopAt: null,
      });
      world.clock = GO + 9_000;
      const report = await call();

      assert.equal(report.changed, false);
      assert.equal(report.matchFinished, false, "it finished earlier, not on this call");
      assert.equal(report.nextDueAtMs, null);
    }

    // ── 8. An id with no match reports nothing instead of throwing ────────
    {
      world.row = null;
      const report = await call();

      assert.equal(report.match, null);
      assert.equal(report.changed, false);
      assert.equal(report.nextDueAtMs, null);
    }
  }
);
