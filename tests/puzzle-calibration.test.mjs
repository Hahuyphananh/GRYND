/**
 * puzzle-calibration.test.mjs
 *
 * RECORDED-HUMAN CALIBRATION for the Beginner and Intermediate tiers.
 *
 * What this pins:
 *   * a sample below the minimum never moves a tier;
 *   * a failed Beginner position is promoted and an easy Intermediate position
 *     is demoted, by exactly one tier;
 *   * a tier floor or the last puzzle of a category blocks a move;
 *   * Advanced / Expert / Master are never calibrated;
 *   * the shipped snapshot is internally consistent and refers only to real
 *     learning-tier puzzles;
 *   * `assessStrategicLoad` applies an injected snapshot to the derived band.
 *
 * Run: node --import tsx --test tests/puzzle-calibration.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PUZZLE_CALIBRATION_DEMOTE_AT,
  PUZZLE_CALIBRATION_FLOORS,
  PUZZLE_CALIBRATION_MIN_ATTEMPTS,
  PUZZLE_CALIBRATION_PROMOTE_BELOW,
  calibratedBandFor,
  deriveDifficultyCalibration,
  proposedBandFor,
  solveRateFor,
} from "../src/lib/solitaire-duel/puzzleCalibration.ts";
import {
  PUZZLE_CALIBRATION_META,
  PUZZLE_DIFFICULTY_CALIBRATION,
} from "../src/lib/solitaire-duel/puzzleCalibrationData.ts";
import {
  assessStrategicLoad,
  puzzleLibraryPuzzles,
} from "../src/lib/solitaire-duel/puzzleLibrary.ts";

function tier(count, band, category = "sequence", prefix = band === 1 ? "b" : "i") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    band,
    category,
  }));
}

const sample = (attempts, solves) => ({ attempts, solves });

// ── Rules ─────────────────────────────────────────────────────────────────

test("a sample below the minimum never moves a tier", () => {
  const puzzles = tier(6, 1);
  const { calibration, report } = deriveDifficultyCalibration({
    puzzles,
    samples: { b1: sample(PUZZLE_CALIBRATION_MIN_ATTEMPTS - 1, 0) },
  });
  assert.deepEqual(calibration, {});
  assert.equal(report.eligible, 0);
  assert.equal(report.skips[0].reason, "insufficient-sample");
});

test("a failed Beginner is promoted and an easy Intermediate is demoted", () => {
  const puzzles = [...tier(6, 1), ...tier(7, 2)];
  const { calibration, report } = deriveDifficultyCalibration({
    puzzles,
    samples: {
      b1: sample(30, 3), // 10% — too hard for Beginner
      i7: sample(30, 27), // 90% — too easy for Intermediate
      b2: sample(30, 20), // 67% — stays Beginner
    },
  });

  assert.equal(calibration.b1.band, 2);
  assert.equal(calibration.i7.band, 1);
  assert.equal(calibration.b2, undefined);
  assert.equal(calibration.b1.rate, 0.1);
  assert.equal(calibration.i7.rate, 0.9);
  assert.equal(report.changes.length, 2);
  assert.deepEqual(report.byTier, { beginner: 6, intermediate: 7 });
});

test("the threshold boundaries are inclusive where documented", () => {
  assert.equal(PUZZLE_CALIBRATION_PROMOTE_BELOW, 0.4);
  assert.equal(PUZZLE_CALIBRATION_DEMOTE_AT, 0.75);
  assert.equal(proposedBandFor({ id: "b", band: 1, category: "x" }, sample(20, 8)), null); // 0.4
  assert.equal(proposedBandFor({ id: "b", band: 1, category: "x" }, sample(20, 7)), 2);
  assert.equal(proposedBandFor({ id: "i", band: 2, category: "x" }, sample(20, 15)), 1); // 0.75
  assert.equal(proposedBandFor({ id: "i", band: 2, category: "x" }, sample(20, 14)), null);
});

test("a tier floor blocks a move instead of emptying a band", () => {
  const puzzles = [
    ...tier(PUZZLE_CALIBRATION_FLOORS.beginner - 1, 1),
    ...tier(PUZZLE_CALIBRATION_FLOORS.intermediate, 2),
  ];
  const { calibration, report } = deriveDifficultyCalibration({
    puzzles,
    samples: { b1: sample(40, 2) },
  });
  assert.deepEqual(calibration, {});
  assert.equal(report.skips.find((skip) => skip.id === "b1").reason, "tier-floor");
});

test("calibration cannot remove the last puzzle of a category from its tier", () => {
  // The beginner set is 6: the only tableau plus five sequence positions.
  const puzzles = [
    { id: "b1", band: 1, category: "tableau" },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `b${index + 2}`,
      band: 1,
      category: "sequence",
    })),
    ...tier(7, 2),
  ];
  const { calibration, report } = deriveDifficultyCalibration({
    puzzles,
    samples: { b1: sample(40, 2) },
  });
  assert.deepEqual(calibration, {});
  assert.equal(
    report.skips.find((skip) => skip.id === "b1").reason,
    "category-coverage",
  );
});

test("Advanced, Expert and Master positions are never calibrated", () => {
  for (const band of [3, 4, 5]) {
    const { calibration, report } = deriveDifficultyCalibration({
      puzzles: [{ id: `p${band}`, band, category: "endgame" }],
      samples: { [`p${band}`]: sample(100, 1) },
    });
    assert.deepEqual(calibration, {});
    assert.equal(report.skips[0].reason, "not-learning-tier");
  }
  // A stale snapshot entry cannot move a competitive position either.
  assert.equal(calibratedBandFor("p4", 4, { p4: { attempts: 100, solves: 1, rate: 0.01, band: 2 } }), 4);
});

test("the rate helper clamps impossible samples and rounds to three decimals", () => {
  assert.equal(solveRateFor(sample(3, 1)), 0.333);
  assert.equal(solveRateFor(sample(3, 9)), 1);
  assert.equal(solveRateFor(sample(0, 5)), null);
  assert.equal(solveRateFor(null), null);
});

// ── Library integration ───────────────────────────────────────────────────

test("assessStrategicLoad uses an injected snapshot for its derived band", () => {
  const puzzle = puzzleLibraryPuzzles().find((entry) => entry.levelNumber === 1);
  assert.ok(puzzle, "the library must still ship a Beginner position");

  const structural = assessStrategicLoad(puzzle.spec, puzzle.category);
  assert.equal(structural.band, 1);
  assert.equal(structural.calibration, null);

  const calibrated = assessStrategicLoad(puzzle.spec, puzzle.category, {
    [puzzle.id]: { attempts: 50, solves: 5, rate: 0.1, band: 2 },
  });
  assert.equal(calibrated.band, 2);
  assert.equal(calibrated.level.id, "intermediate");
  assert.equal(calibrated.calibration.band, 2);
  assert.equal(calibrated.score, structural.score, "the structural score itself is unchanged");

  // A snapshot entry with too small a sample is ignored.
  const ignored = assessStrategicLoad(puzzle.spec, puzzle.category, {
    [puzzle.id]: { attempts: 3, solves: 0, rate: 0, band: 2 },
  });
  assert.equal(ignored.band, 1);
  assert.equal(ignored.calibration, null);
});

test("the shipped calibration snapshot is consistent and learning-tier only", () => {
  const library = puzzleLibraryPuzzles();
  const byId = new Map(library.map((puzzle) => [puzzle.id, puzzle]));
  assert.ok(PUZZLE_CALIBRATION_META.windowDays > 0);
  assert.equal(PUZZLE_CALIBRATION_META.minAttempts, PUZZLE_CALIBRATION_MIN_ATTEMPTS);
  assert.ok(PUZZLE_CALIBRATION_META.note.length > 0);

  for (const [id, entry] of Object.entries(PUZZLE_DIFFICULTY_CALIBRATION)) {
    const puzzle = byId.get(id);
    assert.ok(puzzle, `${id} is not in the library`);
    assert.ok(puzzle.levelNumber === 1 || puzzle.levelNumber === 2, `${id} is not a learning tier`);
    assert.ok(entry.attempts >= PUZZLE_CALIBRATION_MIN_ATTEMPTS, `${id} has too small a sample`);
    assert.ok(entry.band === 1 || entry.band === 2, `${id} has an invalid calibrated band`);
    assert.equal(entry.rate, solveRateFor(entry), `${id} rate is inconsistent`);
    assert.ok(Math.abs(entry.band - puzzle.levelNumber) <= 1, `${id} moved more than one tier`);
  }
});
