/**
 * speed-typing-ai.test.mjs
 *
 * The pure Speed Typing practice bot, pinned.
 *
 * The bot is a typing SPEED rather than a turn generator, so the properties
 * that matter are: it only ever moves forward, it never revives a finished or
 * forfeited seat, it genuinely finishes within the hard limit, and a weaker
 * tier really is slower (not merely sloppier). `aiSeatRaceAt` is pure and takes
 * the server clock as an argument, so every one of those is drivable exactly.
 *
 * Run:  node --import tsx --test tests/speed-typing-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_TYPING_ERROR_RATE,
  AI_TYPING_WPM,
  aiSeatRaceAt,
  aiTypingProfile,
} from "../src/lib/speed-typing/ai.ts";
import { RACE_LIMIT_MS } from "../src/lib/speed-typing/constants.ts";
import { emptySeatRace } from "../src/lib/speed-typing/rules.ts";

const GO = 1_000_000_000_000;
const LENGTH = 250;

/** A finished/bot-state snapshot at `elapsedMs` after GO. */
const at = (elapsedMs, overrides = {}) =>
  aiSeatRaceAt({
    difficulty: "normal",
    passageLength: LENGTH,
    goAtMs: GO,
    nowMs: GO + elapsedMs,
    ...overrides,
  });

// ── Profile ───────────────────────────────────────────────────────────────

test("aiTypingProfile: every tier maps to a positive rate and coerces", () => {
  for (const tier of ["easy", "normal", "hard"]) {
    const profile = aiTypingProfile(tier);
    assert.equal(profile.tier, tier);
    assert.ok(profile.wpm > 0);
    assert.ok(profile.charsPerMs > 0);
    assert.ok(profile.errorRate >= 0 && profile.errorRate < 1);
  }
  // An unknown tier coerces onto the shared scale (normal), never throws.
  assert.equal(aiTypingProfile("nonsense").tier, "normal");
  assert.equal(aiTypingProfile(undefined).tier, "normal");
});

test("aiTypingProfile: hard is faster and cleaner than normal, which beats easy", () => {
  assert.ok(AI_TYPING_WPM.hard > AI_TYPING_WPM.normal);
  assert.ok(AI_TYPING_WPM.normal > AI_TYPING_WPM.easy);
  assert.ok(AI_TYPING_ERROR_RATE.hard < AI_TYPING_ERROR_RATE.normal);
  assert.ok(AI_TYPING_ERROR_RATE.normal < AI_TYPING_ERROR_RATE.easy);
});

// ── The clock ─────────────────────────────────────────────────────────────

test("nothing happens before GO", () => {
  const before = aiSeatRaceAt({
    difficulty: "hard",
    passageLength: LENGTH,
    goAtMs: GO,
    nowMs: GO - 1,
    current: emptySeatRace(),
  });
  assert.equal(before.charsTyped, 0);
  assert.equal(before.finished, false);
  // An unarmed race (no GO instant) is equally inert.
  const unarmed = aiSeatRaceAt({
    difficulty: "hard",
    passageLength: LENGTH,
    goAtMs: null,
    nowMs: GO,
    current: emptySeatRace(),
  });
  assert.equal(unarmed.charsTyped, 0);
});

test("the cursor advances monotonically with elapsed time", () => {
  let prev = 0;
  for (let t = 0; t <= RACE_LIMIT_MS; t += 5000) {
    const seat = at(t);
    assert.ok(seat.charsTyped >= prev, `rewound at t=${t}`);
    assert.ok(seat.charsTyped <= LENGTH, "never past the passage");
    prev = seat.charsTyped;
  }
  assert.equal(at(RACE_LIMIT_MS).finished, true);
});

test("a later measurement never rewinds an earlier one", () => {
  const later = at(30_000);
  const earlier = at(10_000, { current: later });
  // Passing a seat that is already further ahead leaves it untouched.
  assert.deepEqual(earlier, later);
});

test("the errors counted never exceed the cursor", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    for (let t = 0; t <= 60_000; t += 2500) {
      const seat = aiSeatRaceAt({
        difficulty,
        passageLength: LENGTH,
        goAtMs: GO,
        nowMs: GO + t,
      });
      assert.ok(seat.errors <= seat.charsTyped, `${difficulty}@${t}`);
      assert.ok(seat.errors >= 0);
    }
  }
});

// ── Finishing ─────────────────────────────────────────────────────────────

test("the bot finishes the passage, freezing a server-derived time/WPM/accuracy", () => {
  const finished = at(RACE_LIMIT_MS);
  assert.equal(finished.finished, true);
  assert.equal(finished.charsTyped, LENGTH);
  assert.ok(finished.finishedAtMs != null && finished.finishedAtMs >= GO);
  assert.ok(finished.elapsedMs > 0);
  assert.ok(finished.wpm > 0);
  assert.ok(finished.accuracy > 0 && finished.accuracy <= 100);
  // The finish instant is inside the hard limit for the shipped catalog range.
  assert.ok(finished.finishedAtMs <= GO + RACE_LIMIT_MS);
});

test("every tier finishes a 250-character passage well inside the limit", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    const finished = aiSeatRaceAt({
      difficulty,
      passageLength: LENGTH,
      goAtMs: GO,
      nowMs: GO + RACE_LIMIT_MS,
    });
    assert.equal(finished.finished, true, `${difficulty} must finish`);
    assert.ok(
      finished.elapsedMs < RACE_LIMIT_MS,
      `${difficulty} finished in ${finished.elapsedMs}ms`,
    );
  }
});

test("hard finishes before normal, which finishes before easy", () => {
  const finishMs = (difficulty) =>
    aiSeatRaceAt({
      difficulty,
      passageLength: LENGTH,
      goAtMs: GO,
      nowMs: GO + RACE_LIMIT_MS,
    }).finishedAtMs;
  const easy = finishMs("easy");
  const normal = finishMs("normal");
  const hard = finishMs("hard");
  assert.ok(hard < normal, "hard must be quicker than normal");
  assert.ok(normal < easy, "normal must be quicker than easy");
});

test("a finished or forfeited seat is never revived or rewound", () => {
  const finished = emptySeatRace();
  finished.finished = true;
  finished.charsTyped = LENGTH;
  const after = aiSeatRaceAt({
    difficulty: "hard",
    passageLength: LENGTH,
    goAtMs: GO,
    nowMs: GO + 60_000,
    current: finished,
  });
  assert.deepEqual(after, finished);

  const left = { ...emptySeatRace(), forfeited: true, charsTyped: 12 };
  const afterForfeit = aiSeatRaceAt({
    difficulty: "hard",
    passageLength: LENGTH,
    goAtMs: GO,
    nowMs: GO + 60_000,
    current: left,
  });
  assert.deepEqual(afterForfeit, left);
});

test("the exact finish instant is the first millisecond the cursor reaches the end", () => {
  const profile = aiTypingProfile("normal");
  const finishElapsedMs = Math.ceil(LENGTH / profile.charsPerMs);
  // One millisecond before the finish the bot is still typing; at it, done.
  assert.equal(at(finishElapsedMs - 1).finished, false);
  assert.equal(at(finishElapsedMs).finished, true);
});

test("an empty or malformed passage can never make the bot finish or throw", () => {
  for (const bad of [0, -5, null, undefined, "x", NaN]) {
    const seat = aiSeatRaceAt({
      difficulty: "hard",
      passageLength: bad,
      goAtMs: GO,
      nowMs: GO + 60_000,
      current: emptySeatRace(),
    });
    assert.equal(seat.charsTyped, 0);
    assert.equal(seat.finished, false);
  }
});
