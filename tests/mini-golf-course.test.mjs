/**
 * Mini Golf — deterministic course generator tests.
 *
 * Both players must be dealt exactly the same five holes, the holes must be
 * random enough between matches, every generated hole must be playable, and
 * difficulty must ramp instead of dealing five near-impossible holes. A
 * non-deterministic or invalid course would be unfixable at match time, so all
 * of that is asserted here.
 *
 * Run:  node --import tsx --test tests/mini-golf-course.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeReachability,
  buildHole,
  generateCourse,
  generateCourseReport,
  generateHole,
  generateHoleDetailed,
  validateHole,
} from "../src/lib/mini-golf/course.ts";
import {
  BALL_RADIUS,
  COURSE_HEIGHT,
  COURSE_VERSION,
  COURSE_WIDTH,
  CUP_RADIUS,
  DIFFICULTY_RAMP,
  HOLE_COUNT,
  HOLE_DIFFICULTY_LEVELS,
  HOLE_TEMPLATES,
  MAX_HOLE_GENERATION_ATTEMPTS,
  MIN_REACHABLE_CELLS,
} from "../src/lib/mini-golf/constants.ts";
import {
  TEMPLATE_LEVELS,
  canonicalLayout,
  parForLevel,
} from "../src/lib/mini-golf/courseTemplates.ts";
import { simulateShot } from "../src/lib/mini-golf/physics.ts";
import { mulberry32, hashSeed } from "../src/lib/physics2d/deterministic.ts";

const SAMPLE_SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i * 7919);

test("a course has five holes numbered 1..5, one per difficulty tier", () => {
  const course = generateCourse(42);
  assert.equal(course.holes.length, HOLE_COUNT);
  assert.deepEqual(
    course.holes.map((h) => h.index),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    course.holes.map((h) => h.difficulty),
    [...DIFFICULTY_RAMP],
  );
  for (const hole of course.holes) {
    assert.ok(HOLE_TEMPLATES.includes(hole.template), `unknown template ${hole.template}`);
    assert.ok(DIFFICULTY_RAMP.includes(hole.difficulty), `unknown difficulty ${hole.difficulty}`);
  }
  assert.equal(course.version, COURSE_VERSION);
});

test("the same seed always produces the same course", () => {
  const a = generateCourse(123456);
  const b = generateCourse(123456);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("generation across a fresh PRNG stream is reproducible", () => {
  // Two independent runs must not share hidden module state.
  const first = generateCourse(7);
  const second = generateCourse(7);
  const third = generateCourse(7);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test("different seeds produce materially different courses", () => {
  const a = generateCourse(1);
  const b = generateCourse(2);
  assert.notDeepEqual(a, b);

  // Over a spread of seeds, layouts must vary — not just the jitter.
  const signatures = new Set(
    SAMPLE_SEEDS.map((seed) => JSON.stringify(generateCourse(seed).holes)),
  );
  assert.ok(signatures.size > SAMPLE_SEEDS.length * 0.9, "courses should almost never collide");
});

test("bumping the course version regenerates a different course", () => {
  const v1 = generateCourse(999, 1);
  const v2 = generateCourse(999, 2);
  assert.notDeepEqual(v1, v2);
  // …but each version is still individually deterministic.
  assert.deepEqual(generateCourse(999, 1), v1);
});

test("every generated hole passes validation across many seeds", () => {
  for (const seed of SAMPLE_SEEDS) {
    const course = generateCourse(seed);
    for (const hole of course.holes) {
      assert.deepEqual(validateHole(hole), [], `seed ${seed} hole ${hole.index} must be valid`);
    }
  }
});

test("holes keep tee and cup inside the playable area with clearance", () => {
  for (const seed of SAMPLE_SEEDS.slice(0, 20)) {
    for (const hole of generateCourse(seed).holes) {
      const { tee, cup, width, height } = hole.geometry;
      assert.ok(tee.x >= BALL_RADIUS && tee.x <= width - BALL_RADIUS);
      assert.ok(tee.y >= BALL_RADIUS && tee.y <= height - BALL_RADIUS);
      assert.ok(cup.x >= CUP_RADIUS && cup.x <= width - CUP_RADIUS);
      assert.ok(cup.y >= CUP_RADIUS && cup.y <= height - CUP_RADIUS);
      assert.equal(width, COURSE_WIDTH);
      assert.equal(height, COURSE_HEIGHT);
    }
  }
});

test("hole friction is a deterministic, sane per-hole value", () => {
  for (const seed of SAMPLE_SEEDS.slice(0, 20)) {
    for (const hole of generateCourse(seed).holes) {
      const f = hole.geometry.friction;
      assert.equal(typeof f, "number");
      assert.ok(f > 0.97 && f < 0.983, `friction out of band: ${f}`);
    }
  }
});

test("par is assigned from the difficulty level and stays in 2..4", () => {
  for (const hole of generateCourse(5).holes) {
    const level = HOLE_DIFFICULTY_LEVELS[hole.difficulty];
    assert.equal(hole.par, parForLevel(level));
    assert.ok(Number.isInteger(hole.par) && hole.par >= 2 && hole.par <= 4);
  }
});

test("the chosen template is compatible with the hole's difficulty tier", () => {
  for (const seed of SAMPLE_SEEDS) {
    for (const hole of generateCourse(seed).holes) {
      const target = HOLE_DIFFICULTY_LEVELS[hole.difficulty];
      const templateLevel = TEMPLATE_LEVELS[hole.template];
      assert.ok(templateLevel !== undefined, `no level for template ${hole.template}`);
      assert.ok(
        Math.abs(templateLevel - target) <= 1,
        `seed ${seed} hole ${hole.index}: template ${hole.template} (L${templateLevel}) off-tier L${target}`,
      );
    }
  }
});

test("every hole is reachable tee-to-cup with enough open playable space", () => {
  for (const seed of SAMPLE_SEEDS) {
    for (const hole of generateCourse(seed).holes) {
      const analysis = analyzeReachability(hole.geometry);
      assert.ok(analysis.cupReachable, `seed ${seed} hole ${hole.index}: cup unreachable`);
      assert.ok(
        analysis.reachable >= MIN_REACHABLE_CELLS,
        `seed ${seed} hole ${hole.index}: only ${analysis.reachable} reachable cells`,
      );
    }
  }
});

test("the generator stays within budget: no fallbacks and few rejections", () => {
  let rejected = 0;
  let fallbacks = 0;
  let holes = 0;
  for (const seed of SAMPLE_SEEDS) {
    const report = generateCourseReport(seed);
    for (const entry of report.holes) {
      holes += 1;
      rejected += entry.rejected;
      if (entry.usedFallback) fallbacks += 1;
      assert.deepEqual(validateHole(entry.hole), []);
    }
  }
  assert.equal(fallbacks, 0, "canonical fallback should never be needed for sampled seeds");
  // Re-rolls are allowed, but should be the exception rather than the rule.
  assert.ok(rejected <= holes * 0.5, `too many re-rolls: ${rejected} for ${holes} holes`);
});

test("a generated course is playable: shots settle inside bounds", () => {
  const course = generateCourse(2026);
  for (const hole of course.holes) {
    for (const angle of [0, 90, 180, 270]) {
      for (const power of [10, 60, 100]) {
        const result = simulateShot({ hole, shot: { angle, power } });
        assert.equal(result.settled, true);
        assert.ok(Number.isFinite(result.restPosition.x));
        assert.ok(Number.isFinite(result.restPosition.y));
        assert.ok(result.restPosition.x >= 0 && result.restPosition.x <= hole.geometry.width);
        assert.ok(result.restPosition.y >= 0 && result.restPosition.y <= hole.geometry.height);
      }
    }
  }
});

test("validateHole reports problems for a broken hole", () => {
  const broken = buildHole(1, "straight", mulberry32(hashSeed("broken")));
  broken.geometry.cup.x = -50;
  broken.geometry.friction = 1.5;
  const problems = validateHole(broken);
  assert.ok(problems.length >= 2, `expected multiple problems, got ${problems.length}`);
});

test("validateHole flags a wall sitting on the cup", () => {
  const hole = buildHole(1, "straight", mulberry32(hashSeed("wall-on-cup")));
  hole.geometry.walls = [
    {
      a: { x: hole.geometry.cup.x - 60, y: hole.geometry.cup.y },
      b: { x: hole.geometry.cup.x + 60, y: hole.geometry.cup.y },
    },
  ];
  assert.ok(validateHole(hole).some((p) => p.includes("cup")));
});

test("validateHole rejects a channel too narrow for the ball", () => {
  const hole = buildHole(1, "straight", mulberry32(hashSeed("pinch")));
  hole.geometry.walls = [
    { a: { x: 120, y: 200 }, b: { x: 120, y: 420 } },
    { a: { x: 132, y: 200 }, b: { x: 132, y: 420 } },
  ];
  assert.ok(validateHole(hole).some((p) => p.includes("narrow")));
});

test("validateHole rejects illegally overlapping obstacles", () => {
  const hole = buildHole(1, "straight", mulberry32(hashSeed("overlap")));
  hole.geometry.bumpers = [
    { x: 200, y: 300, r: 30 },
    { x: 210, y: 300, r: 30 },
  ];
  assert.ok(validateHole(hole).some((p) => p.includes("overlap")));
});

test("validateHole rejects a cup walled off from the tee", () => {
  const hole = buildHole(1, "long-distance", mulberry32(hashSeed("sealed")));
  hole.geometry.walls = [{ a: { x: 0, y: 300 }, b: { x: COURSE_WIDTH, y: 300 } }];
  hole.geometry.bumpers = [];
  hole.geometry.sand = [];
  hole.geometry.water = [];
  assert.ok(validateHole(hole).some((p) => p.includes("not reachable")));
});

test("generateHole always returns a valid hole even from an awkward stream", () => {
  // Feed a degenerate PRNG that always returns the same number; the bounded
  // re-roll loop must still terminate with a usable hole.
  const constant = () => 0.999999;
  const hole = generateHole(1, "straight", constant);
  assert.equal(typeof hole.geometry.cup.r, "number");
  assert.ok(hole.geometry.cup.r > 0);
});

test("generateHoleDetailed reports attempts and rejections", () => {
  const report = generateHoleDetailed(1, "zig-zag", mulberry32(hashSeed("report")), "hard");
  assert.equal(report.index, 1);
  assert.equal(report.difficulty, "hard");
  assert.ok(report.attempts >= 1);
  assert.equal(report.rejected, report.attempts - 1);
  assert.equal(report.usedFallback, false);
  assert.deepEqual(validateHole(report.hole), []);
  assert.equal(report.hole.difficulty, "hard");
});

test("the canonical fallback layout is valid by construction", () => {
  const layout = canonicalLayout(COURSE_WIDTH, COURSE_HEIGHT);
  const hole = {
    index: 1,
    par: 2,
    template: "straight",
    difficulty: "easy",
    geometry: {
      width: COURSE_WIDTH,
      height: COURSE_HEIGHT,
      tee: layout.tee,
      cup: { x: layout.cup.x, y: layout.cup.y, r: CUP_RADIUS },
      friction: 0.978,
      walls: layout.walls,
      bumpers: layout.bumpers,
      sand: layout.sand,
      water: layout.water,
    },
  };
  assert.deepEqual(validateHole(hole), []);
});

test("buildHole is a pure function of its PRNG stream", () => {
  const a = buildHole(2, "zig-zag", mulberry32(hashSeed("pure")), "hard");
  const b = buildHole(2, "zig-zag", mulberry32(hashSeed("pure")), "hard");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("the re-roll budget holds for every template across awkward streams", () => {
  for (const template of HOLE_TEMPLATES) {
    for (const constant of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const report = generateHoleDetailed(1, template, () => constant, "medium");
      assert.ok(
        report.attempts >= 1 && report.attempts <= MAX_HOLE_GENERATION_ATTEMPTS,
        `${template}@${constant}: attempts ${report.attempts}`,
      );
      assert.deepEqual(validateHole(report.hole), [], `${template}@${constant} must end valid`);
    }
  }
});

test("generateCourse rejects a non-finite seed", () => {
  assert.throws(() => generateCourse(NaN), TypeError);
  assert.throws(() => generateCourse(Infinity), TypeError);
});
