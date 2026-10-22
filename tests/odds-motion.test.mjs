/**
 * Odds — motion helpers (`src/components/odds/oddsMotion.ts`).
 *
 * The animations are built on top of pure helpers, so the things that could
 * mislead a player are testable without a DOM:
 *
 *   * `clueWindow` reads a clue sentence back into the exact window it admits.
 *     It is compared against the engine's own generator for every target in
 *     every round, in both directions: nothing inside the window is left out,
 *     and nothing outside it is ever dimmed. An unrecognised sentence must
 *     return null so the UI dims nothing at all.
 *   * `sweepDegrees` is where the reveal marker stops: the target's own segment
 *     centre on a full 1..100 circle, so the animation can only ever land on
 *     the segment that number occupies.
 *   * `revealOutcome` is hit/miss read off the server's points, not a second
 *     scoring rule.
 *   * `motionSeconds` collapses every duration to 0 under reduced motion.
 *
 * Run:  node --import tsx --test tests/odds-motion.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TARGET_MAX, TARGET_MIN, createClue } from "../src/lib/odds.ts";
import {
  CLUE_SECONDS,
  REVEAL_SECONDS,
  ZOOM_SECONDS,
  SCORE_SECONDS,
  clueWindow,
  isRuledOut,
  motionSeconds,
  revealOutcome,
  sweepDegrees,
} from "../src/components/odds/oddsMotion.ts";
import {
  RING_CENTER,
  angleForIndex,
  edgeAngleForIndex,
  polar,
} from "../src/components/odds/oddsRing.ts";

const DOMAIN = TARGET_MAX - TARGET_MIN + 1;
const ROUNDS = [1, 2, 3, 4, 5];
const ALL_VALUES = Array.from({ length: DOMAIN }, (_, index) => index + TARGET_MIN);

test("clueWindow agrees with the engine for every target and round", () => {
  for (const round of ROUNDS) {
    for (const target of ALL_VALUES) {
      const clue = createClue(target, round);
      const window = clueWindow(clue.text);
      assert.ok(window, `round ${round} target ${target}: "${clue.text}" not parsed`);

      const candidates = clue.candidates;
      assert.equal(window.min, candidates[0], `min for "${clue.text}"`);
      assert.equal(window.max, candidates[candidates.length - 1], `max for "${clue.text}"`);
      assert.equal(
        window.max - window.min + 1,
        candidates.length,
        `candidate count for "${clue.text}"`,
      );

      // Both directions: the dimmed set is exactly the impossible set.
      for (const value of ALL_VALUES) {
        const impossible = !candidates.includes(value);
        assert.equal(
          isRuledOut(value, window),
          impossible,
          `"${clue.text}" value ${value}`,
        );
      }
    }
  }
});

test("only the clue's own formats are interpreted", () => {
  assert.deepEqual(clueWindow("Higher than 20."), { min: 21, max: 100 });
  assert.deepEqual(clueWindow("Lower than 20."), { min: 1, max: 19 });
  assert.deepEqual(clueWindow("Between 40 and 60, inclusive."), { min: 40, max: 60 });
  assert.deepEqual(clueWindow("Somewhere in the upper half."), { min: 51, max: 100 });
  assert.deepEqual(clueWindow("Somewhere in the lower half."), { min: 1, max: 50 });

  // Anything else — another app's wording, extra prose, a contradictory or
  // out-of-domain range — must dim nothing rather than guess.
  for (const text of [
    null,
    undefined,
    "",
    "   ",
    "Higher than 20 maybe.",
    "higher than 20.",
    "Higher than 100.",
    "Between 60 and 40, inclusive.",
    "The number is 42.",
    "Odd number.",
  ]) {
    assert.equal(clueWindow(text), null, `should not parse: ${String(text)}`);
    assert.equal(isRuledOut(42, clueWindow(text)), false);
  }
});

test("a clue's window never claims to be tighter than the clue", () => {
  // A range clue leaves both ends included, and the parser must not shave a
  // number off either edge (that would dim a number the clue allows).
  const window = clueWindow("Between 17 and 23, inclusive.");
  assert.equal(window.min, 17);
  assert.equal(window.max, 23);
  assert.equal(isRuledOut(17, window), false);
  assert.equal(isRuledOut(23, window), false);
  assert.equal(isRuledOut(16, window), true);
  assert.equal(isRuledOut(24, window), true);
});

test("the reveal marker stops on the target's own segment", () => {
  assert.equal(sweepDegrees(1), 1.8);
  assert.equal(sweepDegrees(100), 358.2);

  for (const target of ALL_VALUES) {
    const angle = sweepDegrees(target);
    // Inside the target's segment, between its two edges.
    assert.ok(angle > edgeAngleForIndex(target - 1, DOMAIN));
    assert.ok(angle < edgeAngleForIndex(target, DOMAIN));
    // And exactly the segment centre.
    assert.equal(angle, angleForIndex(target - 1, DOMAIN));
  }

  // Clockwise from 12 o'clock, so 1 is just right of the top and 50 is at the
  // bottom; the sweep only ever grows as the target grows.
  for (let target = 2; target <= TARGET_MAX; target += 1) {
    assert.ok(sweepDegrees(target) > sweepDegrees(target - 1));
  }

  const top = polar(sweepDegrees(1), 74, RING_CENTER);
  assert.ok(
    top.x > RING_CENTER && top.y < RING_CENTER,
    "value 1 sits just clockwise of 12 o'clock",
  );
  // Value 50's segment is 49.5..50.5, so its centre is 178.2° — just short of
  // 6 o'clock, on the lower half of the circle.
  const bottom = polar(sweepDegrees(50), 74, RING_CENTER);
  assert.ok(bottom.y > RING_CENTER, "value 50 sits near 6 o'clock");
  assert.equal(sweepDegrees(50), 178.2);
});

test("hit/miss comes from the awarded points", () => {
  assert.equal(revealOutcome(1), "hit");
  assert.equal(revealOutcome(100), "hit");
  assert.equal(revealOutcome(0), "miss");
  assert.equal(revealOutcome(null), "miss");
  assert.equal(revealOutcome(undefined), "miss");
  assert.equal(revealOutcome(Number.NaN), "miss");
});

test("reduced motion collapses every duration to zero", () => {
  for (const seconds of [CLUE_SECONDS, REVEAL_SECONDS, ZOOM_SECONDS, SCORE_SECONDS]) {
    assert.ok(seconds > 0, "a normal duration is positive");
    assert.equal(motionSeconds(true, seconds), 0);
    assert.equal(motionSeconds(false, seconds), seconds);
    // Unknown reduced-motion state (null) keeps the animation.
    assert.equal(motionSeconds(null, seconds), seconds);
  }
  // Nothing is allowed to animate for long enough to block a five-round match,
  // and no value can go negative or NaN.
  assert.equal(motionSeconds(false, -1), 0);
  assert.equal(motionSeconds(false, Number.NaN), 0);
  for (const seconds of [CLUE_SECONDS, REVEAL_SECONDS, ZOOM_SECONDS, SCORE_SECONDS]) {
    assert.ok(seconds <= 1, `${seconds}s is a short, non-blocking reveal`);
  }
});
