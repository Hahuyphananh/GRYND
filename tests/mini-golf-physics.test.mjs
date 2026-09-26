/**
 * Mini Golf — deterministic physics unit tests.
 *
 * The simulator is the authority for every shot: the client submits only
 * { angle, power } and the server derives position, velocity, trajectory,
 * hole completion and stroke outcome. These tests pin the contract the whole
 * match depends on — determinism, bounded simulation, wall/cup behaviour and
 * fail-fast input validation.
 *
 * Run:  node --import tsx --test tests/mini-golf-physics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  assertShotInput,
  createBall,
  initialVelocity,
  isMoving,
  simulateShot,
} from "../src/lib/mini-golf/physics.ts";
import {
  BALL_RADIUS,
  CAPTURE_MAX_SPEED,
  MAX_FRAMES,
  POWER_MAX,
  POWER_MIN,
  POWER_SCALE,
} from "../src/lib/mini-golf/constants.ts";
import { hashSeed } from "../src/lib/physics2d/deterministic.ts";
import { hashSeed as plinkoHashSeed } from "../src/lib/plinko-pvp/physics.js";

/**
 * A hand-built hole so assertions can be exact. `friction`/`wallRestitution`
 * are intentionally left undefined unless overridden, so `config` overrides
 * in a test actually take effect.
 */
function makeHole(overrides = {}) {
  return {
    index: 1,
    par: 2,
    template: "test",
    geometry: {
      width: 400,
      height: 560,
      tee: { x: 200, y: 500 },
      cup: { x: 200, y: 60, r: 14 },
      walls: [],
      bumpers: [],
      sand: [],
      water: [],
      ...overrides,
    },
  };
}

const TEE = { x: 200, y: 500 };
const CUP = { x: 200, y: 60, r: 14 };

/** Count how many times the trajectory reverses its x direction. */
function countXReversals(path) {
  let reversals = 0;
  let prevSign = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    if (Math.abs(dx) <= 0.5) continue;
    const sign = Math.sign(dx);
    if (prevSign !== 0 && sign !== prevSign) reversals++;
    prevSign = sign;
  }
  return reversals;
}

function assertInBounds(result, width, height) {
  for (const point of result.path) {
    assert.ok(Number.isFinite(point.x), "path x must be finite");
    assert.ok(Number.isFinite(point.y), "path y must be finite");
    assert.ok(point.x >= -1e-6 && point.x <= width + 1e-6, `path x in bounds (${point.x})`);
    assert.ok(point.y >= -1e-6 && point.y <= height + 1e-6, `path y in bounds (${point.y})`);
  }
  assert.ok(result.restPosition.x >= 0 && result.restPosition.x <= width);
  assert.ok(result.restPosition.y >= 0 && result.restPosition.y <= height);
}

// ── 1. zero / minimum power ────────────────────────────────────────────────

test("zero power produces an immediate, stationary settle", () => {
  const hole = makeHole();
  const result = simulateShot({ hole, shot: { angle: 0, power: 0 } });

  assert.equal(result.settled, true);
  assert.equal(result.pocketed, false);
  assert.equal(result.hitStepLimit, false);
  assert.equal(result.waterHits, 0);
  assert.equal(result.frames, 1);
  assert.deepEqual(result.restPosition, { x: TEE.x, y: TEE.y });
  assert.equal(result.path.length, 1);
  assert.deepEqual(result.path[0], { x: TEE.x, y: TEE.y });
});

test("minimum power constant is zero and is accepted", () => {
  assert.equal(POWER_MIN, 0);
  const hole = makeHole();
  const result = simulateShot({ hole, shot: { angle: 180, power: POWER_MIN } });
  assert.deepEqual(result.restPosition, { x: TEE.x, y: TEE.y });
});

test("power below the minimum or above the maximum is rejected", () => {
  const hole = makeHole();
  assert.throws(() => simulateShot({ hole, shot: { angle: 0, power: -1 } }), RangeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: 0, power: POWER_MAX + 1 } }), RangeError);
});

