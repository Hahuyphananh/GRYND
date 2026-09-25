// tests/precision-stop-instant.test.mjs
//
// Regression test for the instant a Precision STOP is graded at.
//
// Reported bug: pressing STOP when the on-screen timer read ~7.05s was recorded
// (and graded) as 10s — the player lost a round they had stopped dead on, while
// the bot's own 7.31s was scored correctly.
//
// Why it happened: `recordRoundStop` took the route's arrival stamp
// (`receivedAtMs`, captured before the body parse and before Clerk
// verification), and then re-stamped `Date.now()` INSIDE the transaction,
// shadowing it. Every use of that instant — including
// `serverElapsedMs = <stamp> - roundGoInstant` — therefore measured the moment
// reached AFTER the pooled connection handshake, BEGIN and the
// `SELECT … FOR UPDATE` row lock. All of that latency was charged to the
// player's reaction time. The bot is unaffected (its stop is derived from the
// reveal instant), which is exactly why the AI's time looked right and the
// human's looked seconds late.
//
// These tests drive the REAL `recordRoundStop` against a fake database whose
// transaction costs time before the row can be read (as the real pooled one
// does) and assert the graded elapsed is the one measured when the request
// ARRIVED — never the one measured after the lock.
//
// Run: npm run test:precision-stop-instant
// (module mocking needs --experimental-test-module-mocks; without the flag the
// test skips instead of failing.)

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:precision-stop-instant";

const MATCH_ID = "match-1";
const USER_ID = "user-1";
const ROUND_ID = "match-1-r-1";
const NONCE = "nonce-1";
/** An arbitrary but fixed server instant the round opened at. */
const GO = 1_700_000_000_000;

/** A match in flight: round revealed, nobody has stopped yet. */
function activeRow() {
  return {
    id: MATCH_ID,
    wager: 10,
    isAiGame: false,
    state: {
      matchId: MATCH_ID,
      phase: "active",
      wager: 10,
      isAiGame: false,
      aiStop: null,
      players: [
        { seat: 1, userId: USER_ID, name: "One", isReady: true, isConnected: true },
        { seat: 2, userId: "user-2", name: "Two", isReady: true, isConnected: true },
      ],
      turn: 1,
      score: { seat1: 0, seat2: 0 },
      currentRound: 1,
      roundSequence: 1,
      roundId: ROUND_ID,
      roundNonce: NONCE,
      targetMs: 7_000,
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
    aiStopAt: null,
    payoutProcessedAt: null,
    endedAt: null,
    touchedAt: GO,
  };
}

test(
  "a stop is graded at the instant the request arrived, not one database round trip later",
  { skip: SKIP_REASON },
  async (t) => {
    // The wall clock the store sees, and the fake transaction's cost. `lockMs`
    // models the pooled connection handshake + BEGIN + `SELECT … FOR UPDATE`
    // (which can even wait behind a concurrent poll) — real seconds on a remote
    // pooled database, and exactly what used to be charged to the player.
    const world = { clock: GO, lockMs: 0, writes: [] };

    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => {
                world.clock += world.lockMs;
                return [activeRow()];
              },
            }),
          }),
        }),
      }),
      update: () => ({
        set: (values) => {
          world.writes.push(values);
          return { where: async () => {} };
        },
      }),
    };

    t.mock.module("../src/db/client.ts", {
      namedExports: { db: { transaction: async (fn) => fn(tx) } },
    });
    // Never touch the canonical lifecycle mirror from a unit test.
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

    /** Submit one STOP and return what the server recorded for that seat. */
    const stop = async ({ arrivalMs, clientElapsedMs, lockMs = 0 }) => {
      world.clock = arrivalMs; // the wall clock at the instant the route stamped it
      world.lockMs = lockMs;
      world.writes = [];
      const result = await recordRoundStop(MATCH_ID, USER_ID, ROUND_ID, NONCE, {
        receivedAtMs: arrivalMs,
        clientElapsedMs,
      });
      return {
        result,
        recorded: world.writes.at(-1)?.pendingStops?.[USER_ID] ?? null,
      };
    };

    // ── 1. The reported bug ───────────────────────────────────────────────
    // Clicked at 7.05s (both the display and the client's frozen hint), with the
    // transaction taking 3s to reach the row — the exact shape of the report.
    {
      const { result, recorded } = await stop({
        arrivalMs: GO + 7_050,
        clientElapsedMs: 7_050,
        lockMs: 3_000,
      });
      assert.ok(recorded, "the stop was recorded");
      assert.equal(
        recorded.elapsedMs,
        7_050,
        `a 7.05s stop must grade at 7050ms, not at the database's own later clock (${recorded.elapsedMs})`
      );
      assert.equal(recorded.diffMs, 0, "the round is not decided yet, so no diff");
      assert.equal(result.bothStopped, false);
      assert.equal(result.error, undefined);
      // The persisted round is untouched apart from this seat's stop.
      assert.equal(world.writes.at(-1).state.phase, "active");
    }

    // ── 2. No hint at all (the HTTPS fallback ships no elapsed) ───────────
    {
      const { recorded } = await stop({
        arrivalMs: GO + 7_050,
        clientElapsedMs: null,
        lockMs: 3_000,
      });
      assert.equal(recorded.elapsedMs, 7_050);
    }

    // ── 3. A hint LATER than our own measurement buys nothing ─────────────
    {
      const { recorded } = await stop({
        arrivalMs: GO + 5_000,
        clientElapsedMs: 8_000,
        lockMs: 2_500,
      });
      assert.equal(
        recorded.elapsedMs,
        5_000,
        "a client can never move its stop later than the server's own measurement"
      );
    }

    // ── 4. Delivery lag is NEVER charged to the player ────────────────────
    // The reported failure this guards: a stop clicked at 5.00s whose packet
    // took 5s to arrive used to be graded at `arrival - 400ms` ≈ 9.6s, because
    // the click instant was only honoured inside a fixed allowance and the rest
    // of the delay landed on the player's reaction time — which then handed the
    // round to the bot. The click is now the graded value outright.
    {
      const { recorded } = await stop({
        arrivalMs: GO + 7_050,
        clientElapsedMs: 6_500,
        lockMs: 2_500,
      });
      assert.equal(
        recorded.elapsedMs,
        6_500,
        "the stop is graded at the click, not at the click plus the delivery"
      );
    }

    // ── 4b. …however slow the packet was ─────────────────────────────────
    // The concrete shape of the report: clicked at 5.00s, packet arrived at
    // 10.00s (a dead socket falling back to HTTPS). The old bounded credit
    // graded this at 9.6s and declared the bot the winner.
    {
      const { recorded } = await stop({
        arrivalMs: GO + 10_000,
        clientElapsedMs: 5_000,
        lockMs: 4_000,
      });
      assert.equal(
        recorded.elapsedMs,
        5_000,
        `a 5s click must stay 5s however late the packet lands (got ${recorded.elapsedMs})`
      );
    }

    // ── 5. The lock delay never shows up anywhere in the grade ────────────
    {
      const fast = await stop({ arrivalMs: GO + 6_000, clientElapsedMs: null, lockMs: 0 });
      const slow = await stop({ arrivalMs: GO + 6_000, clientElapsedMs: null, lockMs: 5_000 });
      assert.equal(fast.recorded.elapsedMs, 6_000);
      assert.equal(
        slow.recorded.elapsedMs,
        6_000,
        "5s of database latency must not add 5s to the player's reaction time"
      );
    }
  }
);
