// src/lib/mini-golf/types.ts
//
// Mini Golf's data shapes. All coordinates are px in a screen-like frame:
// x grows right, y grows DOWN. Angles are degrees in [0, 360) with
// 0° = +x (right) and 90° = +y (down-screen), i.e. standard
// `vx = cos(θ)`, `vy = sin(θ)`.

import type { Vec2 } from "../physics2d/kinematics";

export type { Vec2 };

/**
 * A wall. Either a boundary segment (with a fixed `inward` normal, so a ball
 * that overshoots is always pushed back inside) or an interior obstacle
 * segment (normal derived radially from the closest point).
 */
export type Segment = {
  a: Vec2;
  b: Vec2;
  /**
   * Fixed unit normal pointing into playable space. Set on the four boundary
   * segments. Interior obstacles leave it undefined and use the radial
   * normal instead.
   */
  inward?: Vec2;
};

/** A circular obstacle the ball bounces off. */
export type Bumper = { x: number; y: number; r: number };

/** A sand patch: extra damping while the ball is inside it. */
export type Sand = { x: number; y: number; r: number };

/** Water: the stroke is replayed from where it started, at +1 stroke cost. */
export type Water = { x: number; y: number; r: number };

/**
 * The hole/cup. `r` is the capture radius and `captureMaxSpeed` the
 * valid-entry condition: the server only counts an entry when the ball's
 * centre is inside the cup AND the ball is slow enough, so a fast putt can
 * roll across the cup without dropping.
 */
export type Cup = {
  x: number;
  y: number;
  r: number;
  captureMaxSpeed?: number;
};

/** Static geometry of one hole. Pure data — no functions, so it serialises. */
export type HoleGeometry = {
  width: number;
  height: number;
  tee: Vec2;
  cup: Cup;
  /** Interior obstacle segments (the rectangle boundary is implied). */
  walls: Segment[];
  bumpers: Bumper[];
  sand: Sand[];
  water: Water[];
  /** Optional per-hole damping override (set deterministically by the generator). */
  friction?: number;
  /** Optional per-hole wall restitution override. */
  wallRestitution?: number;
};

/**
 * Difficulty tiers, ascending. A match is dealt one hole per ramp step (see
 * `DIFFICULTY_RAMP` in constants.ts), so a course always ramps from easy to
 * hard instead of randomly producing five impossible holes.
 */
export type HoleDifficulty = "easy" | "easy-medium" | "medium" | "medium-hard" | "hard";

export type Hole = {
  /** 1-based hole number. */
  index: number;
  par: number;
  template: string;
  /**
   * Difficulty tier assigned by the generator. Optional because holes created
   * before the difficulty ramp existed are still valid course snapshots.
   */
  difficulty?: HoleDifficulty;
  geometry: HoleGeometry;
};

/** A generated course. Fully reproducible from (seed, version). */
export type Course = {
  version: number;
  seed: number;
  holes: Hole[];
};

/**
 * Ball state. The client never authors any of this — it is produced and
 * owned by the server simulation.
 */
export type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** True while the ball has non-zero velocity (pre-settle). */
  moving: boolean;
};

/**
 * What a player is allowed to submit for a shot. Deliberately minimal: no
 * position, no velocity, no stroke count, no hole/winner claim.
 */
export type ShotInput = {
  /** Degrees in [0, 360). 0° = right, 90° = down-screen. */
  angle: number;
  /** In [POWER_MIN, POWER_MAX]. */
  power: number;
};

/** Tuning knobs, defaulted from constants but overridable for tests. */
export type SimConfig = {
  ballRadius: number;
  friction: number;
  wallRestitution: number;
  bumperRestitution: number;
  stopEpsilon: number;
  maxFrames: number;
  substepMaxPx: number;
  pathDownsample: number;
  pathDedupTolerance: number;
  maxCollisionIterations: number;
  powerScale: number;
  captureMaxSpeed: number;
  sandFriction: number;
};

/**
 * The authoritative outcome of one shot. `path` is the replayable trajectory
 * both clients animate; `restPosition` is where the server puts the ball next
 * stroke.
 */
export type ShotResult = {
  path: Vec2[];
  restPosition: Vec2;
  /** True when the ball dropped into the cup (hole complete). */
  pocketed: boolean;
  /** Always true on return — every shot terminates (stop, cup, water, or cap). */
  settled: boolean;
  frames: number;
  substeps: number;
  /** True when MAX_FRAMES was hit and the ball was force-settled. */
  hitStepLimit: boolean;
  /** How many water hazards the ball landed in (each costs +1 stroke). */
  waterHits: number;
};
