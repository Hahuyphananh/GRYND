/**
 * solitaire-puzzle-lives.test.mjs
 *
 * THE PUZZLE BATTLE RULES.
 *
 *   * every seat starts with three lives;
 *   * a legal move that does not advance the objective costs a life;
 *   * a blown 60-second puzzle clock costs a life and starts the next puzzle;
 *   * losing the third life ends the match for the other seat;
 *   * solving a puzzle keeps the lives and resets the clock;
 *   * an endless battle grows its frozen stream instead of ending at five.
 *
 * Run: node --import tsx --test tests/solitaire-puzzle-lives.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { puzzleLibraryPuzzles } from "../src/lib/solitaire-duel/puzzleLibrary.ts";
import {
  buildPuzzleManifest,
  extendPuzzleManifest,
  manifestFromIds,
} from "../src/lib/solitaire-puzzle/manifest.ts";
import {
  PUZZLE_SESSION_LIVES,
  PUZZLE_SESSION_PUZZLE_MS,
} from "../src/lib/solitaire-puzzle/constants.ts";
import {
  applySeatMove,
  applySeatPuzzleTimeout,
  createSeatSnapshot,
  resolvePuzzleOutcome,
} from "../src/lib/solitaire-puzzle/state.ts";

const NOW = 1_700_000_000_000;

function entryFor(puzzle) {
  return manifestFromIds([puzzle.id])[0];
}

/** A real legal move that does not advance the objective, from the library. */
function findBadMove() {
  for (const puzzle of puzzleLibraryPuzzles()) {
    const entry = entryFor(puzzle);
    const seat = createSeatSnapshot(entry, {
      deadlineAtMs: NOW + PUZZLE_SESSION_PUZZLE_MS,
    });
    for (const move of legalMoves(seat.state)) {
      const result = applySeatMove({
        manifest: [entry],
        seat,
        move,
        nowMs: NOW,
      });
      if (result.status === "no-progress") return { entry, seat, move };
    }
  }
  return null;
}

test("a seat starts with three lives and no clock until the match starts", () => {
  const entry = entryFor(puzzleLibraryPuzzles()[0]);
  const seat = createSeatSnapshot(entry);
  assert.equal(seat.lives, PUZZLE_SESSION_LIVES);
  assert.equal(seat.puzzleDeadlineAtMs, null);
});

test("a legal move that misses the objective costs a life", () => {
  const bad = findBadMove();
  assert.ok(bad, "the library must offer at least one off-objective legal move");

  const result = applySeatMove({
    manifest: [bad.entry],
    seat: bad.seat,
    move: bad.move,
    nowMs: NOW,
  });
  assert.equal(result.status, "no-progress");
  assert.equal(result.lifeLost, true);
  assert.equal(result.seat.lives, PUZZLE_SESSION_LIVES - 1);
  assert.equal(result.seat.ply, bad.seat.ply + 1);
});

test("the third lost life ends the match for the opponent", () => {
  const bad = findBadMove();
  assert.ok(bad);

  const oneLife = createSeatSnapshot(bad.entry, {
    lives: 1,
    deadlineAtMs: NOW + PUZZLE_SESSION_PUZZLE_MS,
  });
  const result = applySeatMove({
    manifest: [bad.entry],
    seat: oneLife,
    move: bad.move,
    nowMs: NOW,
  });
  assert.equal(result.seat.lives, 0);

  const snapshot = {
    status: "playing",
    player1Id: "alice",
    player2Id: "bob",
    puzzleCount: 1,
    deadlineAtMs: null,
    p1: result.seat,
    p2: createSeatSnapshot(bad.entry, { lives: 3 }),
  };
  const outcome = resolvePuzzleOutcome(snapshot, NOW);
  assert.equal(outcome.result, "player2");
  assert.equal(outcome.winnerId, "bob");
  assert.equal(outcome.reason, "lives");
});

