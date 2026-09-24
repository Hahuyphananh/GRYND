// tests/ai-difficulty.test.mjs
//
// Regression test for the shared AI-difficulty scale (`src/lib/aiDifficulty.ts`),
// which every casino game's lobby picker and AI policy now sits on.
//
// Two things must hold or the whole feature is cosmetic:
//
//   1. `coerceAiDifficulty` maps EVERY vocabulary this repo shipped onto the
//      canonical `easy | normal | hard`. If it does not, an older client's
//      request, or a stored preference from before the scale existed, silently
//      degrades to the default and the player's choice is ignored.
//   2. `chooseAiOption` actually changes how well the AI plays. `normal` must
//      reproduce the ~12%-slip behaviour the games shipped with, so enabling a
//      tier for an existing game cannot change its default difficulty; and a
//      slip must never be an absurd move (bounded by the tier's slip pool).
//
// Run: npm run test:ai-difficulty

import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_DIFFICULTIES,
  AI_DIFFICULTY_LABELS,
  AI_SKILL,
  DEFAULT_AI_DIFFICULTY,
  chooseAiOption,
  coerceAiDifficulty,
  isAiDifficulty,
  readStoredAiDifficulty,
} from "../src/lib/aiDifficulty.ts";
import { BASE_AI_AIM_SPREAD_RAD, poolAiAimSpreadRad } from "../src/lib/pool/ai.ts";
import {
  CRASH_AI_DIFFICULTIES,
  crashAiDifficultyLabel,
  getCrashBotFoldTarget,
  toCrashAiDifficulty,
} from "../src/lib/crash-arena/botStrategy.js";

// pool-masters' in-match planner is a separate, lightweight planner from the
// full engine in `lib/pool/ai.ts`, and it used a flat ±0.035 rad aim jitter that
// ignored the tier entirely. The tier has to reach it, and it has to reach it
// WITHOUT changing what `normal` does — that planner is what a live practice
// match plays, so a default-tier regression there is a visible gameplay change.
test("pool's in-match planner gets a per-tier aim spread that leaves normal untouched", () => {
  const easy = poolAiAimSpreadRad("easy");
  const normal = poolAiAimSpreadRad("normal");
  const hard = poolAiAimSpreadRad("hard");

  // `normal` is exactly the spread the planner shipped with.
  assert.equal(normal, BASE_AI_AIM_SPREAD_RAD);
  // The tiers must be ordered and distinct, or picking one does nothing.
  assert.ok(easy > normal, "easy must miss more than normal");
  assert.ok(hard < normal, "hard must miss less than normal");
  assert.ok(new Set([easy, normal, hard]).size === 3, "the tiers must differ");
  // A missing/legacy value plays the default rather than some arbitrary tier.
  assert.equal(poolAiAimSpreadRad(null), normal);
  assert.equal(poolAiAimSpreadRad(undefined), normal);
  assert.equal(poolAiAimSpreadRad("hard"), hard);
});

// Crash Arena's seats and rows already store `medium` from before the shared
// scale existed, so the lobby picker's canonical `normal` has to arrive at the
// SAME tier — otherwise a player who picks Normal in the lobby gets a different
// bot than the `medium` they used to get.
test("crash-arena accepts the canonical tier names as its own stored ones", () => {
  // The canonical spelling and this game's stored spelling are one tier.
  assert.equal(toCrashAiDifficulty("normal"), "medium");
  assert.equal(toCrashAiDifficulty("medium"), "medium");
  assert.equal(toCrashAiDifficulty("easy"), "easy");
  assert.equal(toCrashAiDifficulty("hard"), "hard");
  // Anything unexpected must land on the middle tier, never on `easy` — an
  // unrecognised value must not quietly hand the player a weaker bot.
  assert.equal(toCrashAiDifficulty(undefined), "medium");
  assert.equal(toCrashAiDifficulty(null), "medium");
  assert.equal(toCrashAiDifficulty(""), "medium");
  assert.equal(toCrashAiDifficulty("bogus"), "medium");
  // Every stored key the game already has must still resolve to itself, or an
  // existing row would change tier on the next round.
  for (const key of CRASH_AI_DIFFICULTIES) {
    assert.equal(toCrashAiDifficulty(key), key);
  }
  // The player never sees two names for one tier: `medium` renders as Normal.
  assert.equal(crashAiDifficultyLabel("medium"), "Normal");
  assert.equal(crashAiDifficultyLabel("normal"), "Normal");
  assert.equal(crashAiDifficultyLabel("easy"), "Easy");
  assert.equal(crashAiDifficultyLabel("hard"), "Hard");
});