// ── 2. maximum power ───────────────────────────────────────────────────────

test("maximum power settles inside the course and respects the frame cap", () => {
  const hole = makeHole();
  for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const result = simulateShot({ hole, shot: { angle, power: POWER_MAX } });
    assert.equal(result.settled, true, `angle ${angle} must settle`);
    assert.equal(result.hitStepLimit, false, `angle ${angle} must settle naturally`);
    assert.ok(result.frames <= MAX_FRAMES);
    assertInBounds(result, 400, 560);
  }
});

test("initial velocity is scaled by power", () => {
  const v = initialVelocity(0, POWER_MAX);
  assert.ok(Math.abs(v.x - POWER_MAX * POWER_SCALE) < 1e-9);
  assert.equal(v.y, 0);
});

// ── 3. straight shot ───────────────────────────────────────────────────────

test("a straight shot travels along a single axis", () => {
  const hole = makeHole();

  const up = simulateShot({ hole, shot: { angle: 270, power: 30 } });
  assert.ok(Math.abs(up.restPosition.x - TEE.x) < 1e-9, "x must not drift");
  assert.ok(up.restPosition.y < TEE.y, "ball must move up-screen");

  const right = simulateShot({ hole, shot: { angle: 0, power: 30 } });
  assert.ok(Math.abs(right.restPosition.y - TEE.y) < 1e-9, "y must not drift");
  assert.ok(right.restPosition.x > TEE.x, "ball must move right");
});

// ── 4. diagonal shot ───────────────────────────────────────────────────────

test("a diagonal shot moves on both axes", () => {
  const hole = makeHole();
  const start = { x: 100, y: 450 };
  const result = simulateShot({
    hole,
    from: start,
    shot: { angle: 45, power: 40 },
  });

  assert.ok(
    result.path.some((p) => p.x > start.x + 1 && p.y > start.y + 1),
    "trajectory must advance down-right",
  );
  assert.ok(result.restPosition.x > start.x, "net x movement is to the right");
  assertInBounds(result, 400, 560);
});

// ── 5. wall collision ──────────────────────────────────────────────────────

test("a wall collision keeps the ball inside and reverses it", () => {
  const hole = makeHole();
  const result = simulateShot({ hole, shot: { angle: 0, power: 100 } });

  const maxX = Math.max(...result.path.map((p) => p.x));
  assert.ok(maxX <= 400 - BALL_RADIUS + 0.6, `ball must stop at the wall (maxX=${maxX})`);
  assert.ok(maxX >= 400 - BALL_RADIUS - 1, "ball must actually reach the wall");
  assert.ok(result.restPosition.x < maxX - 5, "ball must bounce back off the wall");
  assertInBounds(result, 400, 560);
});

test("the top wall reverses an upward shot", () => {
  const hole = makeHole({ tee: { x: 200, y: 120 } });
  const result = simulateShot({ hole, shot: { angle: 270, power: 100 } });

  const minY = Math.min(...result.path.map((p) => p.y));
  assert.ok(minY >= BALL_RADIUS - 0.6, `ball must not pass the top wall (minY=${minY})`);
  assert.ok(result.restPosition.y > minY + 5, "ball must come back down");
});

// ── 6. repeated wall collisions ────────────────────────────────────────────

test("a ball in a tight box bounces off walls repeatedly", () => {
  const hole = makeHole({
    width: 120,
    height: 120,
    tee: { x: 60, y: 60 },
    cup: { x: 60, y: 12, r: 14 },
  });
  const result = simulateShot({
    hole,
    shot: { angle: 20, power: 100 },
    config: { friction: 0.99 },
  });

  assert.ok(countXReversals(result.path) >= 2, "expected multiple wall bounces");
  assertInBounds(result, 120, 120);
});

// ── 7. friction ────────────────────────────────────────────────────────────

