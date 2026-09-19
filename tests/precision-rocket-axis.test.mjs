// Precision — rocket-race time axis.
//
// The vertical race board draws the target threshold line and every rocket
// from `computeAxisMaxMs` / `axisPercent`. Those numbers decide whether a stop
// APPEARS to land where the server scored it, so they are pinned here (pure
// functions, no DOM).

import test from "node:test";
import assert from "node:assert/strict";

import {
  axisPercent,
  computeAxisMaxMs,
  computeTicks,
  formatSecondsLabel,
} from "../src/lib/precision/rocketAxis.ts";
import {
  MAX_STOP_MS,
  MAX_TARGET_MS,
  MIN_TARGET_MS,
} from "../src/lib/precision/constants.ts";

test("the axis always leaves headroom above the target", () => {
  for (const target of [MIN_TARGET_MS, 4_321, 7_500, MAX_TARGET_MS]) {
    const max = computeAxisMaxMs(target);
    assert.ok(max > target, `axis ${max} must be above the target ${target}`);
    assert.ok(
      max >= target,
      "the threshold line must never sit at or beyond the ceiling",
    );
    // The target line should be clearly inside the plot, not glued to the top.
    assert.ok(axisPercent(target, max) <= 90, "target must sit below the ceiling");
  }
});

test("an unknown target falls back to the widest possible round", () => {
  const max = computeAxisMaxMs(null);
  assert.equal(max, Math.ceil((MAX_TARGET_MS * 1.2) / 500) * 500);
  assert.ok(max > MAX_TARGET_MS);
});

test("the axis is clamped to the game's hard maximum stop", () => {
  assert.equal(computeAxisMaxMs(MAX_STOP_MS), MAX_STOP_MS);
  assert.equal(computeAxisMaxMs(1_000_000), MAX_STOP_MS);
  // A tiny target still gets a usable floor so the board is not squashed.
  assert.equal(computeAxisMaxMs(10), 3_000);
  // A non-positive / non-finite target is treated as "unknown" (the server
  // keeps the next round's target private while arming).
  assert.equal(computeAxisMaxMs(0), computeAxisMaxMs(null));
  assert.equal(computeAxisMaxMs(Number.NaN), computeAxisMaxMs(null));
});

test("ticks ascend, start at 0, include the ceiling and never duplicate", () => {
  for (const target of [2_500, 4_321, 9_999, 10_000]) {
    const max = computeAxisMaxMs(target);
    const ticks = computeTicks(max);
    assert.equal(ticks[0], 0);
    assert.equal(ticks[ticks.length - 1], max);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.ok(ticks[i] > ticks[i - 1], "ticks must be strictly ascending");
    }
    // A readable grid: not so many labels they overlap.
    assert.ok(ticks.length <= 8, `too many ticks: ${ticks.length}`);
  }
});

test("a degenerate axis degrades to a single zero tick", () => {
  assert.deepEqual(computeTicks(0), [0]);
  assert.deepEqual(computeTicks(Number.NaN), [0]);
});

test("positions are percentages clamped to the track", () => {
  assert.equal(axisPercent(0, 12_000), 0);
  assert.equal(axisPercent(6_000, 12_000), 50);
  assert.equal(axisPercent(12_000, 12_000), 100);
  assert.equal(axisPercent(30_000, 12_000), 100, "an overshoot pins at the top");
  assert.equal(axisPercent(-500, 12_000), 0, "never negative");
  assert.equal(axisPercent(1_000, 0), 0, "a zero ceiling cannot divide");
});

test("labels stay faithful to the tick value", () => {
  assert.equal(formatSecondsLabel(0), "0s");
  assert.equal(formatSecondsLabel(4_000), "4s");
  assert.equal(formatSecondsLabel(2_500), "2.5s");
  assert.equal(formatSecondsLabel(10_000), "10s");
});
