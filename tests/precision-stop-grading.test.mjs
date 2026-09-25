// tests/precision-stop-grading.test.mjs
//
// The instant a Precision STOP is GRADED at, pinned directly.
//
// The reported bug: a player clicked STOP at ~5.00s, the packet took seconds to
// arrive, and the result popup showed them ~10s — so the round went to the bot.
//
// Cause: `resolveStopElapsedMs` treated the client's frozen click instant as a
// bounded HINT. It was honoured only within a fixed allowance of the server's
// own arrival measurement, and every millisecond of delay past that allowance
// was charged to the player's reaction time:
//
//     graded = max(arrival - allowance, min(arrival, click))
//
// so with a ~5s delivery and a 400ms allowance the score became
// `click + (5000 - 400)` = 9600ms — the "~10 seconds" in the report.
//
// The click instant is now authoritative. These tests pin that, and pin the
// two bounds that survive (they are physical, not budgeted): a stop can never
// be graded LATER than the instant the server received the packet, and never
// below `MIN_STOP_MS`. A client that reports nothing usable is still graded on
// the server's own measurement, exactly as it was before `elapsedMs` existed.
//
// Run: npm run test:precision-grading

import test from "node:test";
import assert from "node:assert/strict";

import { resolveStopElapsedMs, stopDeliveryLagMs } from "../src/lib/precision/engine.ts";
import { MIN_STOP_MS } from "../src/lib/precision/constants.ts";

/** Grade a stop: `clickMs` is what the player's client froze at, `arrivalMs`
 *  what the server measured when the packet landed. */
const grade = (clickMs, arrivalMs) =>
  resolveStopElapsedMs({ serverElapsedMs: arrivalMs, clientElapsedMs: clickMs });

test("the click instant is the graded value however late the packet arrives", () => {
  // The reported case: clicked at 5.00s, packet landed at 10.00s.
  assert.equal(
    grade(5_000, 10_000),
    5_000,
    "a 5s click must not be graded as ~10s because the packet was slow"
  );

  // …and the credit is no longer bounded by any fixed allowance: every lag
  // from a fast LAN hop to a dead socket falling back to HTTPS grades the
  // same, because the lag is simply not part of the measurement.
  for (const lag of [1, 40, 399, 400, 401, 1_500, 3_000, 9_999]) {
    assert.equal(grade(5_000, 5_000 + lag), 5_000, `a ${lag}ms delivery must not change the grade`);
  }
});

test("a stop is never graded later than the instant the server received it", () => {
  // A claim past our own measurement is not a stop that happened: it is a
  // device clock skewed high, or a fabricated value. Our measurement is the
  // ceiling, so it is what gets recorded.
  assert.equal(
    grade(8_000, 5_000),
    5_000,
    "a client can never move its stop later than the server's own measurement"
  );
  assert.equal(grade(12_000, 6_000), 6_000);
});

test("a pathological or missing click instant falls back to the server's measurement", () => {
  // Below the floor: `0` is not a stop anyone made, and admitting it would let
  // a programmatic instant into the scoring maths.
  assert.equal(grade(0, 7_050), 7_050, "a 0ms click is rejected in favour of our own measurement");
  assert.equal(grade(MIN_STOP_MS - 1, 7_050), 7_050);

  // No hint at all — the HTTPS fallback of an older client, or a browser that
  // never froze a value. Unchanged behaviour: our own measurement is used.
  assert.equal(grade(null, 7_050), 7_050);
  assert.equal(grade(undefined, 7_050), 7_050);
  assert.equal(grade(NaN, 7_050), 7_050);
  assert.equal(grade("nonsense", 7_050), 7_050);
});

test("the floor still holds, so a graded stop is always a real one", () => {
  // The floor is a floor, not a preference: a server measurement below it is
  // raised to it here and then rejected by `isStopElapsedInRange` downstream,
  // which is where the packet is actually dropped.
  assert.equal(grade(MIN_STOP_MS, 20), MIN_STOP_MS);
  assert.equal(grade(null, 20), MIN_STOP_MS);
  assert.equal(grade(5_000, 20), MIN_STOP_MS);
  // A usable click at or above the floor is honoured as-is.
  assert.equal(grade(MIN_STOP_MS, 40_000), MIN_STOP_MS);
});

test("an unusable server measurement is passed through untouched", () => {
  // Never silently coerced into a number: the caller's range check is what
  // decides, and it must see the real value.
  assert.equal(resolveStopElapsedMs({ serverElapsedMs: NaN, clientElapsedMs: 5_000 }), NaN);
  assert.equal(
    resolveStopElapsedMs({ serverElapsedMs: Infinity, clientElapsedMs: 5_000 }),
    Infinity
  );
});

test("the credited lag is reported for operators, and never bounds the grade", () => {
  // `stopDeliveryLagMs` is what the store logs when a packet is unusually
  // late. It must measure the lag the grade implies, and it must NOT be
  // involved in computing that grade — a large lag is a fact to record, not a
  // reason to charge the player.
  assert.equal(stopDeliveryLagMs(10_000, 5_000), 5_000);
  assert.equal(stopDeliveryLagMs(5_090, 5_000), 90);
  assert.equal(stopDeliveryLagMs(5_000, 5_000), 0);
  // A claim past our measurement is not negative lag.
  assert.equal(stopDeliveryLagMs(5_000, 8_000), 0);
  assert.equal(stopDeliveryLagMs(NaN, 5_000), 0);
  assert.equal(stopDeliveryLagMs(5_000, NaN), 0);

  // The two functions agree: whatever the lag, the grade is the click.
  const click = 5_000;
  const arrival = 12_000;
  const graded = grade(click, arrival);
  assert.equal(graded + stopDeliveryLagMs(arrival, graded), arrival);
  assert.equal(graded, click);
});
