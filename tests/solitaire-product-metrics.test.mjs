/**
 * solitaire-product-metrics.test.mjs
 *
 * The product dashboard's arithmetic, tested without a database or PostHog:
 * UTC window boundaries, funnel conversions (unique users), retention, and
 * latency percentiles. A wrong boundary or denominator is a wrong product
 * decision, so these are exact-value tests.
 *
 * Run:  node --import tsx --test tests/solitaire-product-metrics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFunnel,
  changePercent,
  completionRate,
  median,
  opponentKind,
  percent,
  percentile,
  previousRange,
  retentionRows,
  startOfUtcDay,
  utcDaysBetween,
  utcDayKey,
  utcRange,
} from "../src/lib/analytics/solitaireProductCore.ts";

test("the window is whole UTC days ending with today, end-exclusive", () => {
  const now = new Date("2026-03-15T23:45:10.000Z");
  const range = utcRange(7, now);
  assert.equal(range.end.toISOString(), "2026-03-16T00:00:00.000Z");
  assert.equal(range.start.toISOString(), "2026-03-09T00:00:00.000Z");
  assert.equal(range.days, 7);
  // Seven whole days, today included exactly once.
  assert.equal((range.end - range.start) / 86_400_000, 7);
});

test("a boundary instant belongs to the day that starts, not the one that ends", () => {
  const before = new Date("2026-03-15T23:59:59.999Z");
  const after = new Date("2026-03-16T00:00:00.000Z");
  assert.equal(startOfUtcDay(before).toISOString(), "2026-03-15T00:00:00.000Z");
  assert.equal(startOfUtcDay(after).toISOString(), "2026-03-16T00:00:00.000Z");
  assert.equal(utcDayKey(before), "2026-03-15");
  assert.equal(utcDayKey(after), "2026-03-16");
  // A timestamp just after midnight is day 1 of the next cohort, not day 0.
  assert.equal(utcDaysBetween(new Date("2026-03-15T00:00:00Z"), after), 1);
});

test("the previous window is contiguous and the same length", () => {
  const range = utcRange(30, new Date("2026-03-15T12:00:00Z"));
  const prev = previousRange(range);
  assert.equal(prev.end.toISOString(), range.start.toISOString());
  assert.equal((prev.end - prev.start) / 86_400_000, 30);
});

test("funnel conversions use unique users and clamp overhang at 100%", () => {
  const steps = buildFunnel([
    { key: "visit", label: "Visitor", users: 1000, previousUsers: 800 },
    { key: "signup", label: "Signup", users: 400, previousUsers: 500 },
    { key: "onboarding", label: "Onboarding", users: 300, previousUsers: 250 },
    // More players than signups (guest events): the RATE clamps, counts stay.
    { key: "first_game", label: "First game", users: 320, previousUsers: 200 },
  ]);
  assert.equal(steps[0].conversionFromPrevious, null);
  assert.equal(steps[1].conversionFromPrevious, 40);
  assert.equal(steps[1].dropOff, 60);
  assert.equal(steps[2].conversionFromPrevious, 75);
  assert.equal(steps[3].conversionFromPrevious, 100);
  assert.equal(steps[3].users, 320);
  assert.equal(steps[0].change, 200);
  assert.equal(steps[0].changePercent, 25);
});

test("a null stage does not invent a conversion", () => {
  const steps = buildFunnel([
    { key: "a", label: "A", users: 100 },
    { key: "b", label: "B", users: null },
    { key: "c", label: "C", users: 50 },
  ]);
  assert.equal(steps[1].conversionFromPrevious, null);
  assert.equal(steps[1].dropOff, null);
  assert.equal(steps[2].conversionFromPrevious, null);
});

test("retention reports a rate per cohort and survives an empty cohort", () => {
  const rows = retentionRows(200, { 1: 80, 7: 40, 30: 10 });
  assert.deepEqual(rows.map((row) => row.rate), [40, 20, 5]);
  assert.deepEqual(retentionRows(0, { 1: 0, 7: 0, 30: 0 }).map((row) => row.rate), [
    null,
    null,
    null,
  ]);
});

test("percentiles interpolate and medians are exact for odd counts", () => {
  const values = [10, 20, 30, 40];
  assert.equal(percentile(values, 0.5), 25);
  assert.equal(percentile(values, 0.9), 37);
  assert.equal(percentile([], 0.9), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("completion rates and percentages never divide by zero", () => {
  assert.equal(completionRate(0, 0), null);
  assert.equal(completionRate(200, 50), 25);
  assert.equal(percent(1, 0), null);
  assert.equal(changePercent(10, 0), null);
  assert.equal(changePercent(150, 100), 50);
});

test("a recorded opponent is never classified as a live human", () => {
  assert.equal(opponentKind({ isAi: true, ghost: false }), "ai");
  assert.equal(opponentKind({ isAi: false, ghost: true }), "recorded");
  assert.equal(opponentKind({ isAi: false, ghost: false }), "human");
});
