// tests/precision-ai-stop-immediacy.test.mjs
//
// Regression test for the reported Precision bug:
//
//   "When I click on stop, the AI is still in flight and the results show with
//    a delay."
//
// Root cause: the bot's stop instant (`aiStopAt`) is scheduled at the reveal and
// was only ever APPLIED once that instant had passed, so a round where the human
// stopped early stayed open for the rest of the bot's flight — up to the whole
// round — with the outcome already determined. The bot is graded from its STORED
// instant, not from when the transition is applied, so applying it as soon as
// the human's own stop makes the round decidable produces the identical grade,
// just without the dead air in front of the result.
//
// This drives the REAL `recordRoundStop` — the path a player's packet actually
// takes — against a fake database and a controlled clock, so "the bot's deadline
// is still seconds away" is a fact rather than a sleep. The SAME store instance
// is then driven for a human duel, so the guard that keeps the AI rule out of
// PvP is asserted behaviourally rather than by reading the source.
//
// It lives in its own file on purpose: `node:test`'s module mocking applies to
// the next import, and a second `import` of the store in the SAME file resolves
// to the instance the earlier test already imported — bound to that test's fake
// database.
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

const AI_MATCH_ID = "ai-match-1";
const PVP_MATCH_ID = "pvp-match-1";
const USER_ID = "human";
const OPPONENT_ID = "other-human";
const AI_ID = "AI_BOT";
/** An arbitrary but fixed server instant the round opened at. */
const GO = 1_700_000_000_000;
const TARGET_MS = 5_000;
/** The bot's deadline offset: the target plus a 150ms miss. */
const AI_ERR_MS = 150;
const AI_STOP_AT = GO + TARGET_MS + AI_ERR_MS;

/** A match in flight with the round revealed, and nobody stopped yet. */
function activeRow({ matchId, isAiGame, secondUserId, aiStopAt }) {
  return {
    id: matchId,
    wager: 0,
    isAiGame,
    state: {
      matchId,
      phase: "active",
      wager: 0,
      isAiGame,
      aiStop: null,
      players: [
        { seat: 1, userId: USER_ID, name: "You", isReady: true, isConnected: true },
        {
          seat: 2,
          userId: secondUserId,
          name: isAiGame ? "GRYND AI" : "Them",
          isReady: true,
          isConnected: true,
        },
      ],
      turn: 1,
      score: { seat1: 0, seat2: 0 },
      currentRound: 1,
      roundSequence: 1,
      roundId: `${matchId}-r-1`,
      roundNonce: "nonce-1",
      targetMs: TARGET_MS,
      winnerSeat: null,
      lastRoundWinnerSeat: null,
      lastRoundTargetMs: null,
      armingStartedAt: null,
      countdownEndsAt: null,
      roundGoInstant: GO,
      lastRoundStops: null,
      version: 1,
    },
    pendingStops: {},
    anomalyLedger: {},
    serverTargetMs: null,
    aiStopAt,
    payoutProcessedAt: null,
    endedAt: null,
    touchedAt: GO,
  };
}

test(
  "a human's stop against the bot grades the round at once, and a human duel still waits",
  { skip: SKIP_REASON },
  async (t) => {
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
    Date.now = () => world.clock;
    t.after(() => {
      Date.now = realDateNow;
    });

    const { recordRoundStop } = await import("../src/lib/precision/serverStore.ts");

    /** Click STOP at `elapsedMs` into the round and return the store's answer. */
    const stopAt = async (row, elapsedMs) => {
      world.row = row;
      world.clock = GO + elapsedMs;
      return recordRoundStop(row.id, USER_ID, `${row.id}-r-1`, "nonce-1", {
        receivedAtMs: world.clock,
        clientElapsedMs: elapsedMs,
      });
    };

    // ── The reported case: STOP mid-flight, ~4.15s before the bot's deadline ──
    const humanElapsedMs = 1_000;
    const result = await stopAt(
      activeRow({ matchId: AI_MATCH_ID, isAiGame: true, secondUserId: AI_ID, aiStopAt: AI_STOP_AT }),
      humanElapsedMs,
    );

    assert.equal(result.validationError, false, "a legal stop must not be refused");
    assert.ok(world.clock < AI_STOP_AT, "the bot's deadline really was still in the future");
    assert.equal(
      result.bothStopped,
      true,
      "both stops exist the moment the human stops — the caller must broadcast, not wait",
    );
    // Grading early is not grading DIFFERENTLY: the bot's 150ms miss still beats
    // a stop 4s off the target, exactly as it would have at the deadline.
    assert.equal(result.roundWinnerSeat, 2, "the bot's 5.15s is closer to the 5s target than 1s");
    assert.equal(result.matchFinished, false, "best-of-5, round 1");

    const state = result.match;
    assert.equal(state.phase, "arming", "the next round is already counting down");
    assert.equal(state.currentRound, 2);
    assert.equal(state.score.seat2, 1);
    assert.equal(state.lastRoundStops.seat1.elapsedMs, humanElapsedMs);
    assert.equal(
      state.lastRoundStops.seat2.stopInstant,
      AI_STOP_AT,
      "the bot is graded off its STORED instant, not off the human's click",
    );
    assert.equal(
      state.lastRoundStops.seat2.elapsedMs,
      TARGET_MS + AI_ERR_MS,
      "so a round brought forward grades exactly as its deadline would have",
    );
    // `aiStop` is the bot's stop for the LIVE round, and arming the next one
    // clears it — which is why the board parks both rockets from the DECIDED
    // round's published stops instead. That they are stamped is the point: the
    // bot's lane has a final position the moment the human clicks.
    assert.equal(state.aiStop, null, "the next round starts with both rockets on the pad");
    assert.equal(state.lastRoundStops.seat1.stopInstant, GO + humanElapsedMs);
    assert.equal(
      state.countdownEndsAt,
      GO + humanElapsedMs + ROUND_RESULT_REVEAL_MS + ROUND_COUNTDOWN_MS,
      "the next countdown is measured from the decision, not from the dead bot deadline",
    );
    assert.ok(world.writes.length > 0, "the graded round must be persisted");

    // ── The guard: a HUMAN opponent's stop is a real event nobody has sent ────
    // Nothing may be brought forward for a human duel, and the round must still
    // be waiting when the packet lands.
    world.writes = [];
    const pvpResult = await stopAt(
      activeRow({
        matchId: PVP_MATCH_ID,
        isAiGame: false,
        secondUserId: OPPONENT_ID,
        aiStopAt: null,
      }),
      humanElapsedMs,
    );

    assert.equal(pvpResult.validationError, false, "a legal stop is still recorded");
    assert.equal(
      pvpResult.bothStopped,
      false,
      "a human duel must keep waiting for the opponent's own packet",
    );
    assert.equal(pvpResult.roundWinnerSeat, null, "no round may be graded on one stop");
    assert.equal(pvpResult.match.lastRoundStops, null, "nothing is stamped before both stops");
    assert.equal(pvpResult.match.phase, "active", "the round is still live for the opponent");
    assert.equal(pvpResult.match.aiStop, null, "no bot stop may be invented in a human match");
    assert.ok(world.writes.length > 0, "the human's own stop is still persisted for the next read");
  },
);
