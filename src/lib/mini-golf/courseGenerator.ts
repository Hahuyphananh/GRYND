// src/lib/mini-golf/courseGenerator.ts
//
// Deterministic procedural Mini Golf course generation.
//
// A course is a pure function of (seed, COURSE_VERSION). The server generates
// it once when the match is created and stores the result; both players are
// handed the same five holes, and no client ever invents authoritative
// geometry.
//
// Design constraints (see the prompt's "do NOT create completely random walls"):
//   • Geometry never comes from an unconstrained random walk — it is drawn from
//     the controlled template library in `courseTemplates.ts` with *bounded*
//     randomized parameters (tee/cup offset, wall lengths, corridor width, gap
//     placement, obstacle count/size/position).
//   • Difficulty follows the fixed ramp in `constants.ts`, so a match always
//     ramps easy → hard and never deals five near-impossible holes. The chosen
//     template is constrained to the target tier's neighbourhood, and the
//     jitter keeps consecutive matches from feeling identical.
//   • Every candidate is validated (`courseValidation.ts`); invalid holes are
//     re-rolled from the same seeded PRNG stream. On exhaustion the generator
//     falls back to the canonical straight layout, which is valid by
//     construction — so a match can never be dealt an unplayable hole.
//
// All randomness comes from a seeded Mulberry32 PRNG
// (`src/lib/physics2d/deterministic.ts`) — never Math.random(), never a clock.

import { hashSeed, mulberry32 } from "../physics2d/deterministic";
import {
  COURSE_HEIGHT,
  COURSE_VERSION,
  COURSE_WIDTH,
  CUP_RADIUS,
  DIFFICULTY_RAMP,
  HOLE_COUNT,
  HOLE_DIFFICULTY_LEVELS,
  MAX_HOLE_GENERATION_ATTEMPTS,
  type HoleTemplate,
} from "./constants";
import {
  TEMPLATES,
  TEMPLATE_LEVELS,
  canonicalLayout,
  mirrorLayoutX,
  parForLevel,
  pick,
  templateByName,
} from "./courseTemplates";
import { validateHole } from "./courseValidation";
import type { Course, Hole, HoleDifficulty } from "./types";

/** Per-hole generation accounting. Lets callers see (and tests assert) re-rolls. */
export type HoleBuildReport = {
  hole: Hole;
  index: number;
  template: string;
  difficulty: HoleDifficulty;
  /** Total build attempts, including the accepted one. */
  attempts: number;
  /** Failed attempts (attempts − 1, or attempts when the fallback was used). */
  rejected: number;
  /** True when the budget was exhausted and the canonical layout was used. */
  usedFallback: boolean;
  /** Problems reported by the last rejected attempt (empty when none). */
  problems: string[];
};

export type CourseReport = {
  course: Course;
  holes: HoleBuildReport[];
};

const WIDTH = COURSE_WIDTH;
const HEIGHT = COURSE_HEIGHT;

// ── Template selection ────────────────────────────────────────────────────

/**
 * Pick a template whose intrinsic level is within one step of the target
 * difficulty. That keeps the hole honest to its tier without making, say,
 * every "easy" hole literally the same primitive.
 */
function pickTemplate(rand: () => number, level: number) {
  const lo = Math.max(1, level - 1);
  const hi = Math.min(5, level + 1);
  const candidates = TEMPLATES.filter((template) => template.level >= lo && template.level <= hi);
  return pick(rand, candidates);
}

// ── Hole construction ─────────────────────────────────────────────────────

/**
 * Build ONE candidate hole. May fail validation — callers retry with the same
 * PRNG stream. `difficulty` selects the parameter density and the template
 * level; when omitted the template's own level is used.
 */
export function buildHole(
  index: number,
  template: HoleTemplate,
  rand: () => number,
  difficulty?: HoleDifficulty,
): Hole {
  const descriptor = templateByName(template);
  const level = difficulty ? HOLE_DIFFICULTY_LEVELS[difficulty] : (TEMPLATE_LEVELS[template] ?? descriptor.level);

  const raw = descriptor.build({ rand, width: WIDTH, height: HEIGHT, level });
  // One horizontal mirror gives the layout an orientation flip, so two holes
  // from the same template do not always lean the same way.
  const layout = rand() < 0.5 ? mirrorLayoutX(raw, WIDTH) : raw;

  return {
    index,
    par: parForLevel(level),
    template,
    difficulty,
    geometry: {
      width: WIDTH,
      height: HEIGHT,
      tee: { x: layout.tee.x, y: layout.tee.y },
      cup: { x: layout.cup.x, y: layout.cup.y, r: CUP_RADIUS },
      // Per-hole pace, deterministic from the seed stream.
      friction: 0.9755 + rand() * 0.006,
      walls: layout.walls,
      bumpers: layout.bumpers,
      sand: layout.sand,
      water: layout.water,
    },
  };
}

