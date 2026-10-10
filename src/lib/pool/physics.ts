import {
  BALL_R,
  FRICTION,
  MAX_SUBSTEP_PX,
  POCKET_R,
  POCKETS,
  RAIL,
  RAIL_DAMPING,
  STOP_EPSILON,
  TABLE_H,
  TABLE_W,
} from "./constants";
import { substepCount } from "../physics2d/kinematics";
import { Ball, ShotMeta } from "./types";

export const isMoving = (balls: Ball[]) =>
  balls.some(
    (b) => (!b.pocketed && (b.vx !== 0 || b.vy !== 0)) || b.animatingPocket,
  );

export function applyShotPower(pull: number) {
  const t = Math.min(1, Math.max(0.08, pull / 120));
  return 3.0 + Math.pow(t, 1.2) * 22.0;
}

// Ball-on-ball restitution. Must stay in step with the impulse the collision
// resolver below applies (equal masses: `impulse = -(1 + e) · rel / 2`).
const RESTITUTION = 0.96;

/**
 * Fraction of the cue ball's speed carried into the object ball along the
 * contact normal. For equal masses that is `(1 + RESTITUTION) / 2`, so this is
 * the number the table actually resolves to — exported so the aim guide's pace
 * estimate reasons with the same physics the shot will obey.
 */
export const CUE_TRANSFER = (1 + RESTITUTION) / 2;

const SPIN_SWERVE = 0.018;
const SPIN_FOLLOW = 0.65;
const SPIN_DRAW = 0.55;
const SPIN_RAIL = 0.28;

/**
 * Advance one tick of ball-on-ball contact for the whole table.
 *
 * Runs once per SUBSTEP: resolving contacts against a position the balls
 * actually crossed is what stops a fast ball from passing through a slow one
 * between two ticks.
 */
function resolveBallCollisions(balls: Ball[], shotMeta: ShotMeta) {
  for (let i = 0; i < balls.length; i++)
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i],
        b = balls[j];
      if (a.pocketed || b.pocketed || a.animatingPocket || b.animatingPocket)
        continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = BALL_R * 2;
      if (dist > 0 && dist < minDist) {
        const nx = dx / dist,
          ny = dy / dist;
        const overlap = minDist - dist + 0.01;
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;
        const rvx = b.vx - a.vx,
          rvy = b.vy - a.vy;
        const rel = rvx * nx + rvy * ny;
        if (rel < 0) {
          const impulse = (-(1 + RESTITUTION) * rel) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;

          // Spin follow/draw on cue ball contact
          if (a.number === 0 && a.spinX !== undefined && a.spinY !== undefined) {
            const spinY = a.spinY ?? 0;
            if (spinY > 0.01) {
              // Follow: cue ball continues forward along contact normal
              const followImpulse = impulse * SPIN_FOLLOW * spinY;
              a.vx += nx * followImpulse;
              a.vy += ny * followImpulse;
            } else if (spinY < -0.01) {
              // Draw: cue ball pulls back opposite to contact normal
              const drawImpulse = impulse * SPIN_DRAW * Math.abs(spinY);
              a.vx -= nx * drawImpulse;
              a.vy -= ny * drawImpulse;
            }
          } else if (b.number === 0 && b.spinX !== undefined && b.spinY !== undefined) {
            const spinY = b.spinY ?? 0;
            if (spinY > 0.01) {
              const followImpulse = impulse * SPIN_FOLLOW * spinY;
              b.vx -= nx * followImpulse;
              b.vy -= ny * followImpulse;
            } else if (spinY < -0.01) {
              const drawImpulse = impulse * SPIN_DRAW * Math.abs(spinY);
              b.vx += nx * drawImpulse;
              b.vy += ny * drawImpulse;
            }
          }
        }
        if (
          shotMeta.firstContactNumber === null &&
          (a.number === 0 || b.number === 0)
        ) {
          shotMeta.firstContactNumber = a.number === 0 ? b.number : a.number;
        }
      }
    }
}

/**
 * One 60 Hz physics tick for the whole table.
 *
 * SUBSTEPPED. Velocities are table units per tick and a full-power shot moves a
 * ball ~25 units — further than a ball diameter and further than a pocket mouth.
 * Integrating that as one jump per tick let fast balls tunnel through each other
 * and skip the pocket mouths (the rail clamp then bounced the ball back out, so
 * pots "didn't go in" — and every bot that plans a shot through this same engine
 * planned one that could not drop). Each tick is therefore split into substeps
 * of at most MAX_SUBSTEP_PX, with contacts and pot capture evaluated against
 * positions the ball really crossed.
 *
 * The substep count is driven by the FASTEST ball on the table, so no ball can
 * cross more than the budget. Friction is distributed across the substeps
 * (`FRICTION ** (1 / steps)` each), so one tick's damping — and therefore the
 * whole rollout — is exactly the same however many substeps there are.
 */
