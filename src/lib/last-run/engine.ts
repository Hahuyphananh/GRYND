// src/lib/last-run/engine.ts
//
// LAST RUN — the deterministic runner simulation.
//
// ── THE CONTRACT ─────────────────────────────────────────────────────────
//
//   * ONE course per match, generated from the match seed. The same seed with
//     the same configuration yields the same obstacle list, always — no client
//     calls Math.random() for the run.
//   * Two independent runners on that course. Each seat has its own height,
//     jump, duck, distance and alive/dead state; the COURSE is shared.
//   * The simulation is a pure function of (seed, inputs). It imports no
//     React, DOM, Socket.IO or database, so the server replay, the client's
//     local rendering and the tests all run the exact same code.
//   * Collisions are AABB overlaps of a runner's hitbox against an obstacle's
//     box. Nothing is time-based or frame-rate dependent: a tick is 1/60 s.
//
// ── WHY THE COURSE IS GENERATED IN TIME, NOT IN DISTANCE ─────────────────
//
// The speed curve is a function of TIME (see `speedAt`). Placing obstacles at
// a distance would make their spacing in time drift as the speed rises, and a
// fair gap at second 5 could become an impossible gap at second 40. Generating
// them at instants and *deriving* each x from `distanceAt` keeps the reaction
// window the player actually gets constant — which is the only definition of
// fairness that survives a speed ramp.
//
// ── INPUTS ───────────────────────────────────────────────────────────────
//
// An input is a held state, not an event: `{ jump, duck }`. A rising `jump`
// edge starts a jump when the runner is grounded and not ducking; a held jump
// does not repeat. `duck` lowers the hitbox while it stays true. The server
// stores the EDGES it receives (see src/lib/last-run/matchRegistry.ts), then
// replays them through `sampleInput` below.

import {
  COURSE_DURATION_S,
  DT,
  FIRST_OBSTACLE_AT_S,
  GAP_AFTER_BEAM_S,
  GAP_FLOOR_S,
  GAP_RAMP_S,
  GAP_START_S,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_KIND_RUN,
  MAX_SPEED,
  MIN_OBSTACLE_GAP_S,
  OBSTACLE_SPECS,
  RUNNER_DUCK_HEIGHT,
  RUNNER_STANDING_HEIGHT,
  RUNNER_WIDTH,
  SEATS,
  SPEED_RAMP,
  SPEED_RAMP_SECONDS,
  START_SPEED,
  TICK_MS,
  type ObstacleKind,
  type Seat,
} from "./constants";

// ── Types ───────────────────────────────────────────────────────────────

/** A held control state. Everything the simulation needs from a player. */
export type RunnerInput = { jump: boolean; duck: boolean };

export const NEUTRAL_INPUT: RunnerInput = Object.freeze({ jump: false, duck: false });

/** One obstacle on the shared course. `x` is a world distance in px. */
export type Obstacle = {
  id: number;
  kind: ObstacleKind;
  /** The instant it is reached, seconds from the start (generation-only). */
  at: number;
  x: number;
  width: number;
  height: number;
  /** Bottom edge of the obstacle's box above the ground line. */
  minY: number;
};

export type Course = {
  seed: number;
  duration: number;
  obstacles: Obstacle[];
  /** The distance at which the course ends, px (a runner cannot pass it). */
  length: number;
};

export type RunnerState = {
  distance: number;
  /** Height of the runner's feet above the ground line, px. */
  y: number;
  vy: number;
  onGround: boolean;
  ducking: boolean;
  /**
   * Was jump held on the previous tick? Jumps are EDGE-triggered: keeping the
   * key down must not bunny-hop the runner every time it lands.
   */
  jumpHeld: boolean;
  alive: boolean;
  /** The tick the runner hit something, or null while alive. */
  crashedAtTick: number | null;
};

export type MatchEndReason = "crash" | "time";

export type MatchEnd = {
  /** The winner, or a draw. Never inferred: see `resolveOutcome`. */
  result: Seat | "draw";
  reason: MatchEndReason;
  tick: number;
};

export type SimulationState = {
  seed: number;
  course: Course;
  tick: number;
  runners: Record<Seat, RunnerState>;
  end: MatchEnd | null;
};

/** A recorded transition, as the server stores and replays it. */
export type InputTransition = { tick: number; jump: boolean; duck: boolean };

// ── Seeded PRNG ─────────────────────────────────────────────────────────
/**
 * mulberry32 — 32-bit, tiny, fast, and identical everywhere.
 *
 * Deliberately NOT `Math.random()`: the course must be a pure function of the
 * seed so two clients and the server all generate the same run.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A cryptographic seed for a new match ⟨32 bits of randomness⟩. */
