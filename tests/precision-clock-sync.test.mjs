// tests/precision-clock-sync.test.mjs
//
// The board clock and the result panel must report the SAME elapsed.
//
// The round timer the player times against lives on the client, but the number
// that DECIDES the round is the server's (`recordRoundStop` measures
// `stopInstant - roundGoInstant`). The display bridges to that GO instant
// through the device's wall clock, which is routinely skewed by seconds (a
// stale NTP, a suspended phone, a VM). Bridging through a skewed clock shifts
// the whole round: the player stops dead on the number they were shown and the
// server grades them somewhere else — the board timer disagrees with the
// per-seat times on the round-result panel.
//
// `roundClock.ts` has carried the fix for exactly that (`estimateServerClockOffset`
// + `serverClockNow`) and `usePrecisionMatchState` has always estimated the
// offset from each poll's own round trip — but the value never reached the round
// clock:
//
//   * `/api/precision/get-match` never returned the server's `now`, so
//     `estimateServerClockOffset` always got `NaN` and bailed to null, and
//   * the match page never passed `serverClockOffsetMs` into
//     `usePrecisionRoundClock` (it defaults to 0 = "device clock is exact").
//
// So the correction was dead code and every skewed device shipped the mismatch.
// These tests pin BOTH halves: the arithmetic (behaviourally, including the
// skewed case that regressed) and the wiring.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  elapsedSince,
  estimateServerClockOffset,
  pairScheduledGo,
  resolveRoundAnchorLocal,
  serverClockNow,
} from "../src/lib/precision/roundClock.ts";
import { resolveStopElapsedMs } from "../src/lib/precision/engine.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * One client's view of the world, as used by `precision-round-clock.test.mjs`.
 *
 * @param serverNowMs        the server's wall clock
 * @param skewMs             device wall clock minus the server's wall clock
 * @param monotonicOffsetMs  `performance.now()` origin (only differences matter)
 */
const client = (serverNowMs, skewMs, monotonicOffsetMs) => ({
  deviceNow: () => serverNowMs + skewMs,
  perfNow: () => serverNowMs - monotonicOffsetMs,
});

const MONOTONIC_OFFSET = 700_000;
const SEQUENCE = 4;
const ARM_AT = 1_000;
const SCHEDULED_GO = ARM_AT + 5_000;
const GO = SCHEDULED_GO + 250; // the round opens on the next read after the countdown
const REVEAL_OBSERVED_AT = GO + 150; // what the poll showed us, 150ms late
const CLICK_AT = GO + 2_050; // where the player actually stops (on the server clock)

test("the poll's own round trip recovers the device's clock skew", () => {
  const SKEW = 2_000; // a device two seconds ahead of the server
  const RTT = 120;
  const sentAtServer = 500_000;
  const c = client(sentAtServer, SKEW, MONOTONIC_OFFSET);

  const offset = estimateServerClockOffset({
    sentAtDeviceMs: c.deviceNow(),
    receivedAtDeviceMs: c.deviceNow() + RTT,
    // The server stamps its clock mid-flight; that is all a response can know.
    serverNowMs: sentAtServer + RTT / 2,
  });

  assert.equal(offset, SKEW, "the estimate must be deviceWallClock - serverWallClock");
  assert.equal(
    serverClockNow(c.deviceNow(), offset),
    sentAtServer,
    "and it must land the device back on the server's clock",
  );
});