export function tickPhysics(balls: Ball[], shotMeta: ShotMeta) {
  // A pot's fade-to-pocket animation is a per-TICK effect: it must look the same
  // however far the balls happened to travel in the tick.
  for (const b of balls) {
    if (b.pocketed || !b.animatingPocket) continue;
    b.opacity = Math.max(0, (b.opacity ?? 1) - 0.12);
    b.scale = Math.max(0.2, (b.scale ?? 1) - 0.09);
    if ((b.opacity ?? 0) <= 0.02) {
      b.pocketed = true;
      b.animatingPocket = false;
    }
  }

  let fastest = 0;
  for (const b of balls) {
    if (b.pocketed || b.animatingPocket) continue;
    fastest = Math.max(fastest, Math.hypot(b.vx, b.vy));
  }
  const steps = substepCount(fastest, MAX_SUBSTEP_PX);
  const damping = Math.pow(FRICTION, 1 / steps);

  // Sidespin swerve is a per-tick force, so it is applied once, from the tick's
  // own velocity, rather than once per substep.
  for (const b of balls) {
    if (b.pocketed || b.animatingPocket) continue;
    if (b.number === 0 && b.spinX && Math.abs(b.spinX) > 0.01) {
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 0.1) {
        const nx = b.vx / speed;
        const ny = b.vy / speed;
        const swerveForce = (b.spinX ?? 0) * speed * SPIN_SWERVE;
        b.vx += -ny * swerveForce;
        b.vy += nx * swerveForce;
      }
    }
  }

  // A contact that already exists when the tick starts (a rack, or a ball that
  // was left touching another) is resolved FIRST, against the velocity the two
  // balls are approaching with. Doing it after the movement would let a fast ball
  // pass the other ball's centre inside the tick, where the contact normal has
  // flipped and the pair looks like it is separating — which is exactly how a
  // point-blank shot failed to push the ball it hit.
  resolveBallCollisions(balls, shotMeta);

  for (let s = 0; s < steps; s++) {
    for (const b of balls) {
      if (b.pocketed || b.animatingPocket) continue;

      b.x += b.vx / steps;
      b.y += b.vy / steps;

      b.vx *= damping;
      b.vy *= damping;

      // Stop tiny sliding velocities
      const speed = Math.hypot(b.vx, b.vy);

      if (speed < STOP_EPSILON) {
        b.vx = 0;
        b.vy = 0;
      }

      for (const [px, py] of POCKETS) {
        const dist = Math.hypot(b.x - px, b.y - py);
        if (b.number === 0 && dist < POCKET_R - 2) {
          b.pocketed = true;
          b.x = px;
          b.y = py;
          shotMeta.cueScratch = true;
        } else if (b.number !== 0 && dist < POCKET_R + BALL_R * 0.35) {
          b.animatingPocket = true;
          b.vx = 0;
          b.vy = 0;
          const nx = (b.x - px) / (dist || 1),
            ny = (b.y - py) / (dist || 1);
          b.x = px + nx * (POCKET_R - BALL_R * 0.5);
          b.y = py + ny * (POCKET_R - BALL_R * 0.5);
          shotMeta.pocketedNumbers.push(b.number);
        }
      }

      if (b.pocketed || b.animatingPocket) continue;

      if (b.x < RAIL + BALL_R || b.x > TABLE_W - RAIL - BALL_R) {
        b.x = Math.max(RAIL + BALL_R, Math.min(TABLE_W - RAIL - BALL_R, b.x));
        b.vx *= -RAIL_DAMPING;
        // Sidespin (spinX) modifies the rail bounce angle
        if (b.number === 0 && Math.abs(b.spinX ?? 0) > 0.01) {
          const spinEffect = (b.spinX ?? 0) * SPIN_RAIL;
          b.vy += b.vx * spinEffect;
        }
        shotMeta.railAfterContact = true;
      }
      if (b.y < RAIL + BALL_R || b.y > TABLE_H - RAIL - BALL_R) {
        b.y = Math.max(RAIL + BALL_R, Math.min(TABLE_H - RAIL - BALL_R, b.y));
        b.vy *= -RAIL_DAMPING;
        if (b.number === 0 && Math.abs(b.spinX ?? 0) > 0.01) {
          const spinEffect = (b.spinX ?? 0) * SPIN_RAIL;
          b.vx += b.vy * spinEffect;
        }
        shotMeta.railAfterContact = true;
      }
    }

    resolveBallCollisions(balls, shotMeta);
  }
}
