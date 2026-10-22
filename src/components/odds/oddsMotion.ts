// src/components/odds/oddsMotion.ts
//
// Everything the Odds animations need that can be computed without React:
//
//   * `clueWindow` reads the server's clue SENTENCE back into the inclusive
//     window it admits, so the wheel can dim values the clue rules out. It is
//     deliberately strict: anything it does not recognise returns null, and
//     then nothing is dimmed — the UI never implies a limit the clue did not
//     state.
//   * `sweepDegrees` is where the reveal marker stops: the target's own segment
//     centre on a full 1..100 circle, clockwise from 12 o'clock.
//   * `revealOutcome` turns the SERVER's awarded points into hit/miss. It never
//     re-scores a prediction, so the badge cannot disagree with the ledger.
//   * `motionSeconds` is the one place reduced motion is applied.

import { TARGET_MAX, TARGET_MIN } from "../../lib/odds";
import { angleForIndex } from "./oddsRing";

export type ClueWindow = { min: number; max: number };

const HALF_SPLIT = 50;

function clampToDomain(value: number): number {
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(value)));
}

/**
 * A number from a clue sentence. Deliberately NOT clamped to the domain: a
 * boundary outside 1..100 would leave the window empty or nonsensical, and
 * `clueWindow` rejects it instead of quietly turning it into a narrow window
 * the clue never stated.
 */
function toInt(raw: string): number {
  return Math.round(Number(raw));
}

type ClueMatcher = {
  pattern: RegExp;
  window: (match: RegExpExecArray) => ClueWindow;
};

/**
 * The five clue formats the engine emits. Kept in step with
 * `src/lib/odds.ts` and pinned by tests/odds-motion.test.mjs, which compares
 * this parser against the authoritative generator for every target/round.
 */
const CLUE_MATCHERS: ClueMatcher[] = [
  {
    pattern: /^Higher than (\d{1,3})\.$/,
    window: (match) => ({ min: toInt(match[1]) + 1, max: TARGET_MAX }),
  },
  {
    pattern: /^Lower than (\d{1,3})\.$/,
    window: (match) => ({ min: TARGET_MIN, max: toInt(match[1]) - 1 }),
  },
  {
    pattern: /^Between (\d{1,3}) and (\d{1,3}), inclusive\.$/,
    window: (match) => ({ min: toInt(match[1]), max: toInt(match[2]) }),
  },
  {
    pattern: /^Somewhere in the upper half\.$/,
    window: () => ({ min: HALF_SPLIT + 1, max: TARGET_MAX }),
  },
  {
    pattern: /^Somewhere in the lower half\.$/,
    window: () => ({ min: TARGET_MIN, max: HALF_SPLIT }),
  },
];

/**
 * The inclusive window a clue admits, or null when this client does not
 * recognise the sentence (in which case NOTHING is dimmed).
 */
export function clueWindow(text: string | null | undefined): ClueWindow | null {
  if (typeof text !== "string") return null;
  const sentence = text.trim();
  if (!sentence) return null;

  for (const matcher of CLUE_MATCHERS) {
    const match = matcher.pattern.exec(sentence);
    if (!match) continue;
    const window = matcher.window(match);
    if (window.min < TARGET_MIN || window.max > TARGET_MAX) return null;
    if (window.min > window.max) return null;
    return window;
  }
  return null;
}

/** Is this number ruled out by the clue? (No clue ⇒ nothing is ruled out.) */
export function isRuledOut(
  value: number,
  window: ClueWindow | null,
): boolean {
  if (!window) return false;
  return value < window.min || value > window.max;
}

/**
 * Where the target sits on the full circle: the centre of its own segment,
 * clockwise from 12 o'clock. 1 → 1.8°, 100 → 358.2°.
 */
export function sweepDegrees(target: number): number {
  const value = clampToDomain(Number.isFinite(target) ? target : TARGET_MIN);
  return angleForIndex(value - 1, TARGET_MAX - TARGET_MIN + 1);
}

/** Hit or miss, from the points the server actually awarded. */
export function revealOutcome(
  awardedPoints: number | null | undefined,
): "hit" | "miss" {
  return Number(awardedPoints) > 0 ? "hit" : "miss";
}

/** One duration for every reveal, collapsed to 0 for reduced motion. */
export const REVEAL_SECONDS = 0.9;
export const ZOOM_SECONDS = 0.22;
export const CLUE_SECONDS = 0.28;
export const SCORE_SECONDS = 0.55;

export function motionSeconds(
  reduced: boolean | null | undefined,
  seconds: number,
): number {
  if (reduced) return 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
