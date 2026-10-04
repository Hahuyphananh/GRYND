// src/lib/mini-golf/ai.ts
//
// The Mini Golf practice bot. PURE and DETERMINISTIC — no DB, no I/O, no
// randomness (not even Math.random), so an AI match replays identically from
// its stored seed and shots.
//
// HOW IT PLAYS
//   A greedy one-ply search over a bounded candidate set of (angle, power)
//   shots, scored with the REAL deterministic simulator
//   (src/lib/mini-golf/physics.ts). If any candidate holes out, it picks that
//   shot; otherwise it picks the candidate whose ball rests closest to the cup
//   (penalising water, which would replay the stroke at +1). Because the search
//   runs the full trajectory — walls, bumpers and bank shots included — the bot
//   can find a bounce into the cup, not just a straight putt.
//
// DIFFICULTY
//   `hard` searches the full candidate set with a small execution error, so it
//   is clearly the strongest tier but no longer perfect. Weaker tiers search a
//   coarser set of angles with fewer power options and mis-execute the chosen
//   shot far more. The execution error is scaled DOWN as the ball nears the cup
//   — but never to zero — so a weaker tier still finishes the hole (it just
//   takes more strokes) instead of orbiting the cup forever. Everything is a
//   pure function of the ball position, so the tier changes only how well the
//   bot plays — never the match's determinism.
//
// WHY THE SERVER RUNS IT
//   The bot never authors a ball position, a stroke count or a winner; it only
//   proposes { angle, power }, exactly like a human client. The server still
//   simulates and applies the shot, and AI matches are excluded from rating and
//   trophies (see `settleMatch` in serverStore.ts). A player CANNOT choose the
//   bot's shot, and there is nothing competitive to gain from waking it.
//
// TUNING
//   `powerToStopAt(distance)` derives the power whose shot would roll to a stop
//   at roughly the cup, from the physics constants: speed decays by FRICTION
//   per frame, so v(d) = v0 · exp(ln(FRICTION) · d). The candidate powers are
//   that value (a gentle putt) plus a softer and a full-power option (banking).

import { FRICTION, POWER_MAX, POWER_MIN } from "./constants";
import { coerceAiDifficulty } from "../aiDifficulty";
import { simulateShot } from "./physics";
import type { Hole, ShotInput, Vec2 } from "./types";

/** Angular deviations from the direct cup line, tried in order (hard). */
const ANGLE_OFFSETS = [
  0, 4, -4, 9, -9, 16, -16, 25, -25, 38, -38, 55, -55, 75, -75, 100, -100,
  130, -130, 160, -160, 180,
];

/** A coarser aim grid — `normal` sees far fewer fine distinctions. */
const NORMAL_ANGLE_OFFSETS = [
  0, 6, -6, 16, -16, 32, -32, 58, -58, 92, -92, 140, -140, 180,
];

/** The coarsest aim grid — `easy` mostly plays the obvious lines. */
const EASY_ANGLE_OFFSETS = [0, 11, -11, 28, -28, 58, -58, 100, -100, 180];

/** The three tiers the lobby offers. Mirrors the shared `easy | normal | hard`. */
export type MiniGolfAiDifficulty = "easy" | "normal" | "hard";

type MiniGolfAiTier = {
  /** Angle offsets from the direct cup line that the search evaluates. */
  offsets: number[];
  /** How many of the derived power options the search evaluates. */
  powerCount: number;
  /**
   * Peak aim error (degrees), scaled by distance but NEVER to zero.
   *
   * This used to taper to 0 within 120px of the cup, which meant every tier
   * struck perfectly exactly where the shot is decided — the last tap-in. The
   * error now keeps a floor (see `MIN_EXECUTION_ERROR`), so a weak tier still
   * misses short putts and needs more strokes.
   */
  aimErrorDeg: number;
  /** Peak power error, as a fraction of the chosen power. */
  powerError: number;
};

/**
 * The tier table.
 *
 * `hard` keeps the full candidate set, but its strike is NO LONGER perfect: it
 * carries a small execution error, so a strong player can beat it instead of it
 * playing the hole flawlessly every time. `normal` and `easy` are visibly worse
 * — a coarser aim grid, fewer power options, and much larger execution errors.
 */
export const MINI_GOLF_AI_TIERS: Record<MiniGolfAiDifficulty, MiniGolfAiTier> = {
  easy: { offsets: EASY_ANGLE_OFFSETS, powerCount: 3, aimErrorDeg: 22, powerError: 0.28 },
  normal: { offsets: NORMAL_ANGLE_OFFSETS, powerCount: 3, aimErrorDeg: 10, powerError: 0.14 },
  hard: { offsets: ANGLE_OFFSETS, powerCount: 4, aimErrorDeg: 4, powerError: 0.06 },
};

/**
 * The radius (px) inside which the strike is clean again.
 *
 * The execution error scales with distance, so a tier is far less accurate
 * across the green than it is on a tap-in. This is what guarantees every tier
 * still FINISHES the hole: without it a weak tier orbits the cup forever, which
 * reads as broken rather than easy. It used to be 120px, which made every tier
 * play the decisive final putt perfectly — the radius is now much tighter, so a
 * weak tier spends far more strokes getting into tap-in range in the first
 * place while still being able to close the hole out.
 */
const CLEAN_STRIKE_RADIUS_PX = 130;

/**
 * What the bot plays at when nothing was chosen (a legacy row, or a caller that
 * does not window the tier). `hard` preserves the pre-tier behaviour.
 */
