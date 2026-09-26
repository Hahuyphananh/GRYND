// src/lib/mini-golf/physics.ts
//
// The authoritative, deterministic Mini Golf shot simulator.
//
// CONTRACT
//   Same { hole geometry, start position, angle, power } → byte-identical
//   ShotResult, in every runtime. There is NO randomness in this module:
//   no Math.random(), no Date, no client input beyond { angle, power }.
//   That is what lets the server simulate a shot and both clients replay the
//   exact same trajectory.
//
// WHAT IT DOES NOT TRUST
//   The caller cannot supply a resulting position, velocity, stroke count,
//   hole completion or winner — only the aim. Those are computed here.
//
// MODEL (top-down, no gravity):
//   • initial velocity from power + angle
//   • linear damping every substep
//   • adaptive substepping so a fast ball can't tunnel through a thin wall
//   • wall/bumper collision with velocity reflection + restitution
//   • sand: extra damping while inside
//   • water: stroke replayed from its start position (+1 stroke, counted by
//     the caller from `waterHits`)
//   • cup: captured only when centred AND slow enough (valid-entry condition)
//   • stop threshold, plus a hard MAX_FRAMES safety cap
//
// Determinism note: only +, -, *, /, Math.hypot, Math.imul, Math.pow and
// Math.cos/sin are used, and every one of those is IEEE-754 specified, so the
// same sequence of operations yields the same doubles everywhere.

import {
  BALL_RADIUS,
  BUMPER_RESTITUTION,
  CAPTURE_MAX_SPEED,
  FRICTION,
  MAX_COLLISION_ITERATIONS,
  MAX_FRAMES,
  PATH_DEDUP_TOLERANCE,
  PATH_DOWNSAMPLE,
  POWER_MAX,
  POWER_MIN,
  POWER_SCALE,
  SAND_FRICTION,
  STOP_EPSILON,
  SUBSTEP_MAX_PX,
  WALL_RESTITUTION,
} from "./constants";
import {
  boundarySegments,
  clampBallToCourse,
  isBallInCup,
  isBallInsideCircle,
  resolveCircleCollision,
  resolveSegmentCollision,
} from "./collision";
import { clamp, dedupePath, substepCount, type Vec2 } from "../physics2d/kinematics";
import type { Ball, Hole, ShotInput, ShotResult, SimConfig } from "./types";

/** Default tuning, resolved from constants. Overridable per call for tests. */
export const DEFAULT_CONFIG: SimConfig = {
  ballRadius: BALL_RADIUS,
  friction: FRICTION,
  wallRestitution: WALL_RESTITUTION,
  bumperRestitution: BUMPER_RESTITUTION,
  stopEpsilon: STOP_EPSILON,
  maxFrames: MAX_FRAMES,
  substepMaxPx: SUBSTEP_MAX_PX,
  pathDownsample: PATH_DOWNSAMPLE,
  pathDedupTolerance: PATH_DEDUP_TOLERANCE,
  maxCollisionIterations: MAX_COLLISION_ITERATIONS,
  powerScale: POWER_SCALE,
  captureMaxSpeed: CAPTURE_MAX_SPEED,
  sandFriction: SAND_FRICTION,
};

/**
 * Validate a shot input. Throws on anything malformed rather than silently
 * producing a "valid-looking" trajectory — the same fail-fast stance
 * `simulateBall` takes in the Plinko simulator.
 */
export function assertShotInput(input: unknown): ShotInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("mini-golf physics: shot must be an object");
  }
  const { angle, power } = input as Partial<ShotInput>;
  assertFinite("angle", angle);
  assertFinite("power", power);
  const a = angle as number;
  const p = power as number;
  if (a < 0 || a >= 360) {
    throw new RangeError(
      `mini-golf physics: angle must be in [0, 360), got ${a}`,
    );
  }
  if (p < POWER_MIN || p > POWER_MAX) {
    throw new RangeError(
      `mini-golf physics: power must be in [${POWER_MIN}, ${POWER_MAX}], got ${p}`,
    );
  }
  return { angle: a, power: p };
}

