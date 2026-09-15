// tests/hex-troop-count.test.mjs
//
// Unit tests for src/lib/hexTroopCount.ts — the troop-count arithmetic behind
// Hex Duel's Attack / Displace flow and the on-tile troop popup.
//
// The risky case is a "source" tile holding a single troop: the engine's
// getAttackSources() offers every adjacent friendly tile, so `tileTroops - 1`
// can be 0 even though sending 0 troops is never a legal action. These tests
// pin the guarantee that a count is always inside 1..max.
//
// Run:  node --import tsx --test tests/hex-troop-count.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  clampSendCount,
  maxSendLimit,
  sendableTroops,
} from "../src/lib/hexTroopCount.ts";

test("sendableTroops: a tile always keeps one troop behind", () => {
  assert.equal(sendableTroops(0), 0);
  assert.equal(sendableTroops(1), 0, "a lone troop has nothing to send");
  assert.equal(sendableTroops(2), 1);
  assert.equal(sendableTroops(7), 6);
});

test("sendableTroops: fractional and invalid input never goes negative", () => {
  assert.equal(sendableTroops(2.9), 1, "truncates, never rounds up");
  assert.equal(sendableTroops(NaN), 0);
  assert.equal(sendableTroops(Infinity), 0);
  assert.equal(sendableTroops(undefined), 0);
});

test("maxSendLimit: the UI limit is never below 1", () => {
  assert.equal(maxSendLimit(0), 1, "a source with no spare troops still shows 1");
  assert.equal(maxSendLimit(-4), 1);
  assert.equal(maxSendLimit(1), 1);
  assert.equal(maxSendLimit(5), 5);
  assert.equal(maxSendLimit(4.9), 4);
  assert.equal(maxSendLimit(NaN), 1);
  assert.equal(maxSendLimit(Infinity), 1);
});

test("clampSendCount: sending fewer than 1 troop is impossible", () => {
  assert.equal(clampSendCount(0, 5), 1, "a 1-troop source opens the popup at 0");
  assert.equal(clampSendCount(-2, 5), 1);
  assert.equal(clampSendCount(NaN, 5), 1);
});

test("clampSendCount: a 1-troop source can never appear to send 0", () => {
  const maxFrom = sendableTroops(1); // 0
  assert.equal(clampSendCount(0, maxFrom), 1);
  assert.equal(clampSendCount(3, maxFrom), 1, "an over-range count collapses to 1");
});

test("clampSendCount: swapping source clamps down, or keeps a still-legal count", () => {
  // Swapping to a smaller source: 5 was chosen, the new one can spare 3.
  assert.equal(clampSendCount(5, sendableTroops(4)), 3);
  // Swapping to a bigger source: the chosen 2 stands.
  assert.equal(clampSendCount(2, sendableTroops(9)), 2);
  // Swapping between equal sources leaves the count alone.
  assert.equal(clampSendCount(4, sendableTroops(5)), 4);
});

test("clampSendCount: truncates fractions and passes large values through", () => {
  assert.equal(clampSendCount(2.7, 5), 2);
  assert.equal(clampSendCount(1000, 1000), 1000);
});

test("clampSendCount: the result is always a legal 1..limit integer", () => {
  const maxima = [0, 1, 2, 3, 7, 50, -1, NaN, Infinity];
  const counts = [0, 1, 2, 3, 7, 50, 999, -5, NaN, Infinity, 2.5];
  for (const max of maxima) {
    const limit = maxSendLimit(max);
    assert.ok(limit >= 1, `limit for ${max} must be >= 1, got ${limit}`);
    for (const count of counts) {
      const result = clampSendCount(count, max);
      assert.ok(Number.isInteger(result), `clamp(${count}, ${max}) is not an integer`);
      assert.ok(
        result >= 1 && result <= limit,
        `clamp(${count}, ${max}) = ${result} is outside 1..${limit}`,
      );
    }
  }
});
