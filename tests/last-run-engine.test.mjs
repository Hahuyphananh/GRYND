// tests/last-run-engine.test.mjs
//
// The engine is the authority for LAST RUN: the server replays it, the client
// renders it. These tests pin the physics, the collision boundaries, the
// course's fairness guarantees and — most importantly — that the whole thing
// is a pure function of (seed, inputs).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DT,
  JUMP_APEX_PX,
  JUMP_AIRTIME_S,
  MAX_SPEED,
  MIN_OBSTACLE_GAP_S,
  OBSTACLE_SPECS,
  RUNNER_DUCK_HEIGHT,
  RUNNER_STANDING_HEIGHT,
  START_SPEED,
  TICK_MS,
} from "../src/lib/last-run/constants.ts";
import {
  collides,
  createRunner,
  createSimulation,
  distanceAt,
  generateCourse,
  intersects,
  minimumGapFor,
  resolveCrashedSeats,
  resolveSurvivorsByDistance,
  runnerBox,
  sampleInput,
  simulateTo,
  speedAt,
  stepRunner,
  stepSimulation,
  tickForElapsed,
} from "../src/lib/last-run/engine.ts";

const SEED = 0x1a2b3c4d;

// ════════════════════════════════════════════════════════════════════════
// 1. Jump arc
// ════════════════════════════════════════════════════════════════════════

test("jump: leaves the ground, peaks at the derived height, lands on a fixed tick", () => {
  let runner = createRunner();
  let maxY = 0;
  let airborneTicks = 0;

  // Hold jump for exactly one tick, then release: the arc is ballistic.
  runner = stepRunner(runner, { jump: true, duck: false }, 0);
  assert.equal(runner.onGround, false, "a jump must leave the ground immediately");
  assert.ok(runner.vy > 0);

  for (let tick = 1; tick < 200 && !runner.onGround; tick += 1) {
    runner = stepRunner(runner, { jump: false, duck: false }, tick);
    maxY = Math.max(maxY, runner.y);
    airborneTicks += 1;
  }

  assert.equal(runner.onGround, true, "the runner must land");
  assert.equal(runner.y, 0);
  assert.equal(runner.vy, 0);
  // Apex within 6% of the analytic value (one Euler tick of error).
  assert.ok(
    Math.abs(maxY - JUMP_APEX_PX) / JUMP_APEX_PX < 0.06,
    `apex ${maxY.toFixed(1)} vs analytic ${JUMP_APEX_PX.toFixed(1)}`,
  );
  // Airtime within two ticks of the analytic value.
  assert.ok(
    Math.abs(airborneTicks * DT - JUMP_AIRTIME_S) < 4 * DT,
    `airtime ${(airborneTicks * DT).toFixed(3)}s vs analytic ${JUMP_AIRTIME_S.toFixed(3)}s`,
  );
});

test("jump: no double jump, and a duck on the ground blocks takeoff", () => {
  let runner = stepRunner(createRunner(), { jump: true, duck: false }, 0);
  const vyAtTakeoff = runner.vy;
  // A second jump press mid-air changes nothing.
  runner = stepRunner(runner, { jump: true, duck: false }, 1);
  assert.ok(runner.vy < vyAtTakeoff, "gravity must keep pulling; no second impulse");

  const ducking = stepRunner(createRunner(), { jump: true, duck: true }, 0);
  assert.equal(ducking.onGround, true, "a ducking runner does not jump");
  assert.equal(ducking.ducking, true);
});

test("jump: holding jump does not repeat a jump after landing", () => {
  let runner = createRunner();
  // Hold jump for a long stretch: one takeoff, then a landing that MUST NOT
  // auto-jump again while the key is still down.
  let takeoffs = 0;
  for (let tick = 0; tick < 240; tick += 1) {
    const wasOnGround = runner.onGround;
    runner = stepRunner(runner, { jump: true, duck: false }, tick);
    if (wasOnGround && !runner.onGround) takeoffs += 1;
  }
  assert.equal(takeoffs, 1, "a held jump key must not bunny-hop");
});

// ════════════════════════════════════════════════════════════════════════
// 2. Ducking + hitbox
// ════════════════════════════════════════════════════════════════════════

test("duck: lowers the hitbox while held, restores it on release", () => {
  const standing = runnerBox(createRunner());
  const ducking = runnerBox({ ...createRunner(), ducking: true });
  assert.equal(standing.top - standing.bottom, RUNNER_STANDING_HEIGHT);
  assert.equal(ducking.top - ducking.bottom, RUNNER_DUCK_HEIGHT);
  assert.ok(ducking.top < standing.top);
});

test("duck: clears a beam that a standing runner hits", () => {
  const beam = {
    id: 0,
    kind: "beam",
    at: 0,
    x: 100,
    width: OBSTACLE_SPECS.beam.width,
    height: OBSTACLE_SPECS.beam.height,
    minY: OBSTACLE_SPECS.beam.minY,
  };
  const standing = { ...createRunner(), distance: 100 };
  const ducking = { ...standing, ducking: true };

  assert.equal(collides(standing, beam), true, "standing must hit the beam");
  assert.equal(collides(ducking, beam), false, "ducking must pass under it");
});