test("a blown 60-second clock costs a life and starts the next puzzle fresh", () => {
  const puzzles = puzzleLibraryPuzzles();
  const manifest = manifestFromIds([puzzles[0].id, puzzles[1].id]);
  const seat = createSeatSnapshot(manifest[0], {
    deadlineAtMs: NOW + PUZZLE_SESSION_PUZZLE_MS,
  });

  const expired = applySeatPuzzleTimeout({
    manifest,
    seat,
    nowMs: NOW + PUZZLE_SESSION_PUZZLE_MS + 1,
  });
  assert.equal(expired.expired, true);
  assert.equal(expired.seat.lives, PUZZLE_SESSION_LIVES - 1);
  assert.equal(expired.seat.puzzleIndex, 1);
  assert.equal(expired.advancedPuzzle, true);
  assert.equal(
    expired.seat.puzzleDeadlineAtMs,
    NOW + PUZZLE_SESSION_PUZZLE_MS + 1 + PUZZLE_SESSION_PUZZLE_MS,
  );
  assert.equal(expired.seat.solved, 0);
});

test("a clock that is still running is not expired", () => {
  const entry = entryFor(puzzleLibraryPuzzles()[0]);
  const seat = createSeatSnapshot(entry, {
    deadlineAtMs: NOW + PUZZLE_SESSION_PUZZLE_MS,
  });
  const still = applySeatPuzzleTimeout({
    manifest: [entry],
    seat,
    nowMs: NOW + 1_000,
  });
  assert.equal(still.expired, false);
  assert.equal(still.seat, seat);
});

test("the third timeout ends the match", () => {
  const entry = entryFor(puzzleLibraryPuzzles()[0]);
  const seat = createSeatSnapshot(entry, {
    lives: 1,
    deadlineAtMs: NOW - 1,
  });
  const expired = applySeatPuzzleTimeout({
    manifest: [entry],
    seat,
    nowMs: NOW,
  });
  assert.equal(expired.expired, true);
  assert.equal(expired.seat.lives, 0);
  assert.equal(expired.seat.finishedAtMs, NOW);
  assert.equal(expired.seat.puzzleDeadlineAtMs, null);
});

test("solving keeps the lives and restarts the 60-second clock", () => {
  const puzzles = puzzleLibraryPuzzles();
  const puzzle = puzzles.find((candidate) => candidate.spec.solutions[0]?.length > 0);
  assert.ok(puzzle);
  const manifest = manifestFromIds([
    puzzle.id,
    puzzles.find((candidate) => candidate.id !== puzzle.id).id,
  ]);
  let seat = createSeatSnapshot(manifest[0], {
    lives: 2,
    deadlineAtMs: NOW + 30_000,
  });

  let at = NOW;
  for (const move of puzzle.spec.solutions[0]) {
    const result = applySeatMove({ manifest, seat, move, nowMs: at });
    assert.notEqual(result.status, "illegal");
    seat = result.seat;
    at += 5_000;
  }

  assert.equal(seat.solved, 1);
  assert.equal(seat.lives, 2);
  assert.equal(seat.puzzleIndex, 1);
  assert.equal(seat.puzzleDeadlineAtMs, at - 5_000 + PUZZLE_SESSION_PUZZLE_MS);
});

test("an endless battle grows its frozen stream with absolute slots", () => {
  const seed = "lives-endless-seed";
  const base = buildPuzzleManifest(seed);
  assert.equal(base.length, 5);

  const grown = extendPuzzleManifest(base, seed, 11);
  assert.ok(grown.length >= 11, "the stream must cover the requested index");
  grown.forEach((entry, index) => {
    assert.equal(entry.slot, index, "slots are absolute stream positions");
    assert.ok(entry.spec.startState, "every appended entry carries a start state");
  });

  // Deterministic: the same seed and length reconstruct the same stream.
  assert.deepEqual(
    grown.map((entry) => entry.id),
    extendPuzzleManifest(base, seed, 11).map((entry) => entry.id),
  );
});
