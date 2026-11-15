/**
 * SOLITAIRE PUZZLE — generation determinism, answer verification and the free
 * 5-per-day unlimited allowance.
 *
 * The rules this file pins:
 *   * a puzzle is a pure function of its seed, so the submit route rebuilds the
 *     exact position the player answered;
 *   * the public payload never contains the answer;
 *   * exactly one of the three choices verifies;
 *   * the daily key is the UTC date, and its puzzle is the same for every player;
 *   * a free account gets 5 unlimited puzzles per UTC day, the 6th is denied,
 *     and GRYND PRO is never counted.
 *
 * Run: node --import tsx --test tests/solitaire-puzzle.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPuzzleForSeed,
  dailyPuzzleDateKey,
  dailyPuzzleKey,
  getDailyPuzzle,
  getUnlimitedPuzzle,
  publicPuzzle,
  puzzleSeedFromKey,
  verifyPuzzleChoice,
} from "../src/lib/solitaire-duel/puzzle.ts";
import {
  FREE_PUZZLES_PER_DAY,
  freePuzzleAllowance,
  unlimitedPuzzleAllowance,
  consumePuzzleAllowance,
  readPuzzleAllowance,
} from "../src/lib/solitaire-duel/puzzleAllowance.ts";

const DAY = new Date("2026-11-14T12:00:00Z");

test("the daily key is the UTC calendar date", () => {
  assert.equal(dailyPuzzleDateKey(DAY), "2026-11-14");
  assert.equal(dailyPuzzleDateKey(new Date("2026-11-14T23:59:59Z")), "2026-11-14");
  assert.equal(dailyPuzzleKey("2026-11-14"), "daily:2026-11-14");
});

test("an unlimited key only parses a valid uint32 seed", () => {
  assert.equal(puzzleSeedFromKey("unlimited:123"), 123);
  assert.equal(puzzleSeedFromKey("unlimited:0"), 0);
  assert.equal(puzzleSeedFromKey("unlimited:4294967295"), 4294967295);
  assert.equal(puzzleSeedFromKey("unlimited:4294967296"), null);
  assert.equal(puzzleSeedFromKey("unlimited:abc"), null);
  assert.equal(puzzleSeedFromKey("unlimited:"), null);
  assert.equal(puzzleSeedFromKey("daily:2026-11-14"), null);
});

test("a seeded puzzle is deterministic and includes three choices", () => {
  // Not every deal has a position that satisfies the puzzle contract, so find
  // a seed that does rather than pinning one that may stop qualifying.
  let seed = -1;
  let first = null;
  for (let candidate = 0; candidate < 40 && !first; candidate += 1) {
    first = buildPuzzleForSeed(candidate);
    if (first) seed = candidate;
  }
  assert.ok(first, "at least one seed in 0..39 must produce a verified puzzle");
  const second = buildPuzzleForSeed(seed);
  assert.ok(second, "rebuilding the same seed must succeed");
  assert.deepEqual(first.position, second.position);
  assert.deepEqual(first.choices, second.choices);
  assert.equal(first.answer, second.answer);

  assert.equal(first.choices.length, 3);
  assert.deepEqual(first.choices.map((choice) => choice.label), ["A", "B", "C"]);
  assert.ok(first.choices.some((choice) => choice.label === first.answer));
  assert.ok(first.position.columns.length > 0);
});

test("only the verified answer passes", () => {
  const puzzle = getUnlimitedPuzzle(777);
  assert.equal(verifyPuzzleChoice(puzzle, puzzle.answer), true);
  for (const choice of puzzle.choices) {
    if (choice.label === puzzle.answer) continue;
    assert.equal(verifyPuzzleChoice(puzzle, choice.label), false);
  }
  assert.equal(verifyPuzzleChoice(puzzle, "D"), false);
  assert.equal(verifyPuzzleChoice(puzzle, null), false);
});

test("the public payload never contains the answer", () => {
  const puzzle = getDailyPuzzle("2026-11-14");
  const safe = publicPuzzle(puzzle);
  assert.equal("answer" in safe, false);
  assert.equal("seed" in safe, false);
  assert.equal(safe.key, "daily:2026-11-14");
  assert.equal(safe.kind, "daily");
  assert.equal(safe.choices.length, 3);
});

test("the daily puzzle is identical for the same date", () => {
  const first = getDailyPuzzle("2026-11-14");
  const second = getDailyPuzzle("2026-11-14");
  assert.deepEqual(first.choices, second.choices);
  assert.equal(first.answer, second.answer);
  assert.deepEqual(first.position, second.position);
});

test("the free allowance is 5 per day and PRO is unlimited", () => {
  assert.equal(FREE_PUZZLES_PER_DAY, 5);

  const fresh = freePuzzleAllowance(0, DAY);
  assert.equal(fresh.remaining, 5);
  assert.equal(fresh.limit, 5);
  assert.equal(fresh.dayKey, "2026-11-14");

  const nearlyDone = freePuzzleAllowance(4, DAY);
  assert.equal(nearlyDone.remaining, 1);

  const pro = unlimitedPuzzleAllowance(DAY);
  assert.equal(pro.unlimited, true);
  assert.equal(pro.limit, null);
  assert.equal(pro.remaining, null);
});

test("the sixth unlimited puzzle is denied and PRO never consumes a slot", async () => {
  const rows = new Map();
  const deps = {
    readUsage: async ({ playerId, dayKey }) => rows.get(`${playerId}:${dayKey}`) ?? 0,
    consumeUsage: async ({ playerId, dayKey, limit = FREE_PUZZLES_PER_DAY }) => {
      const key = `${playerId}:${dayKey}`;
      const used = rows.get(key) ?? 0;
      if (used >= limit) return null;
      rows.set(key, used + 1);
      return used + 1;
    },
  };

  for (let index = 0; index < 5; index += 1) {
    const result = await consumePuzzleAllowance(
      { playerId: "user_1", isPro: false, now: DAY },
      deps,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.allowance.remaining, 4 - index);
  }

  const denied = await consumePuzzleAllowance(
    { playerId: "user_1", isPro: false, now: DAY },
    deps,
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowance.remaining, 0);

  const member = await consumePuzzleAllowance(
    { playerId: "user_1", isPro: true, now: DAY },
    deps,
  );
  assert.equal(member.allowed, true);
  assert.equal(member.allowance.unlimited, true);
  assert.equal(rows.get(`user_1:${dailyPuzzleDateKey(DAY)}`), 5);

  const read = await readPuzzleAllowance(
    { playerId: "user_1", isPro: false, now: DAY },
    deps,
  );
  assert.equal(read.used, 5);
  assert.equal(read.remaining, 0);
});

test("a store failure fails open rather than blocking the puzzle", async () => {
  const failing = {
    readUsage: async () => {
      throw new Error("db down");
    },
    consumeUsage: async () => {
      throw new Error("db down");
    },
  };
  const result = await consumePuzzleAllowance(
    { playerId: "user_2", isPro: false, now: DAY },
    failing,
  );
  assert.equal(result.allowed, true);
  assert.equal(result.allowance.remaining, FREE_PUZZLES_PER_DAY);
});
