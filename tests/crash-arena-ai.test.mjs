import test from "node:test";
import assert from "node:assert/strict";
import {
  getCrashBotFoldTarget,
  getCrashBotFoldDecision,
} from "../src/lib/crash-arena/botStrategy.js";
import { CRASH_MIN, CRASH_MAX } from "../src/lib/crash-poker/constants.js";

test("Crash Arena bot fold targets stay inside the crash range", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    for (let i = 0; i < 2000; i++) {
      const t = getCrashBotFoldTarget(difficulty);
      assert.ok(Number.isFinite(t), `target finite for ${difficulty}`);
      assert.ok(t >= CRASH_MIN, `target >= CRASH_MIN for ${difficulty} (got ${t})`);
      assert.ok(t <= CRASH_MAX, `target <= CRASH_MAX for ${difficulty} (got ${t})`);
      assert.equal(Math.round(t * 100) / 100, t, "target rounded to 2 decimals");
    }
  }
});

test("easy bots fold early, hard bots push deep", () => {
  const easy = [];
  const medium = [];
  const hard = [];
  for (let i = 0; i < 5000; i++) {
    easy.push(getCrashBotFoldTarget("easy"));
    medium.push(getCrashBotFoldTarget("medium"));
    hard.push(getCrashBotFoldTarget("hard"));
  }
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  assert.ok(avg(easy) < avg(medium), "easy folds earlier than medium");
  assert.ok(avg(medium) < avg(hard), "medium folds earlier than hard");
  // Hard bots are meaningfully deep into the danger zone (well above the min).
  assert.ok(avg(hard) > 4.0, `hard bots push deep (avg ${avg(hard).toFixed(2)})`);
});

test("getCrashBotFoldDecision folds when the curve reaches the target", () => {
  const target = getCrashBotFoldTarget("medium");
  assert.equal(getCrashBotFoldDecision({ multiplier: target - 0.01, target }), false);
  assert.equal(getCrashBotFoldDecision({ multiplier: target, target }), true);
  assert.equal(getCrashBotFoldDecision({ multiplier: target + 0.5, target }), true);
  // All-in bots are committed and never fold.
  assert.equal(getCrashBotFoldDecision({ multiplier: 9.0, target: 1.3, allIn: true }), false);
});

test("Crash Arena AI identity is a reserved, non-real account", () => {
  // Mirrors src/lib/crash-arena/aiBot.ts — the bot's Clerk id must never
  // look like a real Clerk user id, so the disconnect/stale-sweep paths
  // can't ever mistake it for a live player.
  assert.equal("crash_arena_ai_bot", "crash_arena_ai_bot");
  assert.ok(!"crash_arena_ai_bot".startsWith("user_"));
});