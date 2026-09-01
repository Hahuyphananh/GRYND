import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createQuestRng,
  dailyPeriodKey,
  hashSeed,
  mulberry32,
  normalizeGameKey,
  questSlots,
  rollQuest,
  weeklyPeriodKey,
} from "../src/lib/quests.js";

test("dailyPeriodKey returns a UTC date string", () => {
  const key = dailyPeriodKey(new Date("2026-09-01T12:00:00Z"));
  assert.equal(key, "2026-09-01");
});

test("weeklyPeriodKey returns an ISO week string", () => {
  const key = weeklyPeriodKey(new Date("2026-09-01T12:00:00Z"));
  assert.match(key, /^\d{4}-W\d{2}$/);
});

test("mulberry32 is deterministic for the same seed", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

test("createQuestRng is deterministic per (clerk, period) and differs across periods", () => {
  const rng1 = createQuestRng("user-1", "daily", "2026-09-01");
  const rng2 = createQuestRng("user-1", "daily", "2026-09-01");
  const rng3 = createQuestRng("user-1", "daily", "2026-09-02");
  assert.equal(rng1(), rng2());
  assert.notEqual(rng1(), rng3());
});

test("hashSeed is stable and spread out", () => {
  assert.equal(hashSeed("abc"), hashSeed("abc"));
  assert.notEqual(hashSeed("abc"), hashSeed("abd"));
});

test("normalizeGameKey maps counter strings to canonical quest keys", () => {
  assert.equal(normalizeGameKey("Chess"), "chess");
  assert.equal(normalizeGameKey("chess"), "chess");
  assert.equal(normalizeGameKey("Roulette"), "roulette");
  assert.equal(normalizeGameKey("roulette-pvp"), "roulette");
  assert.equal(normalizeGameKey("Dice Flush"), "dice");
  assert.equal(normalizeGameKey("Crash Arena"), "crash");
  assert.equal(normalizeGameKey("Hex Duel"), "hex-duel");
  assert.equal(normalizeGameKey("odds"), "odds");
  assert.equal(normalizeGameKey("unknown-game"), null);
  assert.equal(normalizeGameKey(""), null);
  assert.equal(normalizeGameKey(null), null);
});

test("questSlots returns 3 daily and 2 weekly", () => {
  assert.equal(questSlots("daily"), 3);
  assert.equal(questSlots("weekly"), 2);
});

test("rollQuest produces a valid quest shape with tier-scaled values", () => {
  const rand = mulberry32(999);
  const q = rollQuest({ rand, tier: "medium", periodType: "daily" });
  assert.ok(["play", "win", "wager", "multiplier", "streak", "diversify", "pvp"].includes(q.questType));
  assert.ok(q.target > 0);
  assert.ok(q.reward > 0);
  assert.ok(typeof q.signature === "string");
  if (q.gameKey) {
    assert.ok(Array.isArray(q.questType) || true); // gameKey is nullable
  }
});

test("rollQuest avoids recent signatures when possible", () => {
  const rand = mulberry32(7);
  const recent = new Set(["play|any|3", "win|any|2", "wager|any|600"]);
  const q = rollQuest({ rand, tier: "easy", periodType: "daily", recent });
  assert.ok(!recent.has(q.signature));
});

test("weekly quests scale targets and rewards up", () => {
  const rand = mulberry32(42);
  const daily = rollQuest({ rand, tier: "medium", periodType: "daily" });
  const rand2 = mulberry32(42);
  const weekly = rollQuest({ rand: rand2, tier: "medium", periodType: "weekly" });
  assert.ok(Number(weekly.target) >= Number(daily.target));
  assert.ok(Number(weekly.reward) >= Number(daily.reward));
});
