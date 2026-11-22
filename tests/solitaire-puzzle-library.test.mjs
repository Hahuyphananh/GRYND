/**
 * THE STRATEGIC PUZZLE LIBRARY.
 *
 * These tests check the LIBRARY, not just the validator:
 *
 *   * every encoded start decodes and re-encodes exactly (the format is lossless);
 *   * every entry validates through the Phase 2 engine with every accepted
 *     solution replayed;
 *   * no puzzle is a one-move task: the objective is not true at the start, not
 *     true after all but the last move, and no single legal move satisfies it;
 *   * all five strategic categories and all five player-facing levels exist;
 *   * each puzzle carries at most three progressive hints whose keys exist in
 *     English, French and Spanish, and no hint names a hidden card;
 *   * the public projection never leaks the stock or a hidden identity;
 *   * accepted alternative solutions are real, and a capped alternative search
 *     stays bounded;
 *   * the quality report is consistent with the puzzles (no near-duplicates,
 *     no rejected entries, no silent gaps).
 *
 * Run: node --import tsx --test tests/solitaire-puzzle-library.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PUZZLE_LIBRARY_DATA } from "../src/lib/solitaire-duel/puzzleLibraryData.ts";
import {
  PUZZLE_LIBRARY_CATEGORIES,
  PUZZLE_LIBRARY_LEVELS,
  assessStrategicLoad,
  buildPuzzleLibrary,
  decodePuzzleStart,
  difficultyBandForScore,
  encodePuzzleStart,
  findAlternativeSolutions,
  levelForBand,
} from "../src/lib/solitaire-duel/puzzleLibrary.ts";
import { PUZZLE_LIBRARY_TRANSLATIONS } from "../src/lib/puzzleLibraryTranslations.js";
import {
  PUZZLE_SPEC_VERSION,
  objectiveReached,
  puzzleMoveSignature,
  puzzlePublicSpec,
  validatePuzzle,
  validatePuzzleSolution,
  validatePuzzleSpec,
} from "../src/lib/solitaire-duel/puzzleValidation.ts";
import { applyMove } from "../src/lib/solitaire-duel/rules.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { getUnlimitedPuzzle } from "../src/lib/solitaire-duel/puzzle.ts";
import { specFromBestMovePuzzle } from "../src/lib/solitaire-duel/puzzleValidation.ts";
import { buildPuzzleManifest } from "../src/lib/solitaire-puzzle/manifest.ts";

const LIBRARY = buildPuzzleLibrary();

function readPath(source, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), source);
}

// ── Data and encoding ─────────────────────────────────────────────────────

test("every library start position round-trips through the encoding", () => {
  assert.ok(PUZZLE_LIBRARY_DATA.length >= 8, "the library must not be empty");

  for (const entry of PUZZLE_LIBRARY_DATA) {
    const state = decodePuzzleStart(entry.start);
    assert.equal(state.tableau.length, 7);
    assert.equal(encodePuzzleStart(state), entry.start, `${entry.id} must re-encode identically`);

    const cards = [
      ...state.tableau.flatMap((column) => column.map((pile) => pile.card)),
      ...state.stock,
      ...state.waste,
      ...Object.values(state.foundations).flat(),
    ];
    const keys = new Set(cards.map((card) => `${card.suit}-${card.rank}`));
    assert.equal(keys.size, 52, `${entry.id} must hold 52 unique cards`);
  }
});

test("the library has no duplicate ids or duplicate boards", () => {
  const ids = new Set();
  const boards = new Set();
  for (const entry of PUZZLE_LIBRARY_DATA) {
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    assert.equal(boards.has(entry.start), false, `duplicate board in ${entry.id}`);
    ids.add(entry.id);
    boards.add(entry.start);
  }
});

// ── Validation ────────────────────────────────────────────────────────────

test("every puzzle validates through the Phase 2 engine with all solutions replayed", () => {
  assert.equal(LIBRARY.rejected.length, 0, JSON.stringify(LIBRARY.rejected));
  assert.equal(LIBRARY.puzzles.length, PUZZLE_LIBRARY_DATA.length);

  for (const puzzle of LIBRARY.puzzles) {
    assert.equal(puzzle.spec.version, PUZZLE_SPEC_VERSION);
    assert.equal(puzzle.spec.id, puzzle.id);
    const result = validatePuzzle(puzzle.spec);
    assert.equal(result.ok, true, `${puzzle.id}: ${JSON.stringify(result.issues)}`);
    assert.ok(puzzle.spec.solutions.length >= 1);

    for (const path of puzzle.spec.solutions) {
      const one = validatePuzzleSolution(puzzle.spec, path);
      assert.equal(one.ok, true, `${puzzle.id} alternative failed: ${JSON.stringify(one.issues)}`);
    }
    assert.equal(puzzle.solutionCount, puzzle.spec.solutions.length);
  }
});

test("no puzzle is a one-move task dressed up as a plan", () => {
  for (const puzzle of LIBRARY.puzzles) {
    const primary = puzzle.spec.solutions[0];
    assert.ok(primary.length >= 2, `${puzzle.id} must need at least two moves`);
    assert.equal(
      objectiveReached(puzzle.spec.objective, puzzle.spec.startState),
      false,
      `${puzzle.id} must not be solved before it starts`,
    );

    for (const move of legalMoves(puzzle.spec.startState)) {
      const applied = applyMove({ state: puzzle.spec.startState, move });
      if (!applied.ok) continue;
      assert.equal(
        objectiveReached(puzzle.spec.objective, applied.state, {
          revealed: applied.revealed.length,
          signatures: [puzzleMoveSignature(move)],
        }),
        false,
        `${puzzle.id} can be solved by the single move ${puzzleMoveSignature(move)}`,
      );
    }
  }
});

test("every puzzle derives its difficulty from measured strategic load", () => {
  for (const puzzle of LIBRARY.puzzles) {
    const load = assessStrategicLoad(puzzle.spec, puzzle.category);
    assert.deepEqual(puzzle.load, load, `${puzzle.id} load must be recomputable`);
    assert.equal(puzzle.spec.difficulty, load.band);
    assert.equal(puzzle.levelNumber, load.band);
    assert.equal(puzzle.level, levelForBand(load.band).id);
    assert.equal(puzzle.levelKey, levelForBand(load.band).key);
    assert.ok(load.distractors >= 1, `${puzzle.id} needs a real alternative`);
  }
});

test("difficulty reflects decisions rather than path length", () => {
  const longButSimple = LIBRARY.puzzles.filter(
    (puzzle) => puzzle.spec.solutions[0].length >= 4 && puzzle.levelNumber <= 4,
  );
  assert.ok(longButSimple.length > 0, "a four-move line must be able to stay below Master");

  const shortButTricky = LIBRARY.puzzles.filter(
    (puzzle) => puzzle.spec.solutions[0].length <= 3 && puzzle.levelNumber >= 3,
  );
  assert.ok(shortButTricky.length > 0, "a short line must be able to reach Advanced or higher");
});

// ── Categories and levels ─────────────────────────────────────────────────

test("all five strategic categories are covered", () => {
  for (const category of PUZZLE_LIBRARY_CATEGORIES) {
    assert.ok(
      LIBRARY.report.byCategory[category.id] > 0,
      `no puzzle covers ${category.id}`,
    );
  }
  for (const puzzle of LIBRARY.puzzles) {
    assert.ok(
      PUZZLE_LIBRARY_CATEGORIES.some((category) => category.id === puzzle.category),
      `${puzzle.id} has an unknown category`,
    );
  }
});

test("all five player-facing levels are covered", () => {
  for (const level of PUZZLE_LIBRARY_LEVELS) {
    assert.ok(LIBRARY.report.byLevel[level.id] > 0, `no puzzle is rated ${level.id}`);
  }
  assert.deepEqual(LIBRARY.report.gaps, []);
});

test("the high tiers have enough variety to carry repeated ranked matches", () => {
  assert.ok(LIBRARY.report.byLevel.advanced >= 8, "Advanced pool shrank");
  assert.ok(LIBRARY.report.byLevel.expert >= 7, "Expert pool shrank");
  assert.ok(LIBRARY.report.byLevel.master >= 11, "Master pool shrank");

  // Every competitive tier must expose all five strategic categories, not just
  // one dominant plan. This is what stops a high-tier pool from feeling like a
  // single re-skinned foundation race.
  for (const level of ["advanced", "expert", "master"]) {
    for (const category of PUZZLE_LIBRARY_CATEGORIES) {
      assert.ok(
        LIBRARY.puzzles.some(
          (puzzle) => puzzle.level === level && puzzle.category === category.id,
        ),
        `${level} has no ${category.id} puzzle`,
      );
    }
  }
});

test("the thin tiers are deep enough to repeat without reusing a puzzle", () => {
  assert.ok(LIBRARY.report.byLevel.beginner >= 6, "Beginner pool shrank");
  assert.ok(LIBRARY.report.byLevel.intermediate >= 7, "Intermediate pool shrank");
  assert.ok(LIBRARY.report.byCategory.sequence >= 8, "Sequence pool shrank");
});

test("a single deal contributes at most two library positions", () => {
  const perSeed = new Map();
  for (const entry of PUZZLE_LIBRARY_DATA) {
    perSeed.set(entry.seed, (perSeed.get(entry.seed) ?? 0) + 1);
  }
  for (const [seed, count] of perSeed) {
    assert.ok(count <= 2, `seed ${seed} contributes ${count} positions`);
  }
});

test("competitive selection is server-seeded, one per band and identical for both seats", () => {
  const first = buildPuzzleManifest("phase11-seed");
  const second = buildPuzzleManifest("phase11-seed");

  assert.deepEqual(
    first.map((entry) => [entry.slot, entry.id, entry.level]),
    second.map((entry) => [entry.slot, entry.id, entry.level]),
    "the same server seed must reconstruct the same set",
  );
  assert.deepEqual(first.map((entry) => entry.slot), [0, 1, 2, 3, 4]);
  assert.deepEqual(
    first.map((entry) => entry.level),
    ["beginner", "intermediate", "advanced", "expert", "master"],
  );
  assert.equal(new Set(first.map((entry) => entry.id)).size, 5, "no duplicate puzzle in a race");

  // No seed may ever yield a partial or duplicate band set.
  for (let index = 0; index < 60; index += 1) {
    const manifest = buildPuzzleManifest(`fairness-${index}`);
    assert.equal(manifest.length, 5);
    assert.deepEqual(
      manifest.map((entry) => entry.level),
      ["beginner", "intermediate", "advanced", "expert", "master"],
    );
    assert.equal(new Set(manifest.map((entry) => entry.id)).size, 5);
  }
});

test("the category vocabulary describes strategy, not card layout", () => {
  const ids = PUZZLE_LIBRARY_CATEGORIES.map((category) => category.id).sort();
  assert.deepEqual(ids, ["endgame", "foundation", "sequence", "stock", "tableau"]);
});

// ── Hints, concepts and explanations ──────────────────────────────────────

test("each puzzle carries up to three progressive hints that all resolve in EN/FR/ES", () => {
  for (const puzzle of LIBRARY.puzzles) {
    assert.ok(puzzle.hints.length >= 1 && puzzle.hints.length <= 3, `${puzzle.id} hint count`);
    assert.equal(puzzle.spec.hints.length, puzzle.hints.length);

    for (const locale of ["en", "fr", "es"]) {
      for (const hint of puzzle.hints) {
        const template = readPath(PUZZLE_LIBRARY_TRANSLATIONS[locale], hint.key.replace("puzzleLibrary.", ""));
        assert.equal(typeof template, "string", `${locale} is missing ${hint.key}`);
        assert.ok(template.length > 0);
        for (const param of Object.keys(hint.params ?? {})) {
          assert.ok(template.includes(`{${param}}`), `${hint.key} does not use {${param}}`);
        }
      }
    }
  }
});

test("every explanation, objective and library key resolves in all three locales", () => {
  const sharedKeys = [
    "puzzleLibrary.title",
    "puzzleLibrary.description",
    "puzzleLibrary.countLabel",
    "puzzleLibrary.objectives.reveal",
    "puzzleLibrary.objectives.openColumn",
    "puzzleLibrary.objectives.placeCard",
    "puzzleLibrary.objectives.foundationMilestone",
    "puzzleLibrary.objectives.preserve",
    "puzzleLibrary.objectives.reachState",
    "puzzleLibrary.objectives.bestMove",
    "puzzleLibrary.objectives.composite",
    "puzzleLibrary.objectives.destinationFoundation",
    "puzzleLibrary.objectives.destinationColumn",
    "puzzleLibrary.explanations.progress",
    "puzzleLibrary.explanations.stockPlan",
  ];
  for (const locale of ["en", "fr", "es"]) {
    for (const key of sharedKeys) {
      const value = readPath(PUZZLE_LIBRARY_TRANSLATIONS[locale], key.replace("puzzleLibrary.", ""));
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
    }
  }

  for (const puzzle of LIBRARY.puzzles) {
    const keys = [
      puzzle.levelKey,
      `puzzleLibrary.categories.${puzzle.category}.name`,
      `puzzleLibrary.categories.${puzzle.category}.description`,
      puzzle.explanation.whyKey,
      puzzle.explanation.noticeKey,
      puzzle.explanation.alternativeKey,
      puzzle.explanation.detailKey,
      ...(puzzle.explanation.delayedKey ? [puzzle.explanation.delayedKey] : []),
    ];
    for (const locale of ["en", "fr", "es"]) {
      for (const key of keys) {
        const value = readPath(PUZZLE_LIBRARY_TRANSLATIONS[locale], key.replace("puzzleLibrary.", ""));
        assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      }
    }
  }
});

test("no objective or hint names a hidden card", () => {
  for (const puzzle of LIBRARY.puzzles) {
    const check = validatePuzzleSpec(puzzle.spec);
    assert.equal(
      check.issues.filter((entry) => entry.code === "HIDDEN_INFO_LEAK").length,
      0,
      `${puzzle.id}: ${JSON.stringify(check.issues)}`,
    );
  }
});

// ── Public payload ────────────────────────────────────────────────────────

test("the public projection exposes no hidden card and no solution", () => {
  for (const puzzle of LIBRARY.puzzles) {
    const publicSpec = puzzlePublicSpec(puzzle.spec);
    const json = JSON.stringify(publicSpec);

    assert.equal(publicSpec.board.nextStockCard, null, `${puzzle.id} leaks the next stock card`);
    assert.equal(json.includes("acceptedMoves"), false);
    assert.equal(json.includes("solutions"), false);
    assert.equal(json.includes("startState"), false);

    for (const column of puzzle.spec.startState.tableau) {
      for (const pile of column) {
        if (pile.faceUp || !pile.card) continue;
        // The closing brace matters: without it `"rank":1` also matches
        // `"rank":11` and the check would report a phantom leak.
        assert.equal(
          json.includes(`"suit":"${pile.card.suit}","rank":${pile.card.rank}}`),
          false,
          `${puzzle.id} leaks a face-down identity`,
        );
      }
    }
  }
});

// ── Multiple solutions and bounds ─────────────────────────────────────────

test("alternative solutions are accepted only when they really reach the objective", () => {
  const withAlternatives = LIBRARY.puzzles.filter((puzzle) => puzzle.solutionCount > 1);
  assert.equal(withAlternatives.length, LIBRARY.report.multipleSolutions);

  for (const puzzle of withAlternatives) {
    const signatures = new Set(puzzle.spec.solutions.map((path) => path.map(puzzleMoveSignature).join(">")));
    assert.equal(signatures.size, puzzle.spec.solutions.length, `${puzzle.id} repeats a solution`);
    for (const path of puzzle.spec.solutions.slice(1)) {
      assert.ok(path.length >= 2, `${puzzle.id} accepted a one-move alternative`);
    }
  }
});

test("the alternative search is bounded and deterministic", () => {
  const puzzle = LIBRARY.puzzles[0];
  const capped = findAlternativeSolutions(puzzle.spec, { maxNodes: 1 });
  assert.equal(capped.capped, true);
  assert.equal(capped.paths.length, 0);

  const again = findAlternativeSolutions(puzzle.spec);
  const first = findAlternativeSolutions(puzzle.spec);
  assert.deepEqual(
    again.paths.map((path) => path.map(puzzleMoveSignature).join(">")),
    first.paths.map((path) => path.map(puzzleMoveSignature).join(">")),
  );
});

test("stock and endgame categories enforce their own character", () => {
  for (const puzzle of LIBRARY.puzzles.filter((entry) => entry.category === "stock")) {
    const primary = puzzle.spec.solutions[0];
    assert.ok(
      primary.some((move) => move.kind === "draw"),
      `${puzzle.id} must require a draw`,
    );
    const load = assessStrategicLoad(puzzle.spec, "stock");
    assert.ok(
      load.stockPasses + load.stockRecycles >= 1,
      `${puzzle.id} must require a stock recycle or a full pass`,
    );
  }

  for (const puzzle of LIBRARY.puzzles.filter((entry) => entry.category === "endgame")) {
    const cards = Object.values(puzzle.spec.startState.foundations).reduce(
      (total, pile) => total + pile.length,
      0,
    );
    assert.ok(cards >= 18, `${puzzle.id} is not an endgame (${cards} on foundations)`);
  }
});

// ── Report, determinism and compatibility ────────────────────────────────

test("the quality report matches the shipped puzzles", () => {
  const report = LIBRARY.report;
  assert.equal(report.total, LIBRARY.puzzles.length);
  assert.equal(report.rejected, 0);
  assert.deepEqual(report.rejectedIds, []);
  assert.equal(report.multiDecision, LIBRARY.puzzles.length, "every puzzle needs two or more moves");
  assert.equal(
    report.withThreeHints,
    LIBRARY.puzzles.filter((puzzle) => puzzle.hints.length === 3).length,
  );
  assert.equal(report.legacy.removed, 0);
  assert.equal(LIBRARY.puzzles.length, new Set(LIBRARY.puzzles.map((puzzle) => puzzle.id)).size);
});

test("the library builds deterministically", () => {
  const again = buildPuzzleLibrary();
  assert.deepEqual(
    again.puzzles.map((puzzle) => [puzzle.id, puzzle.level, puzzle.solutionCount]),
    LIBRARY.puzzles.map((puzzle) => [puzzle.id, puzzle.level, puzzle.solutionCount]),
  );
  assert.deepEqual(again.report, LIBRARY.report);
});

test("existing puzzle ids and progress records are left alone", () => {
  const legacy = getUnlimitedPuzzle(34);
  const spec = specFromBestMovePuzzle(legacy);
  assert.equal(spec.id, legacy.key);
  assert.equal(validatePuzzle(spec).ok, true);

  for (const puzzle of LIBRARY.puzzles) {
    assert.match(puzzle.id, /^library:v1:/);
  }
});

test("difficulty banding is monotone", () => {
  let previous = 1;
  for (const score of [0, 30, 31, 48, 49, 64, 65, 80, 81, 100]) {
    const band = difficultyBandForScore(score);
    assert.ok(band >= previous);
    previous = band;
  }
  assert.equal(difficultyBandForScore(0), 1);
  assert.equal(difficultyBandForScore(100), 5);
});