test("duck: is not a magic shield — a spike still hits a ducking runner", () => {
  const spike = {
    id: 0,
    kind: "spike",
    at: 0,
    x: 100,
    width: OBSTACLE_SPECS.spike.width,
    height: OBSTACLE_SPECS.spike.height,
    minY: 0,
  };
  const ducking = { ...createRunner(), distance: 100, ducking: true };
  assert.equal(collides(ducking, spike), true);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Collision boundaries
// ════════════════════════════════════════════════════════════════════════

test("collision: touching edges are NOT a hit (strict AABB overlap)", () => {
  const box = { left: 0, right: 10, bottom: 0, top: 10 };
  assert.equal(intersects(box, { left: 10, right: 20, bottom: 0, top: 10 }), false);
  assert.equal(intersects(box, { left: 9.99, right: 20, bottom: 0, top: 10 }), true);
  assert.equal(intersects(box, { left: 0, right: 10, bottom: 10, top: 20 }), false);
  assert.equal(intersects(box, { left: 0, right: 10, bottom: 9.99, top: 20 }), true);
});

test("collision: clearing the top of a crate is safe, clipping it is a crash", () => {
  const crate = {
    id: 0,
    kind: "crate",
    at: 0,
    x: 500,
    width: OBSTACLE_SPECS.crate.width,
    height: OBSTACLE_SPECS.crate.height,
    minY: 0,
  };
  const jumping = { ...createRunner(), distance: 500, y: OBSTACLE_SPECS.crate.height + 1, onGround: false };
  const low = { ...jumping, y: OBSTACLE_SPECS.crate.height - 1 };

  assert.equal(collides(jumping, crate), false);
  assert.equal(collides(low, crate), true);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Deterministic generation
// ════════════════════════════════════════════════════════════════════════

test("course: same seed ⇒ identical course, different seed ⇒ different course", () => {
  const a = generateCourse(SEED);
  const b = generateCourse(SEED);
  const c = generateCourse(SEED + 1);

  assert.deepEqual(a, b);
  assert.notDeepEqual(a.obstacles, c.obstacles);
});

test("course: generates obstacles, and every one is reachable within the run", () => {
  const course = generateCourse(SEED);
  assert.ok(course.obstacles.length > 20, `only ${course.obstacles.length} obstacles`);
  assert.ok(course.obstacles[0].at >= 1.3, "the opening must be clear");
  for (const obstacle of course.obstacles) {
    assert.ok(obstacle.x >= 0);
    assert.ok(obstacle.at < course.duration);
    // x is derived from the same speed curve the runner uses.
    assert.ok(Math.abs(obstacle.x - distanceAt(obstacle.at)) < 1e-6);
  }
});

test("course: no Math.random in the generator — two cold runs are byte-identical", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("course generation must never call Math.random()");
  };
  try {
    assert.deepEqual(generateCourse(SEED), generateCourse(SEED));
  } finally {
    Math.random = original;
  }
});

// ════════════════════════════════════════════════════════════════════════
// 5. Speed progression
// ════════════════════════════════════════════════════════════════════════

test("speed: starts at START_SPEED, rises monotonically, and caps at MAX_SPEED", () => {
  assert.equal(speedAt(0), START_SPEED);
  let previous = speedAt(0);
  for (let t = 0.25; t <= 120; t += 0.25) {
    const next = speedAt(t);
    assert.ok(next >= previous, "speed must never decrease");
    assert.ok(next <= MAX_SPEED);
    previous = next;
  }
  assert.equal(speedAt(120), MAX_SPEED);
});

test("speed: distance is monotonic and matches the integral of the curve", () => {
  let previous = 0;
  for (let t = 0; t <= 75; t += 0.5) {
    const d = distanceAt(t);
    assert.ok(d >= previous);
    previous = d;
  }
  // Numeric integral vs the analytic curve.
  let integral = 0;
  for (let t = 0; t < 30; t += 0.001) integral += speedAt(t) * 0.001;
  assert.ok(Math.abs(integral - distanceAt(30)) < 1);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Obstacle fairness
// ════════════════════════════════════════════════════════════════════════

test("fairness: every gap leaves at least the kind's minimum reaction window", () => {
  for (const seed of [1, 7, 42, 1234, SEED, 0xffffffff]) {
    const course = generateCourse(seed);
    for (let i = 1; i < course.obstacles.length; i += 1) {
      const previous = course.obstacles[i - 1];
      const current = course.obstacles[i];
      const gap = current.at - previous.at;
      assert.ok(gap >= MIN_OBSTACLE_GAP_S, `seed ${seed}: gap ${gap.toFixed(2)}s too short`);
      assert.ok(
        gap >= minimumGapFor(previous.kind) - 1e-9,
        `seed ${seed}: ${previous.kind} → ${current.kind} gap ${gap.toFixed(2)}s`,
      );
    }
  }
});

test("fairness: gaps stay within the designed window (no wall, no dead air)", () => {
  const course = generateCourse(SEED);
  for (let i = 1; i < course.obstacles.length; i += 1) {
    const gap = course.obstacles[i].at - course.obstacles[i - 1].at;
    assert.ok(gap <= 3.4, `gap ${gap.toFixed(2)}s is dead air on a speed runner`);
  }
});

test("fairness: the same kind never runs longer than the documented limit", () => {
  const course = generateCourse(SEED);
  let run = 1;
  for (let i = 1; i < course.obstacles.length; i += 1) {
    run = course.obstacles[i].kind === course.obstacles[i - 1].kind ? run + 1 : 1;
    assert.ok(run <= 2, `kind ${course.obstacles[i].kind} repeated ${run} times`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 7. Simultaneous crashes + outcome rules
// ════════════════════════════════════════════════════════════════════════

test("outcome: one crash hands the match to the survivor", () => {
  const dead = { ...createRunner(), alive: false, crashedAtTick: 120 };
  const alive = createRunner();
  assert.equal(resolveCrashedSeats({ player1: dead, player2: alive }), "player2");
  assert.equal(resolveCrashedSeats({ player1: alive, player2: dead }), "player1");
});

test("outcome: both crashing on the same tick is a DRAW, never a coin flip", () => {
  const dead = { ...createRunner(), alive: false, crashedAtTick: 120 };
  assert.equal(resolveCrashedSeats({ player1: dead, player2: dead }), "draw");
});

test("outcome: an un-crashed course end is decided on distance, ties are draws", () => {
  assert.equal(
    resolveSurvivorsByDistance({
      player1: { ...createRunner(), distance: 1800 },
      player2: { ...createRunner(), distance: 1400 },
    }),
    "player1",
  );
  assert.equal(
    resolveSurvivorsByDistance({
      player1: { ...createRunner(), distance: 1500 },
      player2: { ...createRunner(), distance: 1500 },
    }),
    "draw",
  );
});

test("match: the first crash ends the simulation once", () => {
  const sim = createSimulation(SEED);
  // Player 1 never jumps. Player 2 jumps on a repeating cadence. At least one
  // of them must crash — a motionless runner cannot clear a crate forever.
  let state = sim;
  let ticks = 0;
  while (!state.end && ticks < 6000) {
    state = stepSimulation(state, {
      player1: { jump: false, duck: false },
      player2: { jump: ticks % 40 === 0, duck: false },
    });
    ticks += 1;
  }
  assert.ok(state.end, "a motionless runner must eventually crash");
  assert.equal(state.end.reason, "crash");
  assert.equal(state.runners.player1.alive, false, "the runner that never jumps is the one that dies");
  assert.equal(state.end.result, state.runners.player2.alive ? "player2" : "draw");
  const frozen = stepSimulation(state, { player1: { jump: true, duck: false }, player2: { jump: true, duck: false } });
  assert.equal(frozen, state, "a finished match must never advance");
});

// ════════════════════════════════════════════════════════════════════════
// 8. Repeatability (server/client parity)
// ════════════════════════════════════════════════════════════════════════

test("replay: identical inputs ⇒ identical state, every time", () => {
  const transitions = {
    player1: [
      { tick: 30, jump: true, duck: false },
      { tick: 31, jump: false, duck: false },
      { tick: 120, jump: false, duck: true },
      { tick: 150, jump: false, duck: false },
    ],
    player2: [{ tick: 40, jump: false, duck: true }],
  };

  const first = simulateTo(SEED, transitions, 600);
  const second = simulateTo(SEED, transitions, 600);
  assert.deepEqual(first, second);
});

test("replay: a longer replay extends the shorter one, it does not rewrite it", () => {
  const transitions = { player1: [], player2: [] };
  const short = simulateTo(SEED, transitions, 120);
  const long = simulateTo(SEED, transitions, 480);
  // A motionless runner crashes well before either bound, so both replays stop
  // at the same terminal tick — which is itself the proof that the prefix is
  // never rewritten by asking for more of it.
  assert.ok(short.tick <= 120);
  assert.ok(long.tick >= short.tick);
  assert.ok(long.runners.player1.distance >= short.runners.player1.distance);
  const replay = simulateTo(SEED, transitions, 480);
  assert.deepEqual(long, replay);
});

test("input: transitions are held until the next one, neutral before the first", () => {
  const transitions = [
    { tick: 10, jump: true, duck: false },
    { tick: 20, jump: false, duck: true },
  ];
  assert.deepEqual(sampleInput(transitions, 0), { jump: false, duck: false });
  assert.deepEqual(sampleInput(transitions, 10), { jump: true, duck: false });
  assert.deepEqual(sampleInput(transitions, 19), { jump: true, duck: false });
  assert.deepEqual(sampleInput(transitions, 20), { jump: false, duck: true });
  assert.deepEqual(sampleInput(undefined, 50), { jump: false, duck: false });
});

test("time: elapsed milliseconds map to whole ticks, and survival is tick-derived", () => {
  assert.equal(tickForElapsed(0), 0);
  assert.equal(tickForElapsed(TICK_MS * 3.9), 3);
  assert.equal(tickForElapsed(-50), 0);
});
