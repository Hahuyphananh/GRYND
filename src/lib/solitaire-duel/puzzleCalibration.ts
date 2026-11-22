// src/lib/solitaire-duel/puzzleCalibration.ts
//
// RECORDED-HUMAN CALIBRATION for the Beginner and Intermediate puzzle tiers.
//
// WHY IT EXISTS: the library's difficulty is a measured STRUCTURAL score
// (branching, productive alternatives, a delayed greedy move, reveals), not a
// claim about how often people actually solve it. That score is good at ranking
// positions relative to each other and blind to the audience. This module lets
// real recorded play correct the two learning tiers:
//
//   * a Beginner position people FAIL is promoted to Intermediate;
//   * an Intermediate position people clear easily is demoted to Beginner.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * it never touches Advanced / Expert / Master — the competitive pool keeps
//     its structural rating, so this cannot reshape ranked difficulty;
//   * it moves a puzzle at most ONE tier, so a noisy sample cannot send a
//     Beginner position straight to Advanced;
//   * it refuses a move that would shrink a tier below its shipped floor or
//     remove the last puzzle of a category from its source tier.
//
// SAMPLE RULE: a position needs PUZZLE_CALIBRATION_MIN_ATTEMPTS human attempts
// before its rate is trusted. Below that it stays structural, which is why an
// empty calibration map is a legitimate result rather than a bug.
//
// PURE: the derivation takes plain rows and returns a plain map. The database
// reader lives in scripts/calibrate-puzzle-library.mjs, so this module stays
// browser-safe and testable without a database.

import {
  PUZZLE_DIFFICULTY_CALIBRATION,
  PUZZLE_CALIBRATION_META,
  type PuzzleCalibrationSnapshot,
} from "./puzzleCalibrationData";

export { PUZZLE_DIFFICULTY_CALIBRATION, PUZZLE_CALIBRATION_META };
export type { PuzzleCalibrationSnapshot };
export type PuzzleCalibrationEntry = PuzzleCalibrationSnapshot[string];

/** Human attempts required before a measured rate can move a tier. */
export const PUZZLE_CALIBRATION_MIN_ATTEMPTS =
  PUZZLE_CALIBRATION_META.minAttempts;

/**
 * A Beginner position below this solve rate is harder than its label claims.
 * 40% is deliberately low: only a position most players fail moves up.
 */
export const PUZZLE_CALIBRATION_PROMOTE_BELOW = 0.4;

/**
 * An Intermediate position at or above this rate is easy enough to be a
 * Beginner: three in four players clear it.
 */
export const PUZZLE_CALIBRATION_DEMOTE_AT = 0.75;

/**
 * Depth floors the two learning tiers must keep.
 *
 * Five keeps every band selectable and leaves the combined learning pool
 * intact; calibration moves positions between the two tiers, it never shrinks
 * that pool. Without a floor a run of noisy samples could empty a tier.
 */
export const PUZZLE_CALIBRATION_FLOORS = Object.freeze({
  beginner: 5,
  intermediate: 5,
});

export type CalibrationSample = { attempts: number; solves: number };

export type CalibrationPuzzle = {
  id: string;
  /** The structural band this position currently carries. */
  band: number;
  category: string;
};

export type CalibrationChange = {
  id: string;
  from: 1 | 2;
  to: 1 | 2;
  attempts: number;
  solves: number;
  rate: number;
};

export type CalibrationSkip = {
  id: string;
  reason:
    | "insufficient-sample"
    | "no-change"
    | "tier-floor"
    | "category-coverage"
    | "not-learning-tier";
  attempts: number;
  solves: number;
  rate: number | null;
};

export type CalibrationReport = {
  generatedAt: string;
  windowDays: number;
  minAttempts: number;
  puzzlesConsidered: number;
  sampled: number;
  eligible: number;
  changes: CalibrationChange[];
  skips: CalibrationSkip[];
  byTier: { beginner: number; intermediate: number };
};

export function solveRateFor(sample: CalibrationSample | undefined | null): number | null {
  const attempts = Number(sample?.attempts ?? 0);
  const solves = Number(sample?.solves ?? 0);
  if (!Number.isFinite(attempts) || attempts <= 0) return null;
  if (!Number.isFinite(solves) || solves < 0) return null;
  return Math.round((Math.min(solves, attempts) / attempts) * 1000) / 1000;
}

/**
 * The band a puzzle's MEASURED rate asks for, before guardrails.
 *
 * `null` means "keep the structural band": the puzzle is outside the learning
 * tiers or has too little data to judge.
 */
export function proposedBandFor(
  puzzle: CalibrationPuzzle,
  sample: CalibrationSample | undefined | null,
  minAttempts: number = PUZZLE_CALIBRATION_MIN_ATTEMPTS,
): 1 | 2 | null {
  if (puzzle.band !== 1 && puzzle.band !== 2) return null;
  const attempts = Number(sample?.attempts ?? 0);
  const solves = Number(sample?.solves ?? 0);
  if (!Number.isFinite(attempts) || attempts < minAttempts) return null;
  const rate = solveRateFor({ attempts, solves });
  if (rate === null) return null;

  if (puzzle.band === 1 && rate < PUZZLE_CALIBRATION_PROMOTE_BELOW) return 2;
  if (puzzle.band === 2 && rate >= PUZZLE_CALIBRATION_DEMOTE_AT) return 1;
  return null;
}