export function isValidSeed(seed: unknown): seed is number {
  return typeof seed === "number" && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff;
}

// ── Speed + distance curve ──────────────────────────────────────────────
/** World speed at `t` seconds, px/s. Monotonically non-decreasing, capped. */
export function speedAt(t: number): number {
  const seconds = Math.max(0, t);
  return Math.min(MAX_SPEED, START_SPEED + SPEED_RAMP * seconds);
}

/**
 * Distance travelled by `t` seconds of not crashing, px.
 *
 * Analytic (not integrated per tick) so the course's obstacle positions and a
 * runner's distance can never drift apart by a rounding tick. For
 * `t <= SPEED_RAMP_SECONDS` the speed is still accelerating, so this is
 * v0·t + ½at²; afterwards it is the ramp distance plus vmax·(t − ramp).
 */
export function distanceAt(t: number): number {
  const seconds = Math.max(0, t);
  if (seconds <= SPEED_RAMP_SECONDS) {
    return START_SPEED * seconds + 0.5 * SPEED_RAMP * seconds * seconds;
  }
  const rampDistance = START_SPEED * SPEED_RAMP_SECONDS + 0.5 * SPEED_RAMP * SPEED_RAMP_SECONDS ** 2;
  return rampDistance + MAX_SPEED * (seconds - SPEED_RAMP_SECONDS);
}

/** The inverse: how far into the run a distance puts you, seconds. */
export function timeAtDistance(distance: number): number {
  const d = Math.max(0, distance);
  const rampDistance = distanceAt(SPEED_RAMP_SECONDS);
  if (d <= rampDistance) {
    // v0·t + ½at² = d  →  t = (−v0 + √(v0² + 2ad)) / a
    return (-START_SPEED + Math.sqrt(START_SPEED ** 2 + 2 * SPEED_RAMP * d)) / SPEED_RAMP;
  }
  return SPEED_RAMP_SECONDS + (d - rampDistance) / MAX_SPEED;
}

// ── Course generation ───────────────────────────────────────────────────
/** The shortest gap, in seconds, at which `kind` can be met fairly. */
export function minimumGapFor(kind: ObstacleKind): number {
  // A jump obstacle must be landable and re-jumpable: the arc plus a human
  // reaction budget. A beam only needs the duck to be held, which is cheap,
  // but it still needs enough time to be READ.
  return Math.max(MIN_OBSTACLE_GAP_S, kind === "beam" ? 0.95 : 1.05);
}

function pickKind(rand: () => number, difficulty: number): ObstacleKind {
  // As the run speeds up, beams (the duck test) and spikes (the shortest
  // window) appear more often; crates stay the readable default.
  const roll = rand();
  const beamBias = 0.18 + 0.12 * difficulty;
  const spikeBias = 0.16 + 0.1 * difficulty;
  if (roll < beamBias) return "beam";
  if (roll < beamBias + spikeBias) return "spike";
  return "crate";
}

/**
 * THE COURSE. Same seed + same duration ⇒ byte-identical obstacle list.
 *
 * Guarantees (all asserted by tests/last-run-engine.test.mjs):
 *   * nothing before FIRST_OBSTACLE_AT_S;
 *   * consecutive obstacles are never closer than `minimumGapFor(kind)`;
 *   * the gap tightens with difficulty but never below GAP_FLOOR_S;
 *   * the same kind never runs more than MAX_KIND_RUN in a row;
 *   * a beam is always followed by extra clearance.
 */
export function generateCourse(seed: number, duration: number = COURSE_DURATION_S): Course {
  if (!isValidSeed(seed)) throw new RangeError(`generateCourse: invalid seed ${String(seed)}`);
  const rand = createRng(seed);
  const obstacles: Obstacle[] = [];
  let at = FIRST_OBSTACLE_AT_S;
  let previousKind: ObstacleKind | null = null;
  let kindRun = 0;
  let id = 0;

  while (at < duration) {
    const difficulty = Math.min(1, Math.max(0, (at - 8) / GAP_RAMP_S));
    let kind = pickKind(rand, difficulty);
    if (previousKind === kind && kindRun >= MAX_KIND_RUN) {
      // Break the run deterministically: step to the next kind in the cycle.
      kind = kind === "crate" ? "spike" : kind === "spike" ? "beam" : "crate";
    }
    kindRun = previousKind === kind ? kindRun + 1 : 1;

    const spec = OBSTACLE_SPECS[kind];
    obstacles.push({
      id,
      kind,
      at,
      x: distanceAt(at),
      width: spec.width,
      height: spec.height,
      minY: spec.minY,
    });
    id += 1;

    const base = GAP_START_S - (GAP_START_S - GAP_FLOOR_S) * difficulty;
    const afterBeam = previousKind === "beam" ? GAP_AFTER_BEAM_S : 0;
    const jitter = 0.18 * rand();
    const nextGap = Math.max(base + afterBeam + jitter, minimumGapFor(kind));
    at += nextGap;
    previousKind = kind;
  }

  return { seed, duration, obstacles, length: distanceAt(duration) };
}

