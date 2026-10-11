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
  AI_TYPING_WPM,
  aiSeatRaceAt,
  aiTypingProfile,
} from "../src/lib/speed-typing/ai.ts";
import { RACE_LIMIT_MS, RESOLUTION, SEAT } from "../src/lib/speed-typing/constants.ts";
import { createRaceState, emptySeatRace, raceMetrics, resolveRace } from "../src/lib/speed-typing/rules.ts";

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
    // The rate IS the tier's WPM in the shared convention (five characters to a
    // word) — one definition, so the pace cannot drift from the announced number.
    assert.equal(profile.charsPerMs, (profile.wpm * 5) / 60_000);
  }
  // An unknown tier coerces onto the shared scale (normal), never throws.
  assert.equal(aiTypingProfile("nonsense").tier, "normal");
  assert.equal(aiTypingProfile(undefined).tier, "normal");
});

test("aiTypingProfile: hard is faster than normal, which is faster than easy", () => {
  assert.ok(AI_TYPING_WPM.hard > AI_TYPING_WPM.normal);
  assert.ok(AI_TYPING_WPM.normal > AI_TYPING_WPM.easy);
  for (const tier of ["easy", "normal", "hard"]) {
    assert.equal(aiTypingProfile(tier).wpm, AI_TYPING_WPM[tier]);
  }
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

// ── The announced WPM IS the pace that decides the race ───────────────────
//
// The bug this section exists for: the bot used to finish with `errors` still
// on its record, so it declared itself done after `length` keystrokes while the
// rules require EVERY position to match — a shorter race than its opponent's.
// Its announced WPM was then its tier rate discounted by mistakes it never paid
// for, and a player who typed faster could be beaten by a bot whose number was
// lower than theirs: the result screen disagreed with the verdict.
//
// The invariant, asserted exactly: the bot types the passage perfectly, its
// announced WPM equals its tier's WPM, and a flawless typist at that same WPM
// reaches the end at the same instant (a dead heat) — while one wpm faster wins
// and one wpm slower loses, with the numbers agreeing in every case.

/** A flawless human seat that completed the passage at `wpm`, server-measured. */
function flawlessSeat({ wpm, length = LENGTH, goAtMs = GO }) {
  const finishedAtMs = goAtMs + Math.round((length / 5) * (60_000 / wpm));
  const seat = {
    ...emptySeatRace(),
    charsTyped: length,
    errors: 0,
    finished: true,
    finishedAtMs,
  };
  const metrics = raceMetrics({ seat, goAtMs, nowMs: finishedAtMs });
  return { ...seat, elapsedMs: metrics.elapsedMs, wpm: metrics.wpm, accuracy: metrics.accuracy };
}

/** The verdict of a two-seat finish race, exactly as the store resolves it. */
function endedSeats(player1, player2) {
  return resolveRace({
    state: {
      ...createRaceState({ version: 1 }),
      seats: { [SEAT.PLAYER1]: player1, [SEAT.PLAYER2]: player2 },
    },
    reason: RESOLUTION.FINISH,
    nowMs: Math.max(player1.finishedAtMs ?? 0, player2.finishedAtMs ?? 0),
  });
}

test("the bot finishes with a PERFECT passage, so its number is its pace", () => {
  for (const tier of ["easy", "normal", "hard"]) {
    const finished = aiSeatRaceAt({
      difficulty: tier,
      passageLength: LENGTH,
      goAtMs: GO,
      nowMs: GO + RACE_LIMIT_MS,
    });
    // Reaching the end and matching every character are the same event.
    assert.equal(finished.charsTyped, LENGTH, `${tier}: the whole passage`);
    assert.equal(finished.errors, 0, `${tier}: no free mistakes`);
    assert.equal(finished.accuracy, 100, `${tier}: every character matched`);
    // The frozen numbers are the SHARED metric's, from the shared instant.
    const metrics = raceMetrics({
      seat: finished,
      goAtMs: GO,
      nowMs: finished.finishedAtMs,
    });
    assert.equal(finished.wpm, metrics.wpm, `${tier}: one WPM definition`);
    assert.equal(finished.elapsedMs, metrics.elapsedMs);
    // …and that number is the tier's own, announced as typed.
    assert.equal(finished.wpm, AI_TYPING_WPM[tier], `${tier}: announces its pace`);
  }
});

test("the numbers on the result screen agree with the verdict, at every tier", () => {
  for (const tier of ["easy", "normal", "hard"]) {
    const pace = AI_TYPING_WPM[tier];
    const bot = aiSeatRaceAt({
      difficulty: tier,
      passageLength: LENGTH,
      goAtMs: GO,
      nowMs: GO + RACE_LIMIT_MS,
    });

    // SAME WPM: the two seats reach the end at the same instant — a dead heat,
    // and the two announced numbers are equal.
    const equal = flawlessSeat({ wpm: pace });
    const tied = endedSeats(equal, bot);
    assert.equal(tied.winnerSeat, null, `${tier}: equal pace is a draw`);
    assert.equal(tied.resolutionReason, RESOLUTION.DRAW, `${tier}: photo finish`);
    assert.equal(equal.wpm, bot.wpm, `${tier}: equal numbers on a level race`);

    // ONE WPM FASTER: the human wins, and their number is the higher one.
    const faster = flawlessSeat({ wpm: pace + 1 });
    const won = endedSeats(faster, bot);
    assert.equal(won.winnerSeat, SEAT.PLAYER1, `${tier}: a faster typist wins`);
    assert.ok(
      faster.wpm > bot.wpm,
      `${tier}: the winner's announced WPM must be the higher one (${faster.wpm} vs ${bot.wpm})`,
    );

    // ONE WPM SLOWER: the bot wins, and the human's number is the lower one.
    const slower = flawlessSeat({ wpm: pace - 1 });
    const lost = endedSeats(slower, bot);
    assert.equal(lost.winnerSeat, SEAT.PLAYER2, `${tier}: a slower typist loses`);
    assert.ok(
      slower.wpm < bot.wpm,
      `${tier}: the loser's announced WPM must be the lower one (${slower.wpm} vs ${bot.wpm})`,
    );
  }
});

test("a mid-race bot reports the pace it is actually holding", () => {
  // The live readout is the same number, not a second one: no discount appears
  // at the finish that was not already visible while typing. The residual
  // ±1 wpm is the cursor's INTEGER truncation — the same floor a human's own
  // live estimate has — so it is sampled once a little of the race has passed,
  // where one character is a small fraction of the elapsed time.
  for (const tier of ["easy", "normal", "hard"]) {
    for (const t of [15_000, 20_000, 25_000, 30_000]) {
      const seat = aiSeatRaceAt({
        difficulty: tier,
        passageLength: LENGTH,
        goAtMs: GO,
        nowMs: GO + t,
      });
      const metrics = raceMetrics({ seat, goAtMs: GO, nowMs: GO + t });
      assert.ok(seat.charsTyped > 0, `${tier}@${t}: the bot is typing`);
      assert.equal(seat.errors, 0, `${tier}@${t}: nothing to discount`);
      assert.equal(metrics.accuracy, 100, `${tier}@${t}`);
      assert.ok(
        Math.abs(metrics.wpm - AI_TYPING_WPM[tier]) <= 1,
        `${tier}@${t}: live WPM reads its pace (${metrics.wpm} vs ${AI_TYPING_WPM[tier]})`,
      );
    }
  }
});
