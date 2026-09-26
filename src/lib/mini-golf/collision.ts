// src/lib/mini-golf/collision.ts
//
// Collision primitives for Mini Golf. These are the "course geometry"
// helpers: a hole is a closed rectangle (four boundary segments) plus
// interior segments, circular bumpers, sand/water circles and a cup.
//
// Everything here is pure and deterministic. The math is the generalised
// form of what `src/lib/pool/physics.ts` does for its rails and what
// `src/lib/plinko-pvp/physics.js` does for its pegs — but with the
// pool-specific parts (pockets, cue ball, spin) and the plinko-specific parts
// (peg grid, buckets) removed, so it applies to any wall-based top-down game.
//
// All helpers take the ball by reference and mutate it, matching the style of
// `tickPhysics` in the pool engine, so the hot loop stays allocation-free.

import { clamp, closestPointOnSegment, reflectVelocity, type Vec2 } from "../physics2d/kinematics";
import type { Ball, HoleGeometry, Segment } from "./types";

/**
 * The four boundary segments of a hole's rectangle, each carrying a fixed
 * inward normal.
 *
 * The inward normal is what makes overshoot safe: if a fast ball ends up
 * outside the rectangle, the radial (ball − closest point) normal would point
 * OUTWARD and push it further out. A fixed inward normal always recovers.
 */
export function boundarySegments(width: number, height: number): Segment[] {
  return [
    { a: { x: 0, y: 0 }, b: { x: width, y: 0 }, inward: { x: 0, y: 1 } },
    { a: { x: width, y: height }, b: { x: 0, y: height }, inward: { x: 0, y: -1 } },
    { a: { x: 0, y: height }, b: { x: 0, y: 0 }, inward: { x: 1, y: 0 } },
    { a: { x: width, y: 0 }, b: { x: width, y: height }, inward: { x: -1, y: 0 } },
  ];
}

/**
 * Resolve a ball against a segment.
 *
 * Returns true when the ball overlapped the segment and was pushed out
 * (a bounce may or may not have been applied, depending on approach
 * direction). Pure position correction when the ball is already separating.
 */
export function resolveSegmentCollision(
  ball: Ball,
  segment: Segment,
  restitution: number,
): boolean {
  const cp = closestPointOnSegment(
    ball.x,
    ball.y,
    segment.a.x,
    segment.a.y,
    segment.b.x,
    segment.b.y,
  );

  let nx: number;
  let ny: number;
  let penetration: number;

  if (segment.inward) {
    // Fixed inward normal: measure how far the ball is from the wall along
    // that normal. Positive = still inside.
    nx = segment.inward.x;
    ny = segment.inward.y;
    const along = (ball.x - cp.x) * nx + (ball.y - cp.y) * ny;
    if (along >= ball.radius) return false;
    penetration = ball.radius - along;
  } else {
    const dx = ball.x - cp.x;
    const dy = ball.y - cp.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= ball.radius) return false;
    if (dist > 1e-9) {
      nx = dx / dist;
      ny = dy / dist;
    } else {
      // Ball centre exactly on the segment — derive a perpendicular.
      const ex = segment.b.x - segment.a.x;
      const ey = segment.b.y - segment.a.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-9) return false;
      nx = -ey / len;
      ny = ex / len;
    }
    penetration = ball.radius - dist;
  }

  if (penetration <= 0) return false;

  // Push out first…
  ball.x += nx * penetration;
  ball.y += ny * penetration;

  // …then bounce only if the ball is still travelling into the surface.
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    const bounced = reflectVelocity(ball.vx, ball.vy, nx, ny, restitution);
    ball.vx = bounced.vx;
    ball.vy = bounced.vy;
  }
  return true;
}

/**
 * Resolve a ball against a circular obstacle (bumper / sand / water treated
 * as a solid disc). Returns true when an overlap was corrected.
 */
export function resolveCircleCollision(
  ball: Ball,
  obstacle: { x: number; y: number; r: number },
  restitution: number,
): boolean {
  const dx = ball.x - obstacle.x;
  const dy = ball.y - obstacle.y;
  const minDist = obstacle.r + ball.radius;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return false;

  const dist = Math.sqrt(distSq);
  let nx: number;
  let ny: number;
  if (dist > 1e-9) {
    nx = dx / dist;
    ny = dy / dist;
  } else {
    // Degenerate: centre exactly on the obstacle centre — push straight up.
    nx = 0;
    ny = -1;
  }

  const penetration = minDist - dist;
  ball.x += nx * penetration;
  ball.y += ny * penetration;

  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    const bounced = reflectVelocity(ball.vx, ball.vy, nx, ny, restitution);
    ball.vx = bounced.vx;
    ball.vy = bounced.vy;
  }
  return true;
}

/** True when the point is strictly inside the circle. */
export function isInsideCircle(
  point: Vec2,
  circle: { x: number; y: number; r: number },
): boolean {
  const dx = point.x - circle.x;
  const dy = point.y - circle.y;
  return dx * dx + dy * dy < circle.r * circle.r;
}

/** True when the ball's centre is inside the circle. */
export function isBallInsideCircle(
  ball: Ball,
  circle: { x: number; y: number; r: number },
): boolean {
  return isInsideCircle({ x: ball.x, y: ball.y }, circle);
}

/** True when the ball's centre is inside the cup. */
export function isBallInCup(ball: Ball, cup: HoleGeometry["cup"]): boolean {
  const dx = ball.x - cup.x;
  const dy = ball.y - cup.y;
  return dx * dx + dy * dy <= cup.r * cup.r;
}

/**
 * Keep the ball inside the playable rectangle. A belt-and-braces clamp after
 * collision resolution: the fixed inward normals should already have done
 * this, but clamping makes "the ball is never out of bounds" an invariant
 * tests can assert unconditionally.
 */
export function clampBallToCourse(ball: Ball, width: number, height: number): void {
  ball.x = clamp(ball.x, ball.radius, Math.max(ball.radius, width - ball.radius));
  ball.y = clamp(ball.y, ball.radius, Math.max(ball.radius, height - ball.radius));
}

/**
 * Shortest distance from a point to a segment. Re-exported here so the course
 * validator (which reasons about hole geometry) has one import surface.
 */
export function distancePointToSegment(
  point: Vec2,
  segment: Segment,
): number {
  const cp = closestPointOnSegment(
    point.x,
    point.y,
    segment.a.x,
    segment.a.y,
    segment.b.x,
    segment.b.y,
  );
  return Math.hypot(point.x - cp.x, point.y - cp.y);
}