// ── Runner + tick simulation ────────────────────────────────────────────
export function createRunner(): RunnerState {
  return {
    distance: 0,
    y: 0,
    vy: 0,
    onGround: true,
    ducking: false,
    jumpHeld: false,
    alive: true,
    crashedAtTick: null,
  };
}

export function createSimulation(seed: number, duration: number = COURSE_DURATION_S): SimulationState {
  return {
    seed,
    course: generateCourse(seed, duration),
    tick: 0,
    runners: { player1: createRunner(), player2: createRunner() },
    end: null,
  };
}

/** The runner's hitbox at its current position (world coordinates). */
export function runnerBox(runner: RunnerState): { left: number; right: number; bottom: number; top: number } {
  const height = runner.ducking && runner.onGround ? RUNNER_DUCK_HEIGHT : RUNNER_STANDING_HEIGHT;
  const bottom = runner.y;
  return { left: runner.distance, right: runner.distance + RUNNER_WIDTH, bottom, top: bottom + height };
}

/** The obstacle's hitbox. A beam floats; the rest sit on the ground. */
export function obstacleBox(obstacle: Obstacle): { left: number; right: number; bottom: number; top: number } {
  return {
    left: obstacle.x,
    right: obstacle.x + obstacle.width,
    bottom: obstacle.minY,
    top: obstacle.minY + obstacle.height,
  };
}

/**
 * AABB overlap. Strict inequalities: a runner whose right edge EXACTLY touches
 * an obstacle's left edge has not hit it yet. That boundary is deliberate —
 * it is the difference between a fair close call and a phantom death — and is
 * covered by tests/last-run-engine.test.mjs.
 */