function assertFinite(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `mini-golf physics: ${name} must be a finite number, got ${String(value)}`,
    );
  }
}

function assertPoint(name: string, point: unknown): Vec2 {
  if (!point || typeof point !== "object") {
    throw new TypeError(`mini-golf physics: ${name} must be a point object`);
  }
  const { x, y } = point as Partial<Vec2>;
  assertFinite(`${name}.x`, x);
  assertFinite(`${name}.y`, y);
  return { x: x as number, y: y as number };
}

/** Initial velocity for a shot. Exported so aims/AI can reason with it. */
export function initialVelocity(
  angleDeg: number,
  power: number,
  powerScale = POWER_SCALE,
): Vec2 {
  const rad = (angleDeg * Math.PI) / 180;
  const speed = power * powerScale;
  return { x: Math.cos(rad) * speed, y: Math.sin(rad) * speed };
}

/** Create a still ball at a position. */
export function createBall(position: Vec2, radius = BALL_RADIUS): Ball {
  return {
    x: position.x,
    y: position.y,
    vx: 0,
    vy: 0,
    radius,
    moving: false,
  };
}

/** True while the ball still has velocity. */
export function isMoving(ball: Ball): boolean {
  return Boolean(ball.moving) || ball.vx !== 0 || ball.vy !== 0;
}

export type SimulateShotParams = {
  hole: Hole;
  /** Where the ball starts. Defaults to the hole's tee. */
  from?: Vec2;
  /** The only player-authored input. */
  shot: ShotInput;
  /** Tuning overrides (tests use these; production uses the defaults). */
  config?: Partial<SimConfig>;
};

/**
 * Simulate one shot to completion.
 *
 * Never returns a partially-simulated shot: the loop terminates on
 * settle / cup / water / MAX_FRAMES and always sets `settled: true`.
 */