test("crash-arena's bot still folds per tier when handed a canonical tier name", () => {
  // The bug this guards: the routes used to test membership in the STORED list,
  // so a canonical `normal` from the shared picker failed the check and fell
  // back — fine for `normal`, silently wrong if the lists ever diverge.
  for (const tier of ["easy", "normal", "hard"]) {
    const target = getCrashBotFoldTarget(tier);
    assert.equal(typeof target, "number");
    assert.ok(Number.isFinite(target), `${tier} must produce a fold target`);
  }
  // The bands are ordered, so the tiers are genuinely different; a fixed
  // algorithm over many draws must separate them.
  const mean = (tier) => {
    let sum = 0;
    for (let i = 0; i < 400; i += 1) sum += getCrashBotFoldTarget(tier);
    return sum / 400;
  };
  const easy = mean("easy");
  const normal = mean("normal");
  const hard = mean("hard");
  assert.ok(easy < normal, "easy must fold earlier than normal");
  assert.ok(normal < hard, "hard must fold later than normal");
});

test("the canonical scale is easy | normal | hard, with normal as the default", () => {
  assert.deepEqual(AI_DIFFICULTIES, ["easy", "normal", "hard"]);
  assert.equal(DEFAULT_AI_DIFFICULTY, "normal");
  assert.equal(isAiDifficulty("normal"), true);
  // Every tier renders, or the picker would show a blank chip.
  for (const tier of AI_DIFFICULTIES) {
    assert.equal(typeof AI_DIFFICULTY_LABELS[tier], "string");
    assert.ok(AI_DIFFICULTY_LABELS[tier].length > 0);
  }
});

test("every vocabulary this repo shipped coerces onto the canonical scale", () => {
  // Canonical values pass through untouched.
  assert.equal(coerceAiDifficulty("easy"), "easy");
  assert.equal(coerceAiDifficulty("normal"), "normal");
  assert.equal(coerceAiDifficulty("hard"), "hard");

  // hex-duel + the dice-flush/poker/crash legacy spelling.
  assert.equal(coerceAiDifficulty("medium"), "normal");
  assert.equal(coerceAiDifficulty("MEDIUM"), "normal");

  // four-in-a-row's static label, and other soft synonyms.
  assert.equal(coerceAiDifficulty("casual"), "easy");
  assert.equal(coerceAiDifficulty("beginner"), "easy");
  assert.equal(coerceAiDifficulty("expert"), "hard");
  assert.equal(coerceAiDifficulty("pro"), "hard");

  // chess's 1–5 numeric levels.
  assert.equal(coerceAiDifficulty(1), "easy");
  assert.equal(coerceAiDifficulty(2), "easy");
  assert.equal(coerceAiDifficulty(3), "normal");
  assert.equal(coerceAiDifficulty(4), "hard");
  assert.equal(coerceAiDifficulty(5), "hard");
  assert.equal(coerceAiDifficulty("4"), "hard");

  // Unusable input must fall back, never throw: this runs on values arriving
  // from a client or a stored preference.
  for (const junk of [undefined, null, "", "  ", {}, [], NaN, Infinity, "legendary"]) {
    assert.equal(coerceAiDifficulty(junk), DEFAULT_AI_DIFFICULTY);
  }
});