export function intersects(
  a: { left: number; right: number; bottom: number; top: number },
  b: { left: number; right: number; bottom: number; top: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}

/** Would this runner hit this obstacle right now? */
export function collides(runner: RunnerState, obstacle: Obstacle): boolean {
  return intersects(runnerBox(runner), obstacleBox(obstacle));
}

/**
 * Advance ONE runner by one fixed tick.
 *
 * Pure in the sense that matters: the same runner + input + tick always gives
 * the same next runner. It returns a NEW object, so replay never aliases a
 * snapshot the UI is still holding.
 */
export function stepRunner(
  runner: RunnerState,
  input: RunnerInput,
  tick: number,
  dt: number = DT,
  obstacles: readonly Obstacle[] = [],
): RunnerState {
  if (!runner.alive) return runner;

  let { y, vy, onGround, ducking } = runner;
  let alive = true;
  let crashedAtTick = runner.crashedAtTick;

  // Ducking is decided FIRST, from the held state and the ground: a runner who
  // is holding down is committed to a duck and cannot jump out of it.
  const duckingNow = input.duck && onGround;

  // A jump starts only from the ground, only out of a duck, and only on a
  // RISING edge of the jump input (a held key must not auto-repeat).
  if (input.jump && !runner.jumpHeld && onGround && !duckingNow) {
    vy = JUMP_VELOCITY;
    onGround = false;
  }

  // Ducking is a ground behaviour: taking off drops it immediately, so a duck
  // can never shrink the hitbox in mid-air.
  ducking = duckingNow && onGround;

  if (!onGround) {
    vy -= GRAVITY * dt;
    y += vy * dt;
    if (y <= 0) {
      y = 0;
      vy = 0;
      onGround = true;
      // Re-apply the held duck on landing: holding down through a jump is a
      // legitimate input and must land ducking.
      ducking = input.duck;
    }
  }

  const next: RunnerState = {
    ...runner,
    y,
    vy,
    onGround,
    ducking,
    jumpHeld: input.jump,
    distance: runner.distance + speedAt(tick * dt) * dt,
    alive,
    crashedAtTick,
  };

  const box = runnerBox(next);
  for (const obstacle of nearbyObstacles(obstacles, next.distance)) {
    if (intersects(box, obstacleBox(obstacle))) {
      alive = false;
      crashedAtTick = tick;
      break;
    }
  }

  return { ...next, alive, crashedAtTick };
}

/**
 * The few obstacles a runner could possibly touch this tick.
 *
 * The obstacle list is sorted by x, so the scan stops as soon as it is ahead
 * of the runner. No module-level cursor: two matches simulated in the same
 * process (or a test replaying an old prefix) must never share mutable state.
 */
function nearbyObstacles(obstacles: readonly Obstacle[], distance: number): Obstacle[] {
  const behind = distance - RUNNER_WIDTH * 2;
  const ahead = distance + RUNNER_WIDTH * 3;
  const nearby: Obstacle[] = [];
  for (const obstacle of obstacles) {
    if (obstacle.x > ahead) break;
    if (obstacle.x + obstacle.width < behind) continue;
    nearby.push(obstacle);
  }
  return nearby;
}

/**
 * Advance the WHOLE match by one tick.
 *
 * Two independent runners, one shared course, one clock. Returns a new state;
 * the `end` is set exactly once, on the tick the first crash happens (or when
 * both survive to the end, in which case `resolveOutcome` decides on distance).
 */
export function stepSimulation(
  state: SimulationState,
  inputs: Record<Seat, RunnerInput>,
  dt: number = DT,
): SimulationState {
  if (state.end) return state;

  const tick = state.tick;
  const runners = {
    player1: stepRunner(state.runners.player1, inputs.player1, tick, dt, state.course.obstacles),
    player2: stepRunner(state.runners.player2, inputs.player2, tick, dt, state.course.obstacles),
  };

  const nextTick = tick + 1;
  const crashed = SEATS.filter((seat) => !runners[seat].alive);
  if (crashed.length > 0) {
    return {
      ...state,
      tick: nextTick,
      runners,
      end: {
        result: resolveCrashedSeats(runners),
        reason: "crash",
        tick: nextTick,
      },
    };
  }

  const atCourseEnd = nextTick * dt >= state.course.duration;
  if (atCourseEnd) {
    return {
      ...state,
      tick: nextTick,
      runners,
      end: { result: resolveSurvivorsByDistance(runners), reason: "time", tick: nextTick },
    };
  }

  return { ...state, tick: nextTick, runners };
}

/**
 * Who wins when one or both runners have just died on this tick.
 *
 * THE rule: the first crash loses. If both bodies hit on the SAME tick there
 * is no first, so the match is a draw — never an arbitrary seat, never the
 * lower tick number.
 */
export function resolveCrashedSeats(runners: Record<Seat, RunnerState>): Seat | "draw" {
  const p1 = runners.player1;
  const p2 = runners.player2;
  if (!p1.alive && !p2.alive) return "draw";
  if (!p1.alive) return "player2";
  if (!p2.alive) return "player1";
  return "draw";
}

/**
 * The end-of-course tiebreak, used only when NOBODY crashed. Distance is the
 * score; an exact tie is a draw. This can never award a win for a crash.
 */
export function resolveSurvivorsByDistance(runners: Record<Seat, RunnerState>): Seat | "draw" {
  const diff = runners.player1.distance - runners.player2.distance;
  if (Math.abs(diff) < 0.5) return "draw";
  return diff > 0 ? "player1" : "player2";
}

// ── Replay (server authority) ───────────────────────────────────────────
/**
 * The held input at `tick`, from a seat's recorded transitions.
 *
 * Transitions are applied in tick order; before the first one the seat is
 * NEUTRAL. A transition at tick N becomes effective for that tick.
 */
export function sampleInput(
  transitions: readonly InputTransition[] | undefined,
  tick: number,
): RunnerInput {
  if (!transitions || transitions.length === 0) return NEUTRAL_INPUT;
  let jump = false;
  let duck = false;
  for (const transition of transitions) {
    if (transition.tick > tick) break;
    jump = transition.jump;
    duck = transition.duck;
  }
  return { jump, duck };
}

/**
 * Replay a match to `upToTick` (exclusive). Used by the server on every
 * snapshot, and by tests to prove repeatability.
 *
 * `transitions` MUST be sorted by tick; the registry keeps them sorted.
 */
export function simulateTo(
  seed: number,
  transitions: Record<Seat, readonly InputTransition[] | undefined>,
  upToTick: number,
  duration: number = COURSE_DURATION_S,
): SimulationState {
  let state = createSimulation(seed, duration);
  const limit = Math.max(0, Math.min(upToTick, Math.ceil(duration / DT) + 2));
  while (state.tick < limit && !state.end) {
    const tick = state.tick;
    state = stepSimulation(state, {
      player1: sampleInput(transitions.player1, tick),
      player2: sampleInput(transitions.player2, tick),
    });
  }
  return state;
}

/** Convenience for the client's local preview: elapsed milliseconds → tick. */
export function tickForElapsed(elapsedMs: number): number {
  return Math.max(0, Math.floor(elapsedMs / TICK_MS));
}

/** Survival time in ms for a seat, from the tick it crashed on. */
export function survivalMs(state: SimulationState, seat: Seat): number {
  const runner = state.runners[seat];
  const tick = runner.crashedAtTick ?? state.tick;
  return Math.round(tick * TICK_MS);
}
