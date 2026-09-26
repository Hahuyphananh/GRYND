// src/lib/physics2d/kinematics.ts
//
// Generic, game-agnostic 2D kinematics helpers shared by GRYND's
// simulations.
//
// Nothing here knows about pool, plinko, mini golf, pockets, pegs or holes —
// it is only the vector/integration/collision math those games have in common.
// Keeping it separate is what stops each new game from re-implementing
// reflection, substepping and path shaping a third time.
//
// Pure functions only. No randomness, no clocks, no mutable module state.

export type Vec2 = { x: number; y: number };

export type Velocity = { vx: number; vy: number };

/** Clamp `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Euclidean length of (x, y). */
export function length(x: number, y: number): number {
  return Math.hypot(x, y);
}

/** Normalise (x, y), returning (0, 0) for a zero-length vector. */
export function normalize(x: number, y: number): Vec2 {
  const len = Math.hypot(x, y);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/**
 * Number of substeps needed to keep a single substep's travel under
 * `maxPx`. Prevents tunneling through thin walls at high speed — the same
 * trick Plinko uses for its peg field.
 */
export function substepCount(speed: number, maxPx: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  if (!Number.isFinite(maxPx) || maxPx <= 0) return 1;
  return Math.max(1, Math.ceil(speed / maxPx));
}

/**
 * Reflect a velocity off a surface with unit normal (nx, ny).
 *
 * `restitution` is the normal-direction energy retention in [0, 1]:
 *   1 = perfectly elastic, 0 = dead stop against the surface.
 * The tangential component is preserved (no surface friction here — that is
 * applied separately as global damping).
 */
export function reflectVelocity(
  vx: number,
  vy: number,
  nx: number,
  ny: number,
  restitution: number,
): Velocity {
  const dot = vx * nx + vy * ny;
  const scale = 1 + restitution;
  return {
    vx: vx - scale * dot * nx,
    vy: vy - scale * dot * ny,
  };
}

/** Closest point on the segment (ax, ay)–(bx, by) to the point (px, py). */
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Vec2 {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-12) return { x: ax, y: ay };
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return { x: ax + abx * t, y: ay + aby * t };
}

/** Shortest distance from the point (px, py) to the segment (a)–(b). */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const cp = closestPointOnSegment(px, py, ax, ay, bx, by);
  return Math.hypot(px - cp.x, py - cp.y);
}

/**
 * Drop consecutive points closer than `tolerance` (per-axis). Keeps the
 * trajectory payload small without changing its endpoints' meaning: the
 * caller is responsible for pinning the first and last entries.
 *
 * The first point is always preserved.
 */
export function dedupePath(points: Vec2[], tolerance: number): Vec2[] {
  if (!Array.isArray(points) || points.length === 0) return [];
  const out: Vec2[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const curr = points[i];
    if (
      Math.abs(prev.x - curr.x) > tolerance ||
      Math.abs(prev.y - curr.y) > tolerance
    ) {
      out.push({ x: curr.x, y: curr.y });
    }
  }
  return out;
}
