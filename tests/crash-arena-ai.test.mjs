import test from "node:test";
import assert from "node:assert/strict";
import { getCrashBotCashoutTarget } from "../src/lib/crash-arena/botStrategy.js";
import { CRASH_MIN } from "../src/lib/games/crash/constants.ts";
import {
  CRASH_ARENA_AI_CLERK_ID,
  CRASH_ARENA_AI_NAME,
} from "../src/lib/crash-arena/aiBot.ts";

test("Crash Arena bot always commits a legal cashout multiplier", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    for (const cp of [1.2, 1.5, 2.0, 3.47, 5.0, 9.2]) {
      for (let i = 0; i < 1000; i++) {
        const t = getCrashBotCashoutTarget(cp, difficulty);
        assert.ok(Number.isFinite(t), `target finite for ${difficulty} crashPoint=${cp}`);
        assert.ok(t >= CRASH_MIN, `target >= CRASH_MIN for ${difficulty} crashPoint=${cp} (got ${t})`);
        // Greedy commits cap at crashPoint × (1.05 + 0.35) ≈ 1.4× + rounding.
        assert.ok(
          t <= cp * 1.41 + 0.01,
          `target within greedy cap for ${difficulty} crashPoint=${cp} (got ${t})`,
        );
      }
    }
  }
});

test("Crash Arena bot sometimes plays greedy (busts) and sometimes plays safe", () => {
  const cp = 5.0;
  const safe = [];
  const greedy = [];
  for (let i = 0; i < 5000; i++) {
    const t = getCrashBotCashoutTarget(cp, "medium");
    if (t > cp) greedy.push(t);
    else safe.push(t);
  }
  assert.ok(greedy.length > 0, "bot sometimes commits past the crash point");
  assert.ok(safe.length > 0, "bot sometimes commits below the crash point");
  // Safe commits are capped just under the crash point.
  assert.ok(safe.every((t) => t <= cp - 0.01));
});

test("easy bot takes early low exits, hard bot pushes close to the crash point", () => {
  const cp = 5.0;
  const easySafe = [];
  const hardSafe = [];
  for (let i = 0; i < 5000; i++) {
    const easy = getCrashBotCashoutTarget(cp, "easy");
    const hard = getCrashBotCashoutTarget(cp, "hard");
    if (easy <= cp) easySafe.push(easy);
    if (hard <= cp) hardSafe.push(hard);
  }
  // Easy safe exits live in [0.35, 0.6]×crashPoint.
  assert.ok(easySafe.length > 0, "easy bot sometimes plays safe");
  assert.ok(
    easySafe.every((t) => t <= cp * 0.6 + 0.01 && t >= CRASH_MIN),
    "easy safe exits stay in the low band",
  );
  // Hard safe exits live in [0.8, 0.97]×crashPoint — close to the crash.
  assert.ok(hardSafe.length > 0, "hard bot sometimes plays safe");
  assert.ok(
    hardSafe.every((t) => t >= cp * 0.8 - 0.01 && t <= cp - 0.01),
    "hard safe exits push close to the crash point",
  );
});

test("easy bot busts more often than the hard bot", () => {
  const cp = 5.0;
  let easyGreedy = 0;
  let hardGreedy = 0;
  for (let i = 0; i < 4000; i++) {
    if (getCrashBotCashoutTarget(cp, "easy") > cp) easyGreedy++;
    if (getCrashBotCashoutTarget(cp, "hard") > cp) hardGreedy++;
  }
  assert.ok(
    easyGreedy > hardGreedy,
    `easy bot should bust more than hard (easy=${easyGreedy}, hard=${hardGreedy})`,
  );
  assert.ok(easyGreedy > 0, "easy bot sometimes busts");
  assert.ok(hardGreedy > 0, "hard bot occasionally busts");
});

test("Crash Arena bot rounds targets to 2 decimals", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    for (let i = 0; i < 300; i++) {
      const t = getCrashBotCashoutTarget(4.2, difficulty);
      assert.equal(Math.round(t * 100) / 100, t);
    }
  }
});

test("Crash Arena AI identity is a reserved, non-real account", () => {
  assert.equal(CRASH_ARENA_AI_CLERK_ID, "crash_arena_ai_bot");
  assert.equal(CRASH_ARENA_AI_NAME, "GRYND AI");
  // The bot's Clerk id must never look like a real Clerk user id, so the
  // disconnect/stale-sweep paths can't ever mistake it for a live player.
  assert.ok(!CRASH_ARENA_AI_CLERK_ID.startsWith("user_"));
});
