// tests/precision-ai-stop-immediacy.test.mjs
//
// Regression test for the reported Precision bug:
//
//   "When one player stops, both of the flights stop — the AI's rocket parks at
//    a position it has not reached yet."
//
// Root cause (corrected): the bot's stop instant (`aiStopAt`) is scheduled at
// the reveal, and it used to be APPLIED the moment the human's own stop made the
// round decidable — the bot's grade cannot change either way (it comes from the
// stored instant), so applying it early only decided WHEN the players were told.
// What that cost was the race: the bot's lane freezes from the stop that
// application publishes, so a human who stopped first watched BOTH rockets park
// at once, the bot's at a position it had not reached, and the round was over on
// screen while the bot was still supposed to be flying.
//
// The rule now is one flight per stop: the bot's stop is applied ON ITS OWN
// INSTANT (by the due scheduler — `tests/precision-due-transitions.test.mjs`
// covers that call directly), and the round is graded when the LAST stop lands.
//
// This drives the REAL `recordRoundStop` and the REAL `resolveDueTransitions` —
// the two paths a round is decided through — against a fake database and a
// controlled clock, so "the bot's deadline is still seconds away" is a fact
// rather than a sleep. The SAME store instance is then driven for a human duel,
// so the guard that keeps the AI rule out of PvP is asserted behaviourally
// rather than by reading the source.
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
  "a human's stop leaves the bot's lane flying, and the bot's own instant decides the round",
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

    const { recordRoundStop, resolveDueTransitions } = await import(
      "../src/lib/precision/serverStore.ts"
    );

    /** Click STOP at `elapsedMs` into the round and return the store's answer. */
    const stopAt = async (row, elapsedMs) => {
      world.row = row;
      world.clock = GO + elapsedMs;
      return recordRoundStop(row.id, USER_ID, `${row.id}-r-1`, "nonce-1", {
        receivedAtMs: world.clock,
        clientElapsedMs: elapsedMs,
      });
    };

    // ── 1. The human stops FIRST, ~4.15s before the bot's deadline ─────────
    // Nothing may be decided and nothing may be published on the bot's behalf:
    // its rocket is mid-flight, and its timing is the server's to reveal when
    // (and only when) its own instant arrives.
    const humanElapsedMs = 1_000;
    const result = await stopAt(
      activeRow({ matchId: AI_MATCH_ID, isAiGame: true, secondUserId: AI_ID, aiStopAt: AI_STOP_AT }),
      humanElapsedMs,
    );

    assert.equal(result.validationError, false, "a legal stop must not be refused");
    assert.ok(world.clock < AI_STOP_AT, "the bot's deadline really was still in the future");
    assert.equal(
      result.bothStopped,
      false,
      "the round is NOT over — the bot's lane is still flying, so the caller must not announce a result",
    );
    assert.equal(result.roundWinnerSeat, null, "one stop cannot decide a round");
    assert.equal(result.matchFinished, false, "best-of-5, round 1");

    const state = result.match;
    assert.equal(state.phase, "active", "the round stays live while the bot is in the air");
    assert.equal(state.lastRoundStops, null, "nothing is stamped until both stops are in");
    assert.equal(
      state.aiStop,
      null,
      "the bot's stop is not published early — publishing it is what parked its lane",
    );
    assert.equal(state.score.seat2, 0, "no round was scored");
    assert.equal(state.currentRound, 1, "no round advanced");

    // …and the human's own stop IS recorded, so the round is now waiting on the
    // bot's instant alone (which the store reports to the scheduler as
    // `nextDueAtMs` — see tests/precision-due-transitions.test.mjs).
    const persisted = world.writes[world.writes.length - 1];
    assert.equal(
      persisted.pendingStops[USER_ID].elapsedMs,
      humanElapsedMs,
      "the human's stop is persisted for the read that will resolve the round",
    );

    // ── 2. The bot's instant arrives → the round is graded, from its own stop ──
    world.clock = AI_STOP_AT;
    const due = await resolveDueTransitions(AI_MATCH_ID);

    assert.equal(due.aiStopApplied, true, "the bot's own instant applied its stop");
    assert.equal(due.decided, true, "both stops are in, so the round is graded here");
    assert.equal(due.roundWinnerSeat, 2, "the bot's 5.15s is closer to the 5s target than 1s");
    assert.equal(due.matchFinished, false, "best-of-5, round 1");
    assert.equal(due.match.phase, "arming", "the next round is counting down");
    assert.equal(due.match.score.seat2, 1);
    assert.equal(due.match.lastRoundStops.seat1.elapsedMs, humanElapsedMs);
    assert.equal(
      due.match.lastRoundStops.seat2.stopInstant,
      AI_STOP_AT,
      "the bot is graded off its STORED instant, never off the human's click",
    );
    assert.equal(
      due.match.lastRoundStops.seat2.elapsedMs,
      TARGET_MS + AI_ERR_MS,
      "so waiting for its lane to land changes nothing about the score",
    );

    // ── 3. The mirror case: the BOT stops first, the human is still flying ──
    // The bot's lane must park ON ITS INSTANT (that is `state.aiStop`, the only
    // moment its timing becomes public) while the round stays live for the human
    // — which is the same rule read from the other side.
    world.row = activeRow({
      matchId: AI_MATCH_ID,
      isAiGame: true,
      secondUserId: AI_ID,
      aiStopAt: AI_STOP_AT,
    });
    world.writes = [];
    world.clock = AI_STOP_AT;
    const botOnly = await resolveDueTransitions(AI_MATCH_ID);

    assert.equal(botOnly.changed, true, "the bot's stop is a real transition");
    assert.equal(botOnly.aiStopApplied, true);
    assert.equal(botOnly.decided, false, "the human has not stopped — the round is open");
    assert.equal(botOnly.match.phase, "active", "the round is still live for the human");
    assert.equal(botOnly.match.lastRoundStops, null, "no round is graded on one stop");
    assert.equal(
      botOnly.match.aiStop.elapsedMs,
      TARGET_MS + AI_ERR_MS,
      "the bot's lane parks at its own server-measured stop",
    );
    assert.equal(
      botOnly.nextDueAtMs,
      null,
      "nothing is left for a timer: the human's own packet is the next event",
    );

    // …and the human's later stop is what decides it.
    world.clock = GO + 4_000;
    const late = await recordRoundStop(AI_MATCH_ID, USER_ID, `${AI_MATCH_ID}-r-1`, "nonce-1", {
      receivedAtMs: world.clock,
      clientElapsedMs: 4_000,
    });
    assert.equal(late.bothStopped, true, "the last stop lands the decision");
    assert.equal(late.roundWinnerSeat, 2, "5.15s beats 4s against a 5s target");
    assert.equal(late.match.lastRoundStops.seat2.elapsedMs, TARGET_MS + AI_ERR_MS);

    // ── 4. The guard: a HUMAN opponent's stop is a real event nobody has sent ──
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