test("less damping means more travel for the same shot", () => {
  const hole = makeHole();
  const shot = { angle: 270, power: 30 };

  const slippery = simulateShot({ hole, shot, config: { friction: 0.98 } });
  const grippy = simulateShot({ hole, shot, config: { friction: 0.95 } });

  const distSlippery = Math.abs(slippery.restPosition.y - TEE.y);
  const distGrippy = Math.abs(grippy.restPosition.y - TEE.y);

  assert.ok(distSlippery > distGrippy, `0.98 (${distSlippery}) must outrun 0.95 (${distGrippy})`);
});

test("a per-hole friction setting overrides the config default", () => {
  const shot = { angle: 270, power: 30 };
  const fast = simulateShot({ hole: makeHole({ friction: 0.995 }), shot });
  const slow = simulateShot({ hole: makeHole({ friction: 0.9 }), shot });

  assert.ok(
    Math.abs(fast.restPosition.y - TEE.y) > Math.abs(slow.restPosition.y - TEE.y),
    "the slippery hole must carry the ball further",
  );
});

// ── 8. ball eventually stopping ────────────────────────────────────────────

test("every shot settles without hitting the safety cap", () => {
  const hole = makeHole();
  for (const power of [0, 1, 25, 50, 75, 100]) {
    for (const angle of [0, 30, 90, 150, 210, 270, 330]) {
      const result = simulateShot({ hole, shot: { angle, power } });
      assert.equal(result.settled, true);
      assert.equal(result.hitStepLimit, false);
      assert.equal(isMoving(createBall(result.restPosition)), false);
      assert.ok(result.frames >= 1 && result.frames <= MAX_FRAMES);
    }
  }
});

// ── 9. hole detection ──────────────────────────────────────────────────────

test("a slow ball entering the cup is pocketed and snapped to the cup", () => {
  const hole = makeHole();
  const result = simulateShot({
    hole,
    from: { x: CUP.x, y: CUP.y + 120 },
    shot: { angle: 270, power: 25 },
  });

  assert.equal(result.pocketed, true);
  assert.equal(result.settled, true);
  assert.deepEqual(result.restPosition, { x: CUP.x, y: CUP.y });
  assert.deepEqual(result.path[result.path.length - 1], { x: CUP.x, y: CUP.y });
});

test("the cup honours the valid-entry speed threshold", () => {
  const hole = makeHole();
  const args = {
    hole,
    from: { x: CUP.x, y: CUP.y + 120 },
    shot: { angle: 270, power: 25 },
  };

  const captured = simulateShot(args);
  assert.equal(captured.pocketed, true);

  // Same shot, but entry is impossible: nothing may ever be pocketed.
  const never = simulateShot({ ...args, config: { captureMaxSpeed: -1 } });
  assert.equal(never.pocketed, false);
});

test("a ball that never reaches the cup is not pocketed", () => {
  const hole = makeHole();
  const result = simulateShot({ hole, shot: { angle: 0, power: 20 } });
  assert.equal(result.pocketed, false);
});

test("the capture threshold constant is a positive speed", () => {
  assert.ok(CAPTURE_MAX_SPEED > 0 && CAPTURE_MAX_SPEED < 20);
});

// ── 10. deterministic identical inputs ─────────────────────────────────────

test("identical inputs produce byte-identical results", () => {
  const hole = makeHole();
  const args = { hole, from: { x: 143, y: 427 }, shot: { angle: 37.5, power: 63 } };

  const a = simulateShot(args);
  const b = simulateShot(args);

  assert.deepEqual(a, b);
  assert.deepEqual(a.path, b.path);
});

test("a structurally identical hole produces identical results", () => {
  const args = { from: { x: 200, y: 300 }, shot: { angle: 210, power: 55 } };
  const a = simulateShot({ hole: makeHole(), ...args });
  const b = simulateShot({ hole: makeHole(), ...args });
  assert.deepEqual(a, b);
});

test("client-supplied outcome fields are ignored", () => {
  const hole = makeHole();
  const base = { hole, from: { x: CUP.x, y: CUP.y + 120 } };

  const clean = simulateShot({ ...base, shot: { angle: 270, power: 25 } });
  const tampered = simulateShot({
    ...base,
    shot: {
      angle: 270,
      power: 25,
      restPosition: { x: 999, y: 999 },
      pocketed: false,
      strokes: 0,
      winner: 1,
    },
  });

  assert.deepEqual(tampered, clean, "extra fields must not influence the simulation");
  assert.equal(tampered.pocketed, true, "hole completion is computed, not accepted");
});