test("hard always takes the best option", () => {
  const options = [{ v: 10 }, { v: 30 }, { v: 20 }];
  const score = (o) => o.v;
  // A random that always "slips" must still not move `hard` off the best.
  for (let i = 0; i < 50; i++) {
    assert.equal(chooseAiOption("hard", options, score, () => 0)?.v, 30);
  }
  assert.equal(AI_SKILL.hard.mistakeRate, 0);
});

test("normal keeps the ~12% slip the games shipped with, and never picks the best on a slip", () => {
  // `random()` is consulted twice per decision on a slip (roll, then pick), so
  // drive it deterministically: 0.0 < mistakeRate → slip.
  const options = [{ v: 30 }, { v: 20 }, { v: 10 }, { v: 5 }];
  const slipped = chooseAiOption(
    "normal",
    options,
    (o) => o.v,
    () => 0
  );
  assert.notEqual(slipped.v, 30, "a slip must not take the best option");

  // A random above the mistake rate takes the best.
  const stayed = chooseAiOption(
    "normal",
    options,
    (o) => o.v,
    () => 0.99
  );
  assert.equal(stayed.v, 30);

  assert.ok(AI_SKILL.normal.mistakeRate > 0 && AI_SKILL.normal.mistakeRate < 0.2);
});

test("easy slips far more often than normal, so the tiers are actually different", () => {
  assert.ok(
    AI_SKILL.easy.mistakeRate > AI_SKILL.normal.mistakeRate,
    "easy must blunder more than normal"
  );
  const options = [{ v: 30 }, { v: 20 }, { v: 10 }, { v: 5 }, { v: 1 }];
  const countBest = (tier) => {
    let best = 0;
    const seq = [0.01, 0.9, 0.3, 0.7, 0.05, 0.5];
    let i = 0;
    const random = () => seq[i++ % seq.length];
    for (let n = 0; n < 600; n++) {
      if (chooseAiOption(tier, options, (o) => o.v, random).v === 30) best += 1;
    }
    return best;
  };
  assert.ok(
    countBest("easy") < countBest("hard"),
    "easy must find the best option less often than hard"
  );
});

test("a slip is a WEAKER move, never an absurd one — bounded by the tier's slip pool", () => {
  // 12 options; easy's pool is the top 4, so the worst an easy agent can pick
  // is the 4th best — not the 1.0 at the bottom. (Taking "best" is not a
  // mistake, which is why the pool starts at index 1.)
  const options = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((v) => ({ v }));
  const pool = AI_SKILL.easy.slipPool;
  const worstAllowed = options[pool - 1].v;

  // Sweep the pick random so every index in the pool is exercised.
  for (let step = 0; step < 200; step++) {
    let call = 0;
    const random = () => (call++ === 0 ? 0 : (step % 50) / 50);
    const picked = chooseAiOption("easy", options, (o) => o.v, random);
    assert.ok(
      picked.v >= worstAllowed,
      `easy must stay within the top ${pool} (picked ${picked.v}, floor ${worstAllowed})`
    );
    assert.ok(picked.v < 12, "a slip still must not be the best option");
  }
});

test("an empty option list yields null rather than crashing the AI's turn", () => {
  assert.equal(
    chooseAiOption("easy", [], () => 0),
    null
  );
  assert.equal(
    chooseAiOption("hard", [], () => 0),
    null
  );
});

test("a single option is returned regardless of the roll", () => {
  assert.equal(
    chooseAiOption(
      "easy",
      [{ v: 7 }],
      (o) => o.v,
      () => 0
    )?.v,
    7
  );
});

test("storage is server-safe and falls back to the default off the browser", () => {
  // No `window` under node — the helper must not throw, so an API route that
  // imports this module (to validate an incoming difficulty) stays safe.
  assert.equal(readStoredAiDifficulty("dice-flush"), DEFAULT_AI_DIFFICULTY);
});