export function simulateShot(params: SimulateShotParams): ShotResult {
  if (!params || typeof params !== "object") {
    throw new TypeError("mini-golf physics: params must be an object");
  }
  const { hole } = params;
  if (!hole || typeof hole !== "object" || !hole.geometry) {
    throw new TypeError("mini-golf physics: params.hole must be a hole");
  }

  const shot = assertShotInput(params.shot);
  const cfg: SimConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };
  const geo = hole.geometry;

  const start = params.from ? assertPoint("from", params.from) : assertPoint("hole.geometry.tee", geo.tee);
  const friction = typeof geo.friction === "number" ? geo.friction : cfg.friction;
  const wallRestitution =
    typeof geo.wallRestitution === "number" ? geo.wallRestitution : cfg.wallRestitution;
  const captureMaxSpeed =
    typeof geo.cup.captureMaxSpeed === "number" ? geo.cup.captureMaxSpeed : cfg.captureMaxSpeed;

  const ball = createBall(start, cfg.ballRadius);
  const v0 = initialVelocity(shot.angle, shot.power, cfg.powerScale);
  ball.vx = v0.x;
  ball.vy = v0.y;
  ball.moving = true;
  clampBallToCourse(ball, geo.width, geo.height);

  const boundary = boundarySegments(geo.width, geo.height);
  const sand = geo.sand ?? [];
  const water = geo.water ?? [];
  const bumpers = geo.bumpers ?? [];
  const interiorWalls = geo.walls ?? [];

  const rawPath: Vec2[] = [{ x: ball.x, y: ball.y }];

  let pocketed = false;
  let settled = false;
  let hitStepLimit = false;
  let waterHits = 0;
  let frames = 0;
  let substeps = 0;

  for (let f = 0; f < cfg.maxFrames && !settled; f++) {
    frames = f + 1;

    const speed = Math.hypot(ball.vx, ball.vy);
    const steps = substepCount(speed, cfg.substepMaxPx);
    // Damping is distributed across substeps so total per-frame damping does
    // not depend on the substep count.
    const baseDamping = Math.pow(friction, 1 / steps);

    for (let s = 0; s < steps && !settled; s++) {
      substeps++;

      // 1. Integrate position, then damp.
      ball.x += ball.vx / steps;
      ball.y += ball.vy / steps;

      let damping = baseDamping;
      for (let i = 0; i < sand.length; i++) {
        if (isBallInsideCircle(ball, sand[i])) {
          damping *= Math.pow(cfg.sandFriction, 1 / steps);
          break;
        }
      }
      ball.vx *= damping;
      ball.vy *= damping;

      // 2. Collisions. Iterate so a ball wedged into a corner resolves both
      //    walls instead of oscillating between them.
      for (let iter = 0; iter < cfg.maxCollisionIterations; iter++) {
        let hit = false;
        for (let i = 0; i < boundary.length; i++) {
          hit = resolveSegmentCollision(ball, boundary[i], wallRestitution) || hit;
        }
        for (let i = 0; i < interiorWalls.length; i++) {
          hit = resolveSegmentCollision(ball, interiorWalls[i], wallRestitution) || hit;
        }
        for (let i = 0; i < bumpers.length; i++) {
          hit = resolveCircleCollision(ball, bumpers[i], cfg.bumperRestitution) || hit;
        }
        if (!hit) break;
      }
      clampBallToCourse(ball, geo.width, geo.height);

      // 3. Water — the stroke is replayed from its start position.
      let inWater = false;
      for (let i = 0; i < water.length; i++) {
        if (isBallInsideCircle(ball, water[i])) {
          inWater = true;
          break;
        }
      }
      if (inWater) {
        waterHits++;
        ball.x = start.x;
        ball.y = start.y;
        ball.vx = 0;
        ball.vy = 0;
        ball.moving = false;
        settled = true;
        break;
      }

      // 4. Cup — valid entry requires centre-inside AND slow enough.
      const currentSpeed = Math.hypot(ball.vx, ball.vy);
      if (isBallInCup(ball, geo.cup) && currentSpeed <= captureMaxSpeed) {
        pocketed = true;
        ball.x = geo.cup.x;
        ball.y = geo.cup.y;
        ball.vx = 0;
        ball.vy = 0;
        ball.moving = false;
        settled = true;
        break;
      }

      // 5. Stop threshold.
      if (currentSpeed < cfg.stopEpsilon) {
        ball.vx = 0;
        ball.vy = 0;
        ball.moving = false;
        settled = true;
        break;
      }

      // 6. Record the (downsampled) trajectory.
      if (substeps % cfg.pathDownsample === 0) {
        rawPath.push({ x: ball.x, y: ball.y });
      }
    }

    // Safety cap: force a settle so a shot can never hang the match.
    if (!settled && f === cfg.maxFrames - 1) {
      hitStepLimit = true;
      ball.vx = 0;
      ball.vy = 0;
      ball.moving = false;
      settled = true;
    }
  }

  const restPosition: Vec2 = { x: ball.x, y: ball.y };

  // Shape the path: pin the exact start, dedupe, pin the exact rest.
  const cleaned = dedupePath(rawPath, cfg.pathDedupTolerance);
  const path: Vec2[] = cleaned.length ? cleaned : [{ x: start.x, y: start.y }];
  path[0] = { x: start.x, y: start.y };
  const last = path[path.length - 1];
  if (Math.abs(last.x - restPosition.x) > 1e-9 || Math.abs(last.y - restPosition.y) > 1e-9) {
    path.push({ x: restPosition.x, y: restPosition.y });
  }

  return {
    path,
    restPosition,
    pocketed,
    settled,
    frames,
    substeps,
    hitStepLimit,
    waterHits,
  };
}

/** Clamp helper re-exported for callers that need the same power bounds. */
export function clampPower(power: number): number {
  return clamp(power, POWER_MIN, POWER_MAX);
}
