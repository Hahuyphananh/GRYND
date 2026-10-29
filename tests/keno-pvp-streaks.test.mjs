// tests/keno-pvp-streaks.test.mjs
//
// Cosmetic streak milestones for the Keno SURVIVAL DUEL. Everything here is
// derived from the PUBLIC tile log, so it can never disagree with the server
// and can never change an outcome.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  STREAK_MILESTONES,
  claimedFlags,
  streakMilestoneAt,
  streakStats,
} from "../src/lib/keno-pvp/streaks.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const page = read("src/app/casino/keno-pvp/[matchId]/PageClient.jsx");
const helper = read("src/lib/keno-pvp/streaks.js");
const engine = read("src/lib/keno-pvp/engine.js");

const entry = (outcome, extra = {}) => ({
  tile: 1,
  index: 0,
  outcome,
  p1Lives: 3,
  p2Lives: 3,
  ...extra,
});

const claims = (seat, count, startIndex = 0) =>
  Array.from({ length: count }, (_, i) =>
    entry(seat, {
      index: startIndex + i,
      tile: i + 1,
      p1Claimed: seat === "player1" || seat === "both_claim",
      p2Claimed: seat === "player2" || seat === "both_claim",
    }),
  );

test("streaks count consecutive claimed targets per player", () => {
  const log = [...claims("player1", 3), ...claims("player2", 2, 3)];
  const stats = streakStats(log);
  assert.equal(stats.p1Run, 0, "player1's run ends when player2 claims");
  assert.equal(stats.p2Run, 2);
  assert.equal(stats.p1Best, 3);
  assert.equal(stats.p2Best, 2);
});

test("a miss resets that player's streak and nothing else", () => {
  const log = [
    ...claims("both_claim", 4),
    entry("both_miss", { index: 4, tile: 5, p1Claimed: false, p2Claimed: false }),
    entry("player2", { index: 5, tile: 6, p1Claimed: false, p2Claimed: true }),
  ];
  const stats = streakStats(log);
  assert.equal(stats.p1Run, 0, "the miss ended player 1's run");
  assert.equal(stats.p2Run, 1, "player 2's run restarted on its next claim");
  assert.equal(stats.p1Best, 4);
  assert.equal(stats.p2Best, 4, "both_claim tiles count for both seats");
});

test("milestones fire exactly at 5, 10 and 15 in a row", () => {
  assert.deepEqual(STREAK_MILESTONES, [5, 10, 15]);
  for (const count of [4, 5, 6, 9, 10, 11, 14, 15, 16]) {
    const hits = streakMilestoneAt(claims("player1", count));
    if ([5, 10, 15].includes(count)) {
      assert.deepEqual(hits, [{ seat: "p1", count }], `expected a milestone at ${count}`);
    } else {
      assert.deepEqual(hits, [], `no milestone at ${count}`);
    }
  }
});

test("a milestone is not re-reported on later entries of the same run", () => {
  assert.deepEqual(streakMilestoneAt(claims("player1", 5)).length, 1);
  assert.deepEqual(streakMilestoneAt(claims("player1", 6)), []);
  assert.deepEqual(streakMilestoneAt(claims("player1", 7)), []);
});

test("both seats can hold a milestone at once", () => {
  const log = claims("both_claim", 5);
  assert.deepEqual(streakMilestoneAt(log), [
    { seat: "p1", count: 5 },
    { seat: "p2", count: 5 },
  ]);
});

test("legacy log entries without per-player flags still count", () => {
  assert.deepEqual(claimedFlags({ outcome: "player1" }), { p1: true, p2: false });
  assert.deepEqual(claimedFlags({ outcome: "player2" }), { p1: false, p2: true });
  assert.deepEqual(claimedFlags({ outcome: "both_claim" }), { p1: true, p2: true });
  assert.deepEqual(claimedFlags({ outcome: "both_miss" }), { p1: false, p2: false });
  assert.deepEqual(
    streakMilestoneAt(Array.from({ length: 5 }, (_, i) => ({ index: i, outcome: "player1" }))),
    [{ seat: "p1", count: 5 }],
  );
});

test("the helper only reads the log (no match/engine state)", () => {
  assert.doesNotMatch(helper, /p1Lives|p2Lives|windowMs|liveTile|RESULT/);
  assert.doesNotMatch(engine, /streak/i, "streaks must never reach the game engine");
});

test("the page celebrates once per log entry and respects reduced motion", () => {
  assert.ok(page.includes("streakMilestoneAt(log)"), "milestones must come from the log helper");
  assert.ok(
    page.includes("streakEntryIndexRef") && page.includes("index <= streakEntryIndexRef.current"),
    "a re-delivered snapshot must not re-fire a celebration",
  );
  assert.ok(
    page.includes("if (!streakPrimedRef.current)"),
    "a page opened mid-match must not replay old milestones",
  );
  assert.ok(
    page.includes("withReducedMotion(shouldReduceMotion"),
    "celebrations must honour reduced motion",
  );
  assert.ok(page.includes('aria-live="polite"'), "milestones must be announced politely");
  // Decoration only: the celebration path never claims, fetches or writes state.
  const effectStart = page.indexOf("// ── Cosmetic streak milestones");
  assert.ok(effectStart > 0, "milestone effect block not found");
  const effect = page.slice(effectStart, effectStart + 2400);
  assert.ok(effect.length > 0, "milestone effect block not found");
  assert.doesNotMatch(effect, /fetch\(|doClaim|setMatch\(|p1Lives|p2Lives/);
});