// ── 11. simulation safety / max-step handling ──────────────────────────────

test("a non-decaying ball is force-settled at the frame cap", () => {
  const hole = makeHole();
  const result = simulateShot({
    hole,
    shot: { angle: 30, power: 100 },
    config: { maxFrames: 40, friction: 1, stopEpsilon: 0, captureMaxSpeed: -1 },
  });

  assert.equal(result.hitStepLimit, true);
  assert.equal(result.settled, true);
  assert.equal(result.frames, 40);
  assertInBounds(result, 400, 560);
});

test("the simulator never loops forever on pathological geometry", () => {
  const hole = makeHole({
    walls: [
      { a: { x: 0, y: 280 }, b: { x: 400, y: 280 } },
      { a: { x: 200, y: 0 }, b: { x: 200, y: 560 } },
    ],
  });
  const result = simulateShot({ hole, shot: { angle: 123, power: 100 } });
  assert.equal(result.settled, true);
  assert.ok(result.frames <= MAX_FRAMES);
  assertInBounds(result, 400, 560);
});

// ── 12. malformed inputs ───────────────────────────────────────────────────

test("malformed shot inputs throw instead of simulating", () => {
  const hole = makeHole();

  assert.throws(() => simulateShot({ hole }), TypeError);
  assert.throws(() => simulateShot({ hole, shot: null }), TypeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: NaN, power: 10 } }), TypeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: 0, power: NaN } }), TypeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: Infinity, power: 10 } }), TypeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: 0, power: "50" } }), TypeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: 360, power: 10 } }), RangeError);
  assert.throws(() => simulateShot({ hole, shot: { angle: -0.1, power: 10 } }), RangeError);
  assert.throws(() => simulateShot({ hole, shot: {} }), TypeError);
  assert.throws(() => simulateShot({}), TypeError);
  assert.throws(() => simulateShot({ hole: {} , shot: { angle: 0, power: 10 } }), TypeError);
  assert.throws(
    () => simulateShot({ hole, from: { x: NaN, y: 0 }, shot: { angle: 0, power: 10 } }),
    TypeError,
  );
});

test("assertShotInput returns a canonical, validated shot", () => {
  assert.deepEqual(assertShotInput({ angle: 12.5, power: 40 }), { angle: 12.5, power: 40 });
});

// ── Path-shape invariants (supporting the above) ───────────────────────────

test("the path starts at the shot origin and ends at the rest position", () => {
  const hole = makeHole();
  const from = { x: 150, y: 400 };
  const result = simulateShot({ hole, from, shot: { angle: 315, power: 70 } });

  assert.deepEqual(result.path[0], { x: from.x, y: from.y });
  assert.deepEqual(result.path[result.path.length - 1], result.restPosition);
  assert.ok(result.path.length >= 2);
});

test("default config mirrors the exported tuning constants", () => {
  assert.equal(DEFAULT_CONFIG.maxFrames, MAX_FRAMES);
  assert.equal(DEFAULT_CONFIG.powerScale, POWER_SCALE);
  assert.equal(DEFAULT_CONFIG.ballRadius, BALL_RADIUS);
});

// ── Shared-layer parity (guards the extraction) ────────────────────────────

test("the shared seed hash matches the Plinko implementation bit-for-bit", () => {
  const samples = [
    "",
    "a",
    "mini-golf:course:1:1",
    "plinko:13:p1:ball1:manual",
    "unicode-\u00e9\u00e0\u4e2d\u6587",
    "x".repeat(200),
  ];
  for (const sample of samples) {
    assert.equal(
      hashSeed(sample),
      plinkoHashSeed(sample),
      "physics2d.hashSeed drifted from plinko-pvp.hashSeed",
    );
  }
});