test("with the offset applied, the board shows the elapsed the server grades", () => {
  const SKEW = 2_000;
  const arming = client(ARM_AT + 400, SKEW, MONOTONIC_OFFSET);
  const offset = SKEW; // what the poll would have estimated

  // Paired while arming, on the SERVER's clock (never the raw device clock).
  const scheduled = pairScheduledGo({
    countdownEndsAt: SCHEDULED_GO,
    roundSequence: SEQUENCE,
    localNowMs: arming.perfNow(),
    deviceNowMs: serverClockNow(arming.deviceNow(), offset),
  });

  const reveal = client(REVEAL_OBSERVED_AT, SKEW, MONOTONIC_OFFSET);
  const anchor = resolveRoundAnchorLocal({
    scheduled,
    goInstant: GO,
    roundSequence: SEQUENCE,
    localNowMs: reveal.perfNow(),
    deviceNowMs: serverClockNow(reveal.deviceNow(), offset),
  });

  const click = client(CLICK_AT, SKEW, MONOTONIC_OFFSET);
  const displayed = elapsedSince(anchor, click.perfNow());
  const serverMeasured = CLICK_AT - GO;

  assert.equal(displayed, serverMeasured);
  assert.equal(displayed, 2_050);

  // ...which is also what the server finally GRADES: the frozen value IS the
  // graded instant, so the round trip is not charged to the player at all.
  const arrival = CLICK_AT + 90; // the packet reached the route 90ms later
  const graded = resolveStopElapsedMs({
    serverElapsedMs: arrival - GO,
    clientElapsedMs: displayed,
  });
  assert.equal(graded, displayed, "the result panel must print the frozen value");
});

test("without the offset the same round is off by the whole skew (the regression)", () => {
  const SKEW = 2_000;
  const arming = client(ARM_AT + 400, SKEW, MONOTONIC_OFFSET);

  // Offset dropped (the bug): the pairing bridges through the RAW device clock.
  const scheduled = pairScheduledGo({
    countdownEndsAt: SCHEDULED_GO,
    roundSequence: SEQUENCE,
    localNowMs: arming.perfNow(),
    deviceNowMs: arming.deviceNow(),
  });

  const reveal = client(REVEAL_OBSERVED_AT, SKEW, MONOTONIC_OFFSET);
  const anchor = resolveRoundAnchorLocal({
    scheduled,
    goInstant: GO,
    roundSequence: SEQUENCE,
    localNowMs: reveal.perfNow(),
    deviceNowMs: reveal.deviceNow(),
  });

  const click = client(CLICK_AT, SKEW, MONOTONIC_OFFSET);
  const displayed = elapsedSince(anchor, click.perfNow());

  assert.notEqual(displayed, CLICK_AT - GO);
  assert.equal(displayed, CLICK_AT - GO + SKEW);
  // The stop is then graded against a different number than the one the player
  // was looking at — the reported "board timer ≠ result panel" mismatch.
  const graded = resolveStopElapsedMs({
    serverElapsedMs: CLICK_AT + 90 - GO,
    clientElapsedMs: displayed,
  });
  assert.notEqual(graded, displayed);
});

test("get-match hands the client the server's own clock", () => {
  const src = read("../src/app/api/precision/get-match/route.ts");
  // Every success response carries `now` — the hook reads `data.now` on each
  // poll to (re)estimate the offset, and a missing field silently disables it.
  assert.match(src, /const serverNowMs = Date\.now\(\)/, "the route must stamp its clock once");
  const responses = src.match(/now:\s*serverNowMs/g) ?? [];
  assert.ok(
    responses.length >= 3,
    `every get-match response must carry now: serverNowMs (found ${responses.length})`,
  );
});

test("the match page forwards the estimated offset into the round clock", () => {
  const page = read("../src/app/casino/precision/game/[matchId]/PageClient.tsx");
  assert.match(
    page,
    /serverClockOffsetMs/,
    "the page must read the offset out of usePrecisionMatchState",
  );
  assert.match(
    page,
    /usePrecisionRoundClock\(\{\s*state,\s*refreshState,\s*serverClockOffsetMs\s*\}\)/,
    "and pass it to usePrecisionRoundClock — dropping it returns the display to the raw device clock",
  );
});

test("a refined offset re-pairs the scheduled GO while the round arms", () => {
  const hook = read("../src/hooks/usePrecisionRoundClock.ts");
  const pairingDeps = hook.match(
    /\}, \[state\?\.phase, state\?\.countdownEndsAt, state\?\.roundSequence, serverClockOffsetMs\]\);/,
  );
  assert.ok(
    !!pairingDeps,
    "the pairing effect must depend on serverClockOffsetMs so the first poll's offset re-anchors the round",
  );
});
