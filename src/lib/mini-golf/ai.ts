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
import { simulateShot } from "./physics";
import type { Hole, ShotInput, Vec2 } from "./types";

/** Angular deviations from the direct cup line, tried in order. */
const ANGLE_OFFSETS = [
  0, 4, -4, 9, -9, 16, -16, 25, -25, 38, -38, 55, -55, 75, -75, 100, -100,
  130, -130, 160, -160, 180,
];

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

/** Candidate powers for a shot from `distance` px away from the cup. */
function candidatePowers(distanceToCup: number): number[] {
  const atLeastMin = (p: number) => clampPower(Math.max(AI_MIN_POWER, p));
  const stopPower = powerToStopAt(distanceToCup);
  // A firm putt (which still arrives slow enough to drop when it is close),
  // a mid option, and full power for bank shots around a blocked line.
  const set = [atLeastMin(stopPower), atLeastMin(stopPower * 1.6), 55, POWER_MAX];
  return [...new Set(set.map((p) => Math.round(p)))].sort((a, b) => a - b);
}

/**
 * Pick the bot's shot from `from` on `hole`. Deterministic: the candidate set
 * and the simulator are both pure, so the same input always yields the same
 * { angle, power }.
 */
export function chooseAiShot({
  hole,
  from,
}: {
  hole: Hole;
  from: Vec2;
}): ShotInput {
  const cup = hole.geometry.cup;
  const direct = angleBetween(from, cup);
  const distanceToCup = distance(from, cup);
  const powers = candidatePowers(distanceToCup);

  let best: { score: number; angle: number; power: number } | null = null;

  for (const offset of ANGLE_OFFSETS) {
    const angle = normalizeAngle(direct + offset);
    for (const power of powers) {
      const result = simulateShot({ hole, from, shot: { angle, power } });

      if (result.pocketed) {
        return { angle, power };
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

  // Unreachable in practice (ANGLE_OFFSETS is never empty), but a bot must
  // always return a legal shot.
  return best
    ? { angle: best.angle, power: best.power }
    : { angle: direct, power: POWER_MAX };
}