/**
 * The generator's safety net: the parameter-free canonical straight hole.
 * Valid by construction (wide gate, centred tee/cup), used only when a hole's
 * re-roll budget is exhausted.
 */
function canonicalHole(index: number, difficulty: HoleDifficulty, rand: () => number): Hole {
  const layout = canonicalLayout(WIDTH, HEIGHT);
  const level = HOLE_DIFFICULTY_LEVELS[difficulty] ?? 1;
  return {
    index,
    par: parForLevel(level),
    template: "straight",
    difficulty,
    geometry: {
      width: WIDTH,
      height: HEIGHT,
      tee: { x: layout.tee.x, y: layout.tee.y },
      cup: { x: layout.cup.x, y: layout.cup.y, r: CUP_RADIUS },
      friction: 0.978,
      walls: layout.walls,
      bumpers: layout.bumpers,
      sand: layout.sand,
      water: layout.water,
    },
  };
}

/**
 * Generate one hole with bounded deterministic re-rolls, returning both the
 * hole and an accounting record of how many attempts were rejected.
 */
export function generateHoleDetailed(
  index: number,
  template: HoleTemplate,
  rand: () => number,
  difficulty?: HoleDifficulty,
): HoleBuildReport {
  let problems: string[] = [];
  let attempts = 0;

  for (let attempt = 0; attempt < MAX_HOLE_GENERATION_ATTEMPTS; attempt += 1) {
    attempts += 1;
    const hole = buildHole(index, template, rand, difficulty);
    const found = validateHole(hole);
    if (found.length === 0) {
      return {
        hole,
        index,
        template: hole.template,
        difficulty: hole.difficulty as HoleDifficulty,
        attempts,
        rejected: attempts - 1,
        usedFallback: false,
        problems,
      };
    }
    problems = found;
  }

  const fallback = canonicalHole(index, (difficulty ?? "easy") as HoleDifficulty, rand);
  return {
    hole: fallback,
    index,
    template: fallback.template,
    difficulty: fallback.difficulty as HoleDifficulty,
    attempts,
    rejected: attempts,
    usedFallback: true,
    problems,
  };
}

/** Generate one valid hole, re-rolling until it validates (or falling back). */
export function generateHole(
  index: number,
  template: HoleTemplate,
  rand: () => number,
  difficulty?: HoleDifficulty,
): Hole {
  return generateHoleDetailed(index, template, rand, difficulty).hole;
}

// ── Course generation ─────────────────────────────────────────────────────

/**
 * Generate a full course plus per-hole generation accounting.
 *
 * One hole per difficulty tier (the ramp has exactly `HOLE_COUNT` steps), each
 * on a template compatible with that tier, all from a single PRNG stream
 * derived from `(seed, version)`.
 */
export function generateCourseReport(seed: number, version: number = COURSE_VERSION): CourseReport {
  if (!Number.isFinite(seed)) {
    throw new TypeError(`mini-golf course: seed must be a finite number, got ${String(seed)}`);
  }

  const rand = mulberry32(hashSeed(`mini-golf:course:${seed >>> 0}:${version}`));
  const holes: Hole[] = [];
  const reports: HoleBuildReport[] = [];

  for (let i = 1; i <= HOLE_COUNT; i += 1) {
    const difficulty = DIFFICULTY_RAMP[(i - 1) % DIFFICULTY_RAMP.length];
    const level = HOLE_DIFFICULTY_LEVELS[difficulty];
    const template = pickTemplate(rand, level).name;
    const report = generateHoleDetailed(i, template, rand, difficulty);
    holes.push(report.hole);
    reports.push(report);
  }

  return { course: { version, seed: seed >>> 0, holes }, holes: reports };
}

/**
 * Generate a full course from a server-owned match seed. Fully reproducible
 * from (seed, version), so the server can regenerate instead of storing the
 * geometry — but it stores it anyway so a match never depends on a later
 * generator change.
 */
export function generateCourse(seed: number, version: number = COURSE_VERSION): Course {
  return generateCourseReport(seed, version).course;
}