/**
 * Derive the calibration map from recorded samples.
 *
 * Deterministic: puzzles are processed in id order, so the same samples always
 * produce the same map and the same skips, whatever order the query returned.
 */
export function deriveDifficultyCalibration({
  samples,
  puzzles,
  minAttempts = PUZZLE_CALIBRATION_MIN_ATTEMPTS,
}: {
  samples: Readonly<Record<string, CalibrationSample>>;
  puzzles: readonly CalibrationPuzzle[];
  minAttempts?: number;
}): { calibration: PuzzleCalibrationSnapshot; report: CalibrationReport } {
  const ordered = [...puzzles].sort((a, b) => a.id.localeCompare(b.id));
  const counts = {
    beginner: ordered.filter((puzzle) => puzzle.band === 1).length,
    intermediate: ordered.filter((puzzle) => puzzle.band === 2).length,
  };
  const categories = {
    beginner: new Map<string, number>(),
    intermediate: new Map<string, number>(),
  };
  for (const puzzle of ordered) {
    if (puzzle.band !== 1 && puzzle.band !== 2) continue;
    const key = puzzle.band === 1 ? "beginner" : "intermediate";
    categories[key].set(puzzle.category, (categories[key].get(puzzle.category) ?? 0) + 1);
  }

  const changes: CalibrationChange[] = [];
  const skips: CalibrationSkip[] = [];
  let sampled = 0;
  let eligible = 0;

  for (const puzzle of ordered) {
    const sample = samples[puzzle.id];
    const rate = solveRateFor(sample);
    if (!sample || Number(sample.attempts) <= 0) continue;
    sampled += 1;

    if (puzzle.band !== 1 && puzzle.band !== 2) {
      skips.push({
        id: puzzle.id,
        reason: "not-learning-tier",
        attempts: Number(sample.attempts),
        solves: Number(sample.solves),
        rate,
      });
      continue;
    }
    if (Number(sample.attempts) < minAttempts) {
      skips.push({
        id: puzzle.id,
        reason: "insufficient-sample",
        attempts: Number(sample.attempts),
        solves: Number(sample.solves),
        rate,
      });
      continue;
    }
    eligible += 1;

    const target = proposedBandFor(puzzle, sample, minAttempts);
    const from = puzzle.band as 1 | 2;
    if (target === null || target === from) {
      skips.push({
        id: puzzle.id,
        reason: "no-change",
        attempts: Number(sample.attempts),
        solves: Number(sample.solves),
        rate,
      });
      continue;
    }

    const sourceKey = from === 1 ? "beginner" : "intermediate";
    const targetKey = target === 1 ? "beginner" : "intermediate";
    const floor = PUZZLE_CALIBRATION_FLOORS[sourceKey];
    if (counts[sourceKey] - 1 < floor) {
      skips.push({
        id: puzzle.id,
        reason: "tier-floor",
        attempts: Number(sample.attempts),
        solves: Number(sample.solves),
        rate,
      });
      continue;
    }
    if ((categories[sourceKey].get(puzzle.category) ?? 0) <= 1) {
      skips.push({
        id: puzzle.id,
        reason: "category-coverage",
        attempts: Number(sample.attempts),
        solves: Number(sample.solves),
        rate,
      });
      continue;
    }

    counts[sourceKey] -= 1;
    counts[targetKey] += 1;
    categories[sourceKey].set(puzzle.category, (categories[sourceKey].get(puzzle.category) ?? 1) - 1);
    categories[targetKey].set(puzzle.category, (categories[targetKey].get(puzzle.category) ?? 0) + 1);
    changes.push({
      id: puzzle.id,
      from,
      to: target,
      attempts: Number(sample.attempts),
      solves: Number(sample.solves),
      rate: rate ?? 0,
    });
  }

  const calibration = Object.fromEntries(
    changes.map((change) => [
      change.id,
      {
        attempts: change.attempts,
        solves: change.solves,
        rate: change.rate,
        band: change.to,
      },
    ]),
  ) as Record<string, PuzzleCalibrationEntry>;

  return {
    calibration: Object.freeze(calibration),
    report: {
      generatedAt: PUZZLE_CALIBRATION_META.generatedAt,
      windowDays: PUZZLE_CALIBRATION_META.windowDays,
      minAttempts,
      puzzlesConsidered: ordered.length,
      sampled,
      eligible,
      changes,
      skips,
      byTier: { beginner: counts.beginner, intermediate: counts.intermediate },
    },
  };
}

/**
 * The band to actually use, from the shipped measured snapshot.
 *
 * A calibration entry only applies to a Beginner/Intermediate position whose
 * structure still puts it there; a stale entry that would move a competitive
 * puzzle is ignored rather than trusted.
 */
export function calibratedBandFor(
  puzzleId: string,
  structuralBand: number,
  calibration: PuzzleCalibrationSnapshot = PUZZLE_DIFFICULTY_CALIBRATION,
): number {
  if (structuralBand !== 1 && structuralBand !== 2) return structuralBand;
  const entry = calibration[puzzleId];
  if (!entry) return structuralBand;
  if (entry.band !== 1 && entry.band !== 2) return structuralBand;
  if (entry.attempts < PUZZLE_CALIBRATION_MIN_ATTEMPTS) return structuralBand;
  return entry.band;
}