export const DEFAULT_MINI_GOLF_AI_DIFFICULTY: MiniGolfAiDifficulty = "hard";

/** Normalize an angle into [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function angleBetween(from: Vec2, to: Vec2): number {
  return normalizeAngle(
    (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
  );
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * A bot shot must actually move the ball. A "perfectly" tuned putt for a very
 * short distance rounds to power 0, which leaves the ball where it is — the
 * greedy search then happily repeats it forever and the hole never completes.
 */
export const AI_MIN_POWER = 12;

function clampPower(power: number): number {
  if (Number.isNaN(power)) return POWER_MIN;
  return Math.min(POWER_MAX, Math.max(POWER_MIN, power));
}

/**
 * The power whose shot would decelerate to a stop approximately at `distance`.
 * Derived from the linear per-frame damping (speed decays geometrically).
 */
export function powerToStopAt(distancePx: number): number {
  const d = Math.max(0, Number(distancePx) || 0);
  // v0 such that v(d) ≈ STOP floor: v0 = stopSpeed · exp(-ln(FRICTION) · d).
  // Fr large distances the exponential overflows to Infinity, which clamps to
  // full power (the ball simply cannot reach the cup in one shot).
  const v0 = 0.05 * Math.exp(-Math.log(FRICTION) * d);
  return clampPower(v0 / 0.24);
}

/** Resolve a tier from anything the caller might hold. */
function tierFor(difficulty?: unknown): MiniGolfAiTier {
  if (difficulty === undefined || difficulty === null) {
    return MINI_GOLF_AI_TIERS[DEFAULT_MINI_GOLF_AI_DIFFICULTY];
  }
  return MINI_GOLF_AI_TIERS[coerceAiDifficulty(difficulty)];
}

/** Candidate powers for a shot from `distance` px away, capped to the tier. */
function candidatePowers(distanceToCup: number, tier: MiniGolfAiTier): number[] {
  const atLeastMin = (p: number) => clampPower(Math.max(AI_MIN_POWER, p));
  const stopPower = powerToStopAt(distanceToCup);
  // A firm putt (which still arrives slow enough to drop when it is close),
  // a mid option, and full power for bank shots around a blocked line.
  const set = [atLeastMin(stopPower), atLeastMin(stopPower * 1.6), 55, POWER_MAX];
  const rounded = [...new Set(set.map((p) => Math.round(p)))].sort((a, b) => a - b);
  // A weaker tier only tries the softest options, so it cannot rescue a shot
  // with the extra pace a stronger tier would consider.
  return tier.powerCount >= rounded.length ? rounded : rounded.slice(0, tier.powerCount);
}

/**
 * Apply a tier's execution error to the chosen shot. Deterministic (a pure
 * function of the ball position), and tapered down as the ball approaches the
 * cup so a messy tier still finishes the hole rather than circling it.
 */
function applyExecutionError(
  shot: ShotInput,
  tier: MiniGolfAiTier,
  from: Vec2,
  distanceToCup: number,
): ShotInput {
  if (tier.aimErrorDeg === 0 && tier.powerError === 0) return shot;
  // Full error at range, tapering to a clean strike inside the tap-in radius so
  // the hole can always be closed out.
  const closeness = Math.min(1, distanceToCup / CLEAN_STRIKE_RADIUS_PX);
  const angleWobble = Math.sin(from.x * 0.091 + from.y * 0.057 + 1.3);
  const powerWobble = Math.cos(from.x * 0.043 + from.y * 0.069);
  return {
    angle: normalizeAngle(shot.angle + tier.aimErrorDeg * closeness * angleWobble),
    power: clampPower(shot.power * (1 + tier.powerError * powerWobble)),
  };
}

/**
 * Pick the bot's shot from `from` on `hole`. Deterministic: the candidate set,
 * the simulator and the tier's execution error are all pure, so the same input
 * always yields the same { angle, power }.
 */
export function chooseAiShot({
  hole,
  from,
  difficulty,
}: {
  hole: Hole;
  from: Vec2;
  /** easy | normal | hard; anything unrecognised plays the default. */
  difficulty?: MiniGolfAiDifficulty | string | null;
}): ShotInput {
  const tier = tierFor(difficulty);
  const cup = hole.geometry.cup;
  const direct = angleBetween(from, cup);
  const distanceToCup = distance(from, cup);
  const powers = candidatePowers(distanceToCup, tier);

  let pocketed: { angle: number; power: number } | null = null;
  let best: { score: number; angle: number; power: number } | null = null;

  search: for (const offset of tier.offsets) {
    const angle = normalizeAngle(direct + offset);
    for (const power of powers) {
      const result = simulateShot({ hole, from, shot: { angle, power } });

      if (result.pocketed) {
        pocketed = { angle, power };
        break search;
      }

      const restDistance = distance(result.restPosition, cup);
      // A water landing replays the stroke and costs a penalty, so it is
      // strongly de-preferred unless it somehow ends closer to the cup.
      const score = restDistance + (result.waterHits > 0 ? 5000 : 0);

      if (best === null || score < best.score) {
        best = { score, angle, power };
      }
    }
  }

  // Unreachable in practice (every tier's offset list is never empty), but a
  // bot must always return a legal shot.
  const shot: ShotInput =
    pocketed ?? best ?? { angle: direct, power: POWER_MAX };
  return applyExecutionError(shot, tier, from, distanceToCup);
}
