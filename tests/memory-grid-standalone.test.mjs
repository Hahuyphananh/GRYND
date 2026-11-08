// tests/memory-grid-standalone.test.mjs
//
// Focused proofs for the standalone (no-server) Memory Grid controller:
//
//   * the round ladder is the shared engine's, imported and unchanged
//   * a round's pattern comes from the engine's own seeded generator, and the
//     same match seed always deals the same grids
//   * the phase state machine mirrors the server: ready → memorize →
//     reconstruct → result → next round, with every window anchored to an
//     ABSOLUTE deadline (so a late tick can neither extend the memorize preview
//     nor shorten anyone's reconstruction)
//   * the pattern is never visible during reconstruction, and the bot's picks
//     never leak before the round resolves
//   * a round score IS `computeFinalRoundScore(assessReconstruction(...))` —
//     including the empty-reconstruction guard and the false-positive penalty
//   * the round award, the cumulative totals, the tiebreak round and the two
//     draw paths all match the server's rules
//   * the bot is deterministic, in-range, tier-ordered and paced by its own
//     submission delay
//   * nothing in the controller's import graph reaches the database, auth, API
//     routes, sockets, server seeds or a remote origin
//
// Run: npm run test:memory-grid-standalone

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as appModule from "../standalone/memory-grid/src/App.tsx";
import * as boardModule from "../standalone/memory-grid/src/Board.tsx";
import * as resultScreenModule from "../standalone/memory-grid/src/ResultScreen.tsx";
import * as roundResultModule from "../standalone/memory-grid/src/RoundResult.tsx";
import { PORTAL_CONFIG } from "../standalone/memory-grid/src/portal-config.ts";
import { PORTAL_RUNTIME } from "../standalone/memory-grid/src/portal-sdk.ts";

import {
  createLocalMatch,
  deriveRoundSeed,
  isOver,
  phaseDurationMs,
  reconstructStartMs,
  submitReconstruction,
  tick,
  viewForMatch,
} from "../standalone/memory-grid/src/match.ts";
import { randomSeed } from "../standalone/memory-grid/src/seed.ts";
import {
  MATCH_STATUS,
  PHASES,
  READY_WINDOW_MS,
  RECONSTRUCT_DEADLINE_MS,
  RESULT_WINDOW_MS,
  ROUNDS_PER_MATCH,
  TIEBREAK_CONFIG,
  TIEBREAK_ROUND_NUMBER,
  aiSubmissionDelayMs,
  assessReconstruction,
  chooseAiReconstruction,
  computeFinalRoundScore,
  generatePattern,
  roundConfig,
  speedMultiplierFromCompletion,
} from "../src/lib/memory-grid/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, "..");
const STANDALONE = join(REPO, "standalone", "memory-grid");
const SEED = 20261107;

/** A match with no countdown, so every assertion can act immediately. */
function matchAt(nowMs = 0, { difficulty = "normal", seed = SEED, readyMs = 0 } = {}) {
  return createLocalMatch({ difficulty, seed, nowMs, readyMs });
}

/** A match sitting in its reconstruct phase (memorize already elapsed). */
function startReconstruct(nowMs = 0, opts = {}) {
  const memorized = tick(matchAt(nowMs, opts), nowMs);
  return tick(memorized, memorized.phaseDeadlineMs);
}

/**
 * Play a whole match, the player submitting a chosen pick set (the answer key by
 * default) and the bot playing its own reconstruction. Returns the finished match.
 */
function playThrough({
  difficulty = "normal",
  seed = SEED,
  picksFor = (match) => match.pattern.active,
} = {}) {
  let match = createLocalMatch({ difficulty, seed, nowMs: 0, readyMs: 0 });
  let guard = 0;

  while (!match.result && guard < 200) {
    guard += 1;

    if (match.phase === PHASES.RESULT) {
      match = tick(match, (match.phaseDeadlineMs ?? 0) + 1);
      continue;
    }
    if (match.status === MATCH_STATUS.READY || match.phase === PHASES.MEMORIZE) {
      match = tick(match, (match.phaseDeadlineMs ?? 0) + 1);
      continue;
    }
    if (match.phase === PHASES.RECONSTRUCT) {
      if (!match.p1Submitted) {
        const startMs = reconstructStartMs(match) ?? 0;
        match = submitReconstruction(match, picksFor(match), startMs + 700).match;
        continue;
      }
      match = tick(match, match.aiPlan?.dueAtMs ?? (match.phaseDeadlineMs ?? 0) + 1);
      continue;
    }
    break;
  }

  return match;
}

/** A match frozen in a round-result phase, for the end-state rules. */
function atResultPhase(overrides = {}) {
  return {
    ...playThrough(),
    status: MATCH_STATUS.ACTIVE,
    phase: PHASES.RESULT,
    roundNumber: ROUNDS_PER_MATCH,
    result: null,
    endedAtMs: null,
    p1Total: 250,
    p2Total: 250,
    phaseDeadlineMs: 10_000,
    ...overrides,
  };
}

// ── 1. The round ladder is the shared engine's ────────────────────────────

test("the five rounds and the tiebreak round are the shared spec", () => {
  assert.equal(ROUNDS_PER_MATCH, 5);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => {
      const cfg = roundConfig(n);
      return [cfg.gridSize, cfg.activeCount, cfg.memorizeMs];
    }),
    [
      [3, 3, 2500],
      [4, 5, 3000],
      [4, 7, 3000],
      [5, 10, 3500],
      [5, 14, 4000],
    ],
  );

  assert.equal(TIEBREAK_ROUND_NUMBER, 6);
  assert.deepEqual(
    [TIEBREAK_CONFIG.gridSize, TIEBREAK_CONFIG.activeCount, TIEBREAK_CONFIG.memorizeMs],
    [6, 18, 4000],
  );
  // Round 6 and anything beyond it is the tiebreak configuration.
  assert.deepEqual(roundConfig(6), TIEBREAK_CONFIG);
  assert.deepEqual(roundConfig(99), TIEBREAK_CONFIG);

  assert.equal(RECONSTRUCT_DEADLINE_MS, 15_000);
  assert.equal(RESULT_WINDOW_MS, 5_000);
  assert.equal(READY_WINDOW_MS, 3_000);
});

test("every round's pattern comes from the engine's generator and fits its grid", () => {
  for (const round of [1, 2, 3, 4, 5, 6]) {
    const cfg = roundConfig(round);
    const pattern = generatePattern(round, { seed: deriveRoundSeed(SEED, round) });

    assert.equal(pattern.size, cfg.gridSize);
    assert.equal(pattern.total, cfg.gridSize * cfg.gridSize);
    assert.equal(pattern.active.length, cfg.activeCount);
    assert.equal(new Set(pattern.active).size, cfg.activeCount, "tiles are distinct");
    for (const index of pattern.active) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < pattern.total);
    }
    // The generator returns the lit tiles in ascending order.
    assert.deepEqual([...pattern.active].sort((a, b) => a - b), pattern.active);
  }
});

test("a match seed deals the same grid every time, and the controller uses it", () => {
  const first = matchAt(0, { seed: 4242 });
  const second = matchAt(0, { seed: 4242 });

  assert.deepEqual(first.pattern, second.pattern);
  assert.deepEqual(
    first.pattern,
    generatePattern(1, { seed: deriveRoundSeed(4242, 1) }),
    "round 1 is generated from the derived round seed",
  );
  // Different match seeds derive different round seeds. (Two seeds may still
  // deal the same 3x3 pattern — only 84 exist — so vary a handful of seeds and
  // require the grids to differ somewhere.)
  assert.notEqual(deriveRoundSeed(4242, 1), deriveRoundSeed(4243, 1));
  const variants = new Set(
    [4242, 4243, 4244, 4245, 4246, 4247].map((seed) =>
      matchAt(0, { seed }).pattern.active.join(","),
    ),
  );
  assert.ok(variants.size > 1, "different match seeds must deal different grids");
});

// ── 2. The phase state machine ────────────────────────────────────────────

test("ready waits for its countdown, then opens round 1's memorize window", () => {
  const match = matchAt(1000, { readyMs: READY_WINDOW_MS });
  assert.equal(match.status, MATCH_STATUS.READY);
  assert.equal(match.phase, null);
  assert.equal(match.phaseDeadlineMs, 1000 + READY_WINDOW_MS);

  assert.equal(tick(match, 3999).status, MATCH_STATUS.READY);

  const started = tick(match, 4000);
  assert.equal(started.status, MATCH_STATUS.ACTIVE);
  assert.equal(started.phase, PHASES.MEMORIZE);
  assert.equal(started.roundNumber, 1);
  assert.equal(started.phaseDeadlineMs, 4000 + roundConfig(1).memorizeMs);
  assert.equal(viewForMatch(started, 4000).patternVisible, true);
});

test("reconstruct opens at the memorize deadline, even when the tick is late", () => {
  const memorized = tick(matchAt(0), 0);
  const memorizeDeadline = memorized.phaseDeadlineMs;

  // A tick still inside the window changes nothing.
  const early = tick(memorized, memorizeDeadline - 1);
  assert.equal(early.phase, PHASES.MEMORIZE);

  // A tick 400 ms late still anchors the window on the pattern-hide instant.
  const reconstruct = tick(memorized, memorizeDeadline + 400);
  assert.equal(reconstruct.phase, PHASES.RECONSTRUCT);
  assert.equal(reconstructStartMs(reconstruct), memorizeDeadline);
  assert.equal(reconstruct.phaseDeadlineMs, memorizeDeadline + RECONSTRUCT_DEADLINE_MS);
});

test("a late catch-up tick resolves the phases it slept through, in order", () => {
  const memorized = tick(matchAt(0), 0);
  // Sleep through the whole reconstruct window: the bot plays, the player is
  // AFK-locked, the round resolves, and the next round's memorize has NOT yet
  // begun (its result window is still open at this instant).
  const caughtUp = tick(memorized, memorized.phaseDeadlineMs + 1000);
  assert.equal(caughtUp.phase, PHASES.RECONSTRUCT);
  assert.equal(caughtUp.p2Submitted, false, "the bot's due time is still ahead");

  const resolved = tick(memorized, caughtUp.phaseDeadlineMs + 1);
  assert.equal(resolved.phase, PHASES.RESULT);
  assert.equal(resolved.rounds.length, 1);
  assert.equal(resolved.roundNumber, 1);
});

test("the pattern is hidden at the deadline even before the next tick lands", () => {
  const memorized = tick(matchAt(0), 0);

  const inside = viewForMatch(memorized, 0);
  assert.equal(inside.patternVisible, true);
  assert.deepEqual(inside.pattern.active, memorized.pattern.active);

  const atDeadline = viewForMatch(memorized, memorized.phaseDeadlineMs);
  assert.equal(atDeadline.patternVisible, false);
  assert.equal(atDeadline.pattern, null);
  assert.equal(atDeadline.phase, PHASES.MEMORIZE, "the phase itself has not moved yet");

  const reconstructing = viewForMatch(tick(memorized, memorized.phaseDeadlineMs), 0);
  assert.equal(reconstructing.patternVisible, false);
  assert.equal(reconstructing.pattern, null);
});

test("phase durations are the shared windows for every phase", () => {
  const memorized = tick(matchAt(0), 0);
  assert.equal(phaseDurationMs(memorized), roundConfig(1).memorizeMs);

  const reconstructing = tick(memorized, memorized.phaseDeadlineMs);
  assert.equal(phaseDurationMs(reconstructing), RECONSTRUCT_DEADLINE_MS);
  const view = viewForMatch(reconstructing, reconstructing.phaseDeadlineMs);
  assert.equal(view.phaseStartedAtMs, reconstructing.phaseDeadlineMs - RECONSTRUCT_DEADLINE_MS);

  const both = submitReconstruction(
    reconstructing,
    reconstructing.pattern.active,
    reconstructStartMs(reconstructing) + 500,
  ).match;
  const resolved = tick(both, (both.aiPlan?.dueAtMs ?? 0) + 1);
  assert.equal(resolved.phase, PHASES.RESULT);
  assert.equal(phaseDurationMs(resolved), RESULT_WINDOW_MS);
});

// ── 3. Submission gates and validation ────────────────────────────────────

test("a submission is refused before reconstruction starts, and accepted after", () => {
  const ready = matchAt(0);
  const beforeReady = submitReconstruction(ready, [0], 0);
  assert.equal(beforeReady.error, "Match is not awaiting a reconstruction");

  const memorized = tick(ready, 0);
  const duringMemorize = submitReconstruction(memorized, [0], 0);
  assert.equal(duringMemorize.error, "Reconstruction hasn't started yet");

  // Just past the memorize deadline: accepted, with the phase advanced on the
  // authoritative pattern-hide instant (so the completion time starts there).
  const justAfter = submitReconstruction(memorized, [0], memorized.phaseDeadlineMs + 5);
  assert.equal(justAfter.error, null);
  assert.equal(justAfter.match.phase, PHASES.RECONSTRUCT);
  assert.equal(justAfter.feedback.completionTimeMs, 5);
  assert.equal(reconstructStartMs(justAfter.match), memorized.phaseDeadlineMs);
});

test("a seat submits once per round", () => {
  const reconstructing = startReconstruct();
  const first = submitReconstruction(
    reconstructing,
    reconstructing.pattern.active,
    reconstructStartMs(reconstructing) + 100,
  );
  assert.equal(first.error, null);

  const second = submitReconstruction(
    first.match,
    reconstructing.pattern.active,
    reconstructStartMs(reconstructing) + 200,
  );
  assert.equal(second.error, "You already submitted this round");
  assert.equal(second.match, first.match, "a refused submission changes nothing");
});

test("a submission after the match is over is refused", () => {
  const finished = playThrough();
  assert.equal(finished.result, "player1");
  const late = submitReconstruction(finished, [], 10_000_000);
  assert.equal(late.error, "The match is already over");
  assert.equal(late.match, finished);
});

test("invalid picks are refused with the store's own rules", () => {
  const reconstructing = startReconstruct();
  const at = reconstructStartMs(reconstructing) + 100;

  assert.match(submitReconstruction(reconstructing, "0", at).error, /array of tile indices/);
  assert.match(submitReconstruction(reconstructing, [1, 1], at).error, /distinct/);
  assert.match(submitReconstruction(reconstructing, [-1], at).error, /distinct/);
  assert.match(submitReconstruction(reconstructing, [1.5], at).error, /distinct/);
  assert.match(
    submitReconstruction(reconstructing, [reconstructing.pattern.total], at).error,
    /out of range/,
  );

  const tooMany = Array.from(
    { length: reconstructing.pattern.total + 1 },
    (_, index) => index,
  );
  assert.match(submitReconstruction(reconstructing, tooMany, at).error, /at most/);

  // Any number of tiles up to the whole grid is legal — over-selection is
  // penalised by the scoring, not rejected.
  const wholeGrid = Array.from({ length: reconstructing.pattern.total }, (_, index) => index);
  assert.equal(submitReconstruction(reconstructing, wholeGrid, at).error, null);
});

// ── 4. Scoring is the shared engine's ─────────────────────────────────────

test("a round score is exactly the shared scorer's answer", () => {
  const reconstructing = startReconstruct();
  const startMs = reconstructStartMs(reconstructing);
  const picks = reconstructing.pattern.active.slice(0, 2);

  const outcome = submitReconstruction(reconstructing, picks, startMs + 5000);
  assert.equal(outcome.error, null);

  const assessment = assessReconstruction(picks, reconstructing.pattern);
  assert.equal(
    outcome.feedback.score,
    computeFinalRoundScore({ accuracy: assessment.accuracy, pickedCount: picks.length }),
  );
  assert.equal(outcome.feedback.total, assessment.total);
  assert.equal(outcome.feedback.correct, assessment.correct);
  assert.equal(outcome.feedback.incorrect, assessment.incorrect);
  assert.equal(outcome.feedback.accuracy, assessment.accuracy);
  assert.equal(outcome.feedback.accuracyPct, assessment.accuracyPct);
  assert.equal(outcome.feedback.completionTimeMs, 5000);
  assert.equal(
    outcome.feedback.speedTier,
    speedMultiplierFromCompletion(5000, RECONSTRUCT_DEADLINE_MS).tier,
  );
  assert.deepEqual(outcome.feedback.active, reconstructing.pattern.active);
});

test("a perfect reconstruction scores 100, and an empty one scores 0", () => {
  const reconstructing = startReconstruct();
  const startMs = reconstructStartMs(reconstructing);

  const perfect = submitReconstruction(
    reconstructing,
    reconstructing.pattern.active,
    startMs + 100,
  );
  assert.equal(perfect.feedback.score, 100);

  const emptyMatch = startReconstruct();
  const empty = submitReconstruction(emptyMatch, [], reconstructStartMs(emptyMatch) + 100);
  assert.equal(empty.error, null);
  // True-negative accuracy is high, but doing nothing earns nothing.
  assert.ok(assessReconstruction([], emptyMatch.pattern).accuracy > 0);
  assert.equal(empty.feedback.score, 0);
});

test("selecting the whole grid can never score high (false positives cost)", () => {
  const reconstructing = startReconstruct();
  const wholeGrid = Array.from(
    { length: reconstructing.pattern.total },
    (_, index) => index,
  );
  const outcome = submitReconstruction(
    reconstructing,
    wholeGrid,
    reconstructStartMs(reconstructing) + 100,
  );

  assert.ok(outcome.feedback.score < 50, `whole-grid score was ${outcome.feedback.score}`);
  assert.ok(outcome.feedback.incorrect > 0);
});

// ── 5. Round award, totals, tiebreak and the two draw paths ───────────────

test("a full match awards rounds, accumulates totals and finishes on them", () => {
  const finished = playThrough();

  assert.equal(finished.status, MATCH_STATUS.FINISHED);
  assert.equal(finished.phase, null);
  assert.equal(finished.result, "player1");
  assert.equal(finished.rounds.length, 5);
  assert.equal(finished.endedAtMs !== null, true);
  assert.equal(isOver(finished), true);

  // The player submitted the answer key every round, so every round is 100.
  assert.equal(finished.p1Total, 500);
  // The opening round is the one the normal bot also recalls perfectly: a tie
  // awards nobody, which is why the player wins four of the five rounds.
  assert.equal(finished.rounds[0].roundWinner, "draw");
  assert.deepEqual(
    finished.rounds.map((round) => round.roundWinner),
    ["draw", "player1", "player1", "player1", "player1"],
  );
  assert.equal(finished.p1Score, 4);
  assert.equal(finished.p2Score, 0);
  // A tied round still adds both round scores to the totals.
  assert.equal(finished.rounds[0].p1RoundScore, 100);
  assert.equal(finished.rounds[0].p2RoundScore, 100);
});

test("equal totals after round 5 deal the harder tiebreak round", () => {
  const tiedResult = atResultPhase();
  const tiebreak = tick(tiedResult, 10_001);

  assert.equal(tiebreak.status, MATCH_STATUS.ACTIVE);
  assert.equal(tiebreak.phase, PHASES.MEMORIZE);
  assert.equal(tiebreak.roundNumber, TIEBREAK_ROUND_NUMBER);
  assert.equal(tiebreak.result, null);
  assert.equal(tiebreak.pattern.size, 6);
  assert.equal(tiebreak.pattern.total, 36);
  assert.equal(tiebreak.pattern.active.length, TIEBREAK_CONFIG.activeCount);
  assert.equal(tiebreak.rounds.length, 5, "the regular rounds stay in history");
  assert.equal(tiebreak.p1Total, 250, "the tiebreak does not reset the totals");

  const view = viewForMatch(tiebreak, 10_001);
  assert.equal(view.isTiebreak, true);
  assert.equal(view.gridSize, 6);
  assert.equal(view.activeCount, 18);
});

test("unequal totals after round 5 finish the match on the totals", () => {
  const decided = tick(atResultPhase({ p1Total: 260, p2Total: 250 }), 10_001);
  assert.equal(decided.status, MATCH_STATUS.FINISHED);
  assert.equal(decided.result, "player1");
  assert.equal(decided.endedAtMs, 10_001);
  assert.equal(viewForMatch(decided, 10_001).viewerOutcome, "win");
});

test("a tied tiebreak round finishes as a draw — round 6 is never re-dealt", () => {
  const drawn = tick(
    atResultPhase({ roundNumber: TIEBREAK_ROUND_NUMBER, p1Total: 300, p2Total: 300 }),
    10_001,
  );

  assert.equal(drawn.status, MATCH_STATUS.FINISHED);
  assert.equal(drawn.roundNumber, TIEBREAK_ROUND_NUMBER);
  assert.equal(drawn.result, "draw");
  assert.equal(viewForMatch(drawn, 10_001).viewerOutcome, "draw");
});

test("a decided tiebreak round resolves on its own totals", () => {
  const botWins = tick(
    atResultPhase({ roundNumber: TIEBREAK_ROUND_NUMBER, p1Total: 300, p2Total: 310 }),
    10_001,
  );
  assert.equal(botWins.result, "player2");
  assert.equal(viewForMatch(botWins, 10_001).viewerOutcome, "loss");
});

test("an AFK seat is locked empty at the deadline with score 0", () => {
  const reconstructing = startReconstruct();
  const resolved = tick(reconstructing, reconstructing.phaseDeadlineMs);

  assert.equal(resolved.phase, PHASES.RESULT);
  const playerFlip = resolved.rounds[0].flips.find((flip) => flip.seat === "player1");
  const botFlip = resolved.rounds[0].flips.find((flip) => flip.seat === "player2");

  assert.equal(playerFlip.autoLocked, true);
  assert.deepEqual(playerFlip.picks, []);
  assert.equal(playerFlip.score, 0);
  assert.equal(resolved.p1RoundScore, 0);

  assert.equal(botFlip.autoLocked, false, "the bot submits before the lock runs");
  assert.ok(botFlip.picks.length > 0);
  assert.equal(resolved.rounds[0].roundWinner, "player2");
});

// ── 6. The bot ───────────────────────────────────────────────────────────

test("the bot's picks are in range, distinct and deterministic", () => {
  const reconstructing = startReconstruct();
  const picks = reconstructing.aiPlan.picks;

  assert.ok(picks.length > 0);
  assert.equal(new Set(picks).size, picks.length);
  for (const index of picks) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < reconstructing.pattern.total);
  }

  const again = chooseAiReconstruction({
    pattern: reconstructing.pattern,
    roundNumber: reconstructing.roundNumber,
    seed: `${reconstructing.seed}:${reconstructing.roundNumber}`,
    difficulty: reconstructing.difficulty,
  });
  assert.deepEqual(again, picks);

  // A different seed varies the bot's misses without changing its skill. Round 1
  // is too sparse to show it (the bot recalls all three tiles at every seed), so
  // this uses a dense grid, where it has to miss some.
  const dense = generatePattern(5, { seed: deriveRoundSeed(SEED, 5) });
  const variants = new Set(
    ["999:1", "999:2", "1000:1", "1001:1", "4242:3", "777:5", "8:1", "9:9"].map((seed) =>
      chooseAiReconstruction({
        pattern: dense,
        roundNumber: 5,
        seed,
        difficulty: "normal",
      }).join(","),
    ),
  );
  assert.ok(variants.size > 1, "the bot's misses must depend on its seed");
});

test("easy ≤ normal ≤ hard, on every round", () => {
  for (const round of [1, 2, 3, 4, 5, 6]) {
    const pattern = generatePattern(round, { seed: deriveRoundSeed(SEED, round) });
    const accuracyOf = (difficulty) =>
      assessReconstruction(
        chooseAiReconstruction({
          pattern,
          roundNumber: round,
          seed: `${SEED}:${round}`,
          difficulty,
        }),
        pattern,
      ).accuracy;

    const easy = accuracyOf("easy");
    const normal = accuracyOf("normal");
    const hard = accuracyOf("hard");

    assert.ok(easy <= normal + 1e-9, `round ${round}: easy ${easy} > normal ${normal}`);
    assert.ok(normal <= hard + 1e-9, `round ${round}: normal ${normal} > hard ${hard}`);
    assert.ok(hard > 0.4, `round ${round}: hard must recall a real share of the grid`);
  }
});

test("the bot submits at its own calibrated time, inside the window", () => {
  const reconstructing = startReconstruct();
  const startMs = reconstructStartMs(reconstructing);
  const expectedDue =
    startMs + aiSubmissionDelayMs({ roundNumber: 1, matchId: reconstructing.seed });

  assert.equal(reconstructing.aiPlan.dueAtMs, expectedDue);
  assert.ok(reconstructing.aiPlan.dueAtMs > startMs);
  assert.ok(
    reconstructing.aiPlan.dueAtMs < reconstructing.phaseDeadlineMs,
    "the bot must never miss the reconstruct window",
  );

  const before = tick(reconstructing, reconstructing.aiPlan.dueAtMs - 1);
  assert.equal(before.p2Submitted, false);
  assert.equal(before.phase, PHASES.RECONSTRUCT);

  const due = tick(reconstructing, reconstructing.aiPlan.dueAtMs);
  assert.equal(due.p2Submitted, true);
  const flip = due.liveFlips.find((entry) => entry.seat === "player2");
  assert.equal(flip.completionTimeMs, reconstructing.aiPlan.dueAtMs - startMs);
});

test("later rounds make the bot slower to submit", () => {
  // Each round needs three transitions: reconstruct → result (AFK) → the next
  // round's memorize → reconstruct.
  const nextReconstruct = (match) => {
    const resolved = tick(match, (match.phaseDeadlineMs ?? 0) + 1);
    const memorized = tick(resolved, (resolved.phaseDeadlineMs ?? 0) + 1);
    return tick(memorized, (memorized.phaseDeadlineMs ?? 0) + 1);
  };

  const first = startReconstruct();
  let later = first;
  for (let round = 1; round < 5; round += 1) later = nextReconstruct(later);

  assert.equal(later.phase, PHASES.RECONSTRUCT);
  assert.equal(later.roundNumber, 5);
  assert.ok(
    later.aiPlan.dueAtMs - reconstructStartMs(later) >
      first.aiPlan.dueAtMs - reconstructStartMs(first),
    "round 5 takes longer than round 1",
  );
});

// ── 7. Nothing hidden reaches the view ───────────────────────────────────

test("the view leaks neither the pattern nor the bot's picks while reconstructing", () => {
  const reconstructing = startReconstruct();
  const view = viewForMatch(reconstructing, reconstructStartMs(reconstructing) + 200);

  assert.equal(view.phase, PHASES.RECONSTRUCT);
  assert.equal(view.pattern, null);
  assert.equal(view.patternVisible, false);
  assert.deepEqual(view.rounds, [], "no round snapshot before the round resolves");
  assert.equal(JSON.stringify(view).includes('"picks"'), false);
  assert.equal(JSON.stringify(view).includes('"aiPlan"'), false);
});

test("the reveal happens at the round result, for both seats", () => {
  const reconstructing = startReconstruct();
  const submitted = submitReconstruction(
    reconstructing,
    reconstructing.pattern.active,
    reconstructStartMs(reconstructing) + 600,
  ).match;
  const resolved = tick(submitted, (submitted.aiPlan?.dueAtMs ?? 0) + 1);

  const view = viewForMatch(resolved, resolved.phaseDeadlineMs - RESULT_WINDOW_MS + 10);
  assert.equal(view.patternVisible, true);
  assert.equal(view.rounds.length, 1);
  assert.deepEqual(view.rounds[0].boardSnapshot.active, reconstructing.pattern.active);
  assert.equal(view.rounds[0].flips.length, 2);
  assert.equal(view.p1RoundScore, 100);
  assert.ok(view.p2RoundScore > 0);
});

// ── 8. Purity and determinism ────────────────────────────────────────────

test("the controller never mutates the match it is handed", () => {
  const reconstructing = startReconstruct();
  const snapshot = structuredClone(reconstructing);

  tick(reconstructing, reconstructing.phaseDeadlineMs);

  assert.deepEqual(reconstructing, snapshot);
});

test("the same seed plays the same match twice", () => {
  const first = playThrough({ seed: 777 });
  const second = playThrough({ seed: 777 });

  assert.deepEqual(first, second);
  assert.notDeepEqual(first.pattern, playThrough({ seed: 778 }).pattern);
});

test("a finished match is inert", () => {
  const finished = playThrough();

  assert.deepEqual(tick(finished, 10_000_000), finished);
  assert.deepEqual(tick(finished, 10_000_001), finished);
});

test("every difficulty tier plays a complete match", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    const finished = playThrough({ difficulty, seed: 31_337 });
    assert.equal(finished.status, MATCH_STATUS.FINISHED);
    assert.equal(finished.difficulty, difficulty);
    assert.equal(finished.rounds.length >= 5, true);
    assert.ok(["player1", "player2", "draw"].includes(finished.result));
  }

  // The tier reaches the bot: harder opponents score higher on the same seed.
  const scores = ["easy", "normal", "hard"].map((difficulty) => {
    const finished = playThrough({ difficulty, seed: 31_337 });
    return finished.rounds.reduce((total, round) => total + round.p2RoundScore, 0);
  });
  assert.ok(scores[0] <= scores[1] + 1e-9);
  assert.ok(scores[1] <= scores[2] + 1e-9);
});

// ── 9. Bundled randomness ────────────────────────────────────────────────

test("the match seed is a fresh unsigned 32-bit value", () => {
  const seed = randomSeed();
  assert.ok(Number.isInteger(seed));
  assert.ok(seed >= 0 && seed <= 0xffffffff);
  assert.notEqual(randomSeed(), seed);
});

// ── 9. The board and the round review (markup) ───────────────────────────

const pick = (mod) => mod?.default?.default ?? mod?.default;
const Board = pick(boardModule);
const RoundResult = pick(roundResultModule);

/** A complete view for the round-review component (it reads only some fields). */
function resultView(overrides = {}) {
  return {
    status: "active",
    phase: "result",
    roundNumber: 2,
    roundsPerMatch: 5,
    isTiebreak: false,
    gridSize: 4,
    activeCount: 5,
    memorizeMs: 3000,
    phaseStartedAtMs: 0,
    phaseDeadlineMs: 5000,
    msLeft: 3200,
    patternVisible: true,
    pattern: { size: 4, total: 16, active: [0, 5] },
    p1Submitted: true,
    p2Submitted: true,
    playerSubmitted: true,
    botSubmitted: true,
    p1RoundScore: 100,
    p2RoundScore: 87.5,
    p1Total: 100,
    p2Total: 87.5,
    p1Score: 1,
    p2Score: 0,
    rounds: [],
    result: null,
    viewerOutcome: null,
    difficulty: "normal",
    startedAtMs: 0,
    endedAtMs: null,
    ...overrides,
  };
}

function roundSnapshot(overrides = {}) {
  return {
    roundNumber: 2,
    boardSnapshot: { size: 4, total: 16, active: [0, 5] },
    flips: [
      {
        seat: "player1",
        picks: [0, 5],
        score: 100,
        total: 16,
        correct: 16,
        incorrect: 0,
        accuracy: 1,
        accuracyPct: 100,
        completionTimeMs: 1234,
        speedTier: "fast",
        autoLocked: false,
      },
      {
        seat: "player2",
        picks: [0],
        score: 87.5,
        total: 16,
        correct: 14,
        incorrect: 1,
        accuracy: 0.875,
        accuracyPct: 87.5,
        completionTimeMs: 4200,
        speedTier: "average",
        autoLocked: false,
      },
    ],
    p1RoundScore: 100,
    p2RoundScore: 87.5,
    roundWinner: "player1",
    ...overrides,
  };
}

test("the board renders one tile per cell in the right state", () => {
  assert.equal(typeof Board, "function", "Board must be the tile-grid component");

  const html = renderToStaticMarkup(
    React.createElement(Board, {
      size: 3,
      active: [0, 4],
      picks: [2],
      interactive: true,
      onToggle: () => {},
      label: "Memory Grid tiles",
    }),
  );

  const count = (value) => (html.match(new RegExp(value, "g")) ?? []).length;

  assert.equal(count('data-testid="memory-tile"'), 9, "a 3x3 board has nine tiles");
  assert.equal(count('data-tile-state="pattern"'), 2, "two tiles are lit");
  assert.equal(count('data-tile-state="selected"'), 1, "one tile is picked");
  assert.equal(count('data-tile-state="rest"'), 6, "the rest are tappable blanks");
  assert.equal(count('data-tile-face="up"'), 3, "lit + picked tiles show the face");
  assert.equal(count('disabled=""'), 0, "an interactive board disables nothing");
  // The lamp is the logo asset, and the flip is a real 3D rotation.  assert.match(html, /src="[^"]*logo1[^"]*\.png"/);
  assert.match(html, /rotateY\(180deg\)/);
  assert.match(html, /rotateY\(0deg\)/);
  // The grid really lays out `size` columns.
  assert.match(html, /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/);
});

test("a frozen board is untappable and shows no pattern", () => {
  const html = renderToStaticMarkup(
    React.createElement(Board, { size: 5, picks: [], interactive: false }),
  );
  const count = (value) => (html.match(new RegExp(value, "g")) ?? []).length;

  assert.equal(count('data-testid="memory-tile"'), 25);
  assert.equal(count('data-tile-state="idle"'), 25);
  assert.equal(count('data-tile-face="up"'), 0, "nothing is revealed while frozen");
  assert.equal(count('disabled=""'), 25);
});

test("the finished board reveals the pattern in emerald", () => {
  const html = renderToStaticMarkup(
    React.createElement(Board, {
      size: 6,
      active: [1, 34],
      picks: [],
      revealed: true,
      interactive: false,
    }),
  );
  const count = (value) => (html.match(new RegExp(value, "g")) ?? []).length;

  assert.equal(count('data-testid="memory-tile"'), 36);
  assert.equal(count('data-tile-state="reveal"'), 2);
  assert.equal(count('data-tile-face="up"'), 2);
});

test("the round result shows the answer key, both reconstructions and the scores", () => {
  assert.equal(typeof RoundResult, "function", "RoundResult must be the review component");

  const html = renderToStaticMarkup(
    React.createElement(RoundResult, {
      view: resultView(),
      round: roundSnapshot(),
      botName: "GRYND AI",
    }),
  );
  const count = (value) => (html.match(new RegExp(value, "g")) ?? []).length;

  assert.match(html, /ROUND 2\/5/);
  assert.match(html, /Next round in 4s/);
  assert.match(html, /Correct Pattern/);
  assert.match(html, /Your Reconstruction/);
  assert.match(html, /GRYND AI: Reconstruction/);
  assert.equal(count('data-testid="review-grid"'), 3);
  assert.equal(count('data-review="pattern"'), 1);
  assert.equal(count('data-review="picks"'), 2);
  // 16 cells per review grid, three grids.
  assert.equal(count('data-testid="review-tile"'), 48);

  // The submitter's numbers, printed exactly as the engine scored them.
  assert.equal(count('data-stat="accuracy"'), 2);
  assert.match(html, /100\.0%/);
  assert.match(html, /87\.5%/);
  assert.match(html, /1\.23s/);
  assert.match(html, /4\.20s/);
  assert.match(html, /100\/100/);
  assert.match(html, /87\.5\/100/);
});

test("the round result labels the tiebreak round and its final window", () => {
  const html = renderToStaticMarkup(
    React.createElement(RoundResult, {
      view: resultView({ roundNumber: 6, isTiebreak: true, msLeft: 2100 }),
      round: roundSnapshot({ roundNumber: 6 }),
      botName: "GRYND AI",
    }),
  );

  assert.match(html, /TIEBREAK ROUND 6/);
  assert.match(html, /Final results in 3s/);
});

test("the app boots to the difficulty menu, not to a board", () => {
  const App = pick(appModule);
  assert.equal(typeof App, "function", "App must be the screen component");

  const html = renderToStaticMarkup(React.createElement(App));
  const count = (value) => (html.match(new RegExp(value, "g")) ?? []).length;

  assert.match(html, /Start match/);
  assert.match(html, /Study the lit tiles/);
  assert.equal(count('data-testid="difficulty-'), 3, "all three tiers are offered");
  assert.match(
    html,
    /<button[^>]*aria-pressed="true"[^>]*data-testid="difficulty-normal"/,
    "normal is the default tier",
  );
  // Nothing is dealt until the player presses Start.
  assert.equal(count('data-testid="memory-board"'), 0);
  assert.equal(count('data-testid="final-panel"'), 0);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
});

// ── 9b. The result screen, the CTA and the portal adapter ──────────────────

const ResultScreen = pick(resultScreenModule);

/** The itch.io configuration: CTA on, pointing at the production sign-in route. */
const CTA_ON = Object.freeze({
  ctaEnabled: true,
  ctaUrl: "https://www.grynd.dedyn.io/sign-in",
  ctaQuestion: "Want to track your stats and compete in ranked games?",
  ctaLabel: "Sign in to GRYND",
});

/** The default configuration: CTA off, no address in the build at all. */
const CTA_OFF = Object.freeze({ ...CTA_ON, ctaEnabled: false, ctaUrl: "" });

/** A finished match, as the controller's view describes it. */
function finishedView(overrides = {}) {
  return resultView({
    status: "finished",
    phase: null,
    roundNumber: 5,
    isTiebreak: false,
    msLeft: null,
    p1Total: 500,
    p2Total: 439,
    p1Score: 4,
    p2Score: 0,
    result: "player1",
    viewerOutcome: "win",
    startedAtMs: 0,
    endedAtMs: 67000,
    rounds: [
      { ...roundSnapshot(), roundNumber: 1, p1RoundScore: 100, p2RoundScore: 100, roundWinner: "tie" },
      { ...roundSnapshot(), roundNumber: 2, p1RoundScore: 100, p2RoundScore: 87.5, roundWinner: "player1" },
    ],
    ...overrides,
  });
}

function renderResult(view, cta) {
  assert.equal(typeof ResultScreen, "function", "ResultScreen must be the panel component");
  return renderToStaticMarkup(
    React.createElement(ResultScreen, {
      view,
      botName: "GRYND AI",
      durationLabel: "1:07",
      cta,
      onReplay: () => {},
      onChangeDifficulty: () => {},
    }),
  );
}

test("the result screen reports the outcome, both totals and every round", () => {
  for (const [outcome, label] of [
    ["win", "VICTORY"],
    ["loss", "DEFEAT"],
    ["draw", "DRAW"],
  ]) {
    const html = renderResult(finishedView({ viewerOutcome: outcome }), CTA_OFF);
    assert.match(html, new RegExp(`>${label}<`), `${outcome} must say ${label}`);
    // Every outcome is the same panel, so nothing is lost on a loss or a draw.
    assert.match(html, /data-testid="result-replay"/);
    assert.match(html, /data-testid="result-change-difficulty"/);
  }

  const html = renderResult(finishedView(), CTA_OFF);
  assert.match(html, /Match time 1:07/);
  // The totals are printed exactly as the engine accumulated them.
  assert.match(html, /data-total="amber"[^>]*>500</);
  assert.match(html, /data-total="cyan"[^>]*>439</);
  // One row per round, with both scores and the round's winner.
  assert.equal((html.match(/data-testid="round-row"/g) ?? []).length, 2);
  assert.match(html, /data-round-score="player1"[^>]*>100</);
  assert.match(html, /data-round-score="player2"[^>]*>87\.5</);
  assert.match(html, /data-round-winner="tie"/);
  assert.match(html, /data-round-winner="player1"/);
  assert.match(html, />Draw</);
});

test("the result screen labels a tiebreak match", () => {
  const html = renderResult(
    finishedView({ roundNumber: 6, isTiebreak: true, roundsPerMatch: 5 }),
    CTA_OFF,
  );
  assert.match(html, /Tiebreak round decided/);
});

test("the breakdown labels the tiebreak round TB1, never a sixth round", () => {
  const html = renderResult(
    finishedView({
      roundNumber: 6,
      isTiebreak: true,
      roundsPerMatch: 5,
      rounds: [
        {
          ...roundSnapshot(),
          roundNumber: 5,
          p1RoundScore: 100,
          p2RoundScore: 100,
          roundWinner: "tie",
        },
        {
          ...roundSnapshot(),
          roundNumber: 6,
          p1RoundScore: 87.5,
          p2RoundScore: 75,
          roundWinner: "player1",
        },
      ],
    }),
    CTA_OFF,
  );

  assert.equal((html.match(/data-testid="round-row"/g) ?? []).length, 2);
  assert.match(html, />R5</);
  assert.match(html, />TB1</);
  assert.doesNotMatch(html, />R6</, "the tiebreak is not a sixth regular round");
  // The tiebreak's own scores and winner are printed like any other round.
  assert.match(html, /data-round-score="player1"[^>]*>87\.5</);
  assert.match(html, /data-round-score="player2"[^>]*>75</);
});

test("the CTA appears only when a build enables it, and never replaces replay", () => {
  const withCta = renderResult(finishedView(), CTA_ON);

  assert.match(withCta, /data-testid="grynd-cta"/);
  assert.match(withCta, /data-testid="grynd-cta-link"/);
  assert.match(withCta, /Want to track your stats and compete in ranked games\?/);
  assert.match(withCta, /Sign in to GRYND/);
  assert.match(withCta, /href="https:\/\/www\.grynd\.dedyn\.io\/sign-in"/);
  assert.match(withCta, /target="_blank"/);
  assert.match(withCta, /rel="noopener noreferrer"/);

  // Position: after the result information, before the replay controls.
  const ctaAt = withCta.indexOf('data-testid="grynd-cta"');
  assert.ok(ctaAt > withCta.indexOf('data-testid="result-duration"'), "the CTA must follow the result info");
  assert.ok(ctaAt < withCta.indexOf('data-testid="result-replay"'), "the CTA must not replace replay");

  for (const outcome of ["win", "loss", "draw"]) {
    const html = renderResult(finishedView({ viewerOutcome: outcome }), CTA_OFF);
    assert.doesNotMatch(html, /grynd-cta/, `${outcome} must not render the CTA`);
    assert.doesNotMatch(html, /grynd\.dedyn\.io/);
    assert.doesNotMatch(html, /Sign in to GRYND/);
    assert.doesNotMatch(html, /Want to track your stats/);
    assert.match(html, /data-testid="result-replay"/);
  }
});

test("the CTA renders identically on a win, a loss and a draw", () => {
  for (const outcome of ["win", "loss", "draw"]) {
    const html = renderResult(finishedView({ viewerOutcome: outcome }), CTA_ON);
    assert.match(html, /data-testid="grynd-cta"/, `${outcome} must show the CTA`);
    assert.match(html, /data-testid="grynd-cta-link"/, `${outcome} must show the CTA link`);
    assert.match(html, /Want to track your stats and compete in ranked games\?/);
    assert.match(html, /Sign in to GRYND/);
    assert.match(html, /href="https:\/\/www\.grynd\.dedyn\.io\/sign-in"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    // The CTA is a link, never a script-driven button: with the build flag on
    // and the address supplied, it must be a plain anchor.
    assert.match(html, /<a [^>]*data-testid="grynd-cta-link"/);
  }
});

test("the CTA never claims the local match was saved or transferred", () => {
  for (const outcome of ["win", "loss"]) {
    const html = renderResult(finishedView({ viewerOutcome: outcome }), CTA_ON).toLowerCase();
    assert.doesNotMatch(
      html,
      /saved|uploaded|recorded|transferred|synced|linked/,
      `${outcome} copy must not promise a transfer`,
    );
    assert.doesNotMatch(
      html,
      /your progress|this match|this result/,
      "the copy must not imply the match is carried over",
    );
  }
});

test("the GRYND CTA is disabled unless a build turns it on", () => {
  // This test runs outside Vite, so the build-time constants are absent — the
  // exact state a package must be in for a portal that forbids the CTA.
  assert.equal(PORTAL_CONFIG.ctaEnabled, false);
  assert.equal(PORTAL_CONFIG.ctaUrl, "");
  assert.equal(PORTAL_CONFIG.ctaLabel, "Sign in to GRYND");
  assert.match(PORTAL_CONFIG.ctaQuestion, /track your stats and compete in ranked games/i);
  assert.doesNotMatch(PORTAL_CONFIG.ctaQuestion, /saved|uploaded|recorded|synced/i);

  // No hard-coded destination: only a quoted literal could ever be one, and the
  // build supplies it through `define`.
  const source = readFileSync(
    join(REPO, "standalone", "memory-grid", "src", "portal-config.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /["'`]https?:\/\//i, "the destination must come from the build");
});

test("the portal SDK adapter is a no-op unless a build enables one", () => {
  assert.equal(PORTAL_RUNTIME.name, "none");

  // Called with no DOM and no flag: every method must be a harmless no-op, so
  // importing this module can never start a network request on its own.
  PORTAL_RUNTIME.boot();
  PORTAL_RUNTIME.loaded();
  PORTAL_RUNTIME.enterMatch();
  PORTAL_RUNTIME.leaveMatch();
  PORTAL_RUNTIME.celebrate();

  const source = readFileSync(
    join(REPO, "standalone", "memory-grid", "src", "portal-sdk.ts"),
    "utf8",
  );
  // The SDK origin appears exactly once, and only behind the build flag.
  assert.equal(source.match(/sdk\.crazygames\.com/g)?.length, 1);
  assert.match(source, /MODE !== "crazygames"/);
  assert.match(source, /__PORTAL_SDK__/);
});

test("the package build folds the CTA and SDK flags, and refuses the forbidden pair", () => {
  const config = readFileSync(
    join(REPO, "standalone", "memory-grid", "vite.config.mts"),
    "utf8",
  );
  assert.match(config, /__GRYND_CTA_ENABLED__/);
  assert.match(config, /__GRYND_CTA_URL__/);
  assert.match(config, /__PORTAL_SDK__/);
  // CrazyGames forbids promoting an outside account, so that pair is an error
  // rather than a silently shipped package.
  assert.match(config, /PORTAL_CTA cannot be enabled in a PORTAL_SDK=crazygames build/);
});

test("a real match played to the end renders through the result screen", () => {
  // No hand-built view here: the controller plays a whole match (the player
  // submits the answer key every round), and the screen prints whatever the
  // controller's view says. This is the test that catches a field the synthetic
  // views above could have invented.
  let match = createLocalMatch({ difficulty: "normal", seed: 4242, nowMs: 0, readyMs: 0 });
  let now = 0;

  for (let guard = 0; guard < 600 && !match.result; guard += 1) {
    now += 250;
    match = tick(match, now);
    if (match.phase === "reconstruct" && !match.p1Submitted) {
      const submitted = submitReconstruction(match, match.pattern.active, now);
      if (!submitted.error) match = submitted.match;
    }
  }

  assert.ok(isOver(match), "the match must finish");

  const view = viewForMatch(match, now);
  assert.equal(view.viewerOutcome, "win");
  assert.equal(view.rounds.length, 5, "a decided match is five rounds");
  assert.equal(view.p1Total, 500, "the answer key scores 100 in every round");
  assert.ok(
    view.rounds.every((round) => round.flips.length === 2),
    "every round carries both seats' reconstructions",
  );

  const html = renderResult(view, CTA_OFF);
  const count = (value) => (html.match(new RegExp(value, "g")) ?? []).length;

  assert.match(html, />VICTORY</);
  // Printed from the view, not from a fixture: the numbers must agree.
  assert.match(html, new RegExp(`data-total="amber"[^>]*>${view.p1Total}<`));
  assert.match(html, new RegExp(`data-total="cyan"[^>]*>${view.p2Total}<`));
  assert.equal(count('data-testid="round-row"'), 5);
  assert.match(html, />R1</);
  assert.match(html, />R5</);
  assert.doesNotMatch(html, /grynd-cta/);
  assert.match(html, /data-testid="result-replay"/);

  // The same finished view is what the live screen renders: the round review is
  // no longer shown, and the pattern is revealed behind the overlay.
  assert.equal(view.phase, null);
  assert.equal(view.patternVisible, true);
  assert.equal(view.msLeft, null);
});

// ── 10. Bundle isolation ─────────────────────────────────────────────────

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"];

function resolveModule(base) {
  for (const candidate of [
    base,
    ...MODULE_EXTENSIONS.map((ext) => base + ext),
    ...ASSET_EXTENSIONS.map((ext) => base + ext),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  for (const ext of MODULE_EXTENSIONS) {
    const index = join(base, `index${ext}`);
    try {
      if (statSync(index).isFile()) return index;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Walk every relative import from `entry`; collect files and bare specifiers. */
function walk(entry) {
  const files = new Set();
  const external = new Set();

  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const specs = [];
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g,
    )) {
      specs.push(match[1]);
    }
    for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
      specs.push(match[1]);
    }

    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      const resolved = resolveModule(join(dirname(file), spec));
      assert.ok(resolved, `unresolved import ${spec} in ${relative(REPO, file)}`);
      // Stylesheets and image assets are leaves: they are bundled, not analysed.
      if (/\.(?:css|png|jpe?g|svg|webp|gif)$/i.test(resolved)) files.add(resolved);
      else visit(resolved);
    }
  };

  visit(entry);
  return { files, external };
}

test("no database, auth, API, socket or server module enters the standalone bundle", () => {
  const { files, external } = walk(join(STANDALONE, "src", "main.tsx"));

  const forbidden = [
    { name: "server store", pattern: /serverStore/ },
    { name: "server seeds (node crypto)", pattern: /memory-grid[/\\]seeds/ },
    { name: "socket rooms", pattern: /[/\\]rooms\.(?:js|ts)$/ },
    { name: "database", pattern: /[/\\]db[/\\]|drizzle/ },
    { name: "clerk", pattern: /@clerk/ },
    { name: "next", pattern: /[/\\]next[/\\]/ },
    { name: "api routes", pattern: /[/\\]api[/\\]/ },
    { name: "auth helpers", pattern: /guestSession|[/\\]auth[/\\]|[/\\]platform[/\\]/ },
    { name: "socket client", pattern: /socket/i },
    { name: "portal tooling", pattern: /[/\\]portal[/\\]/ },
    { name: "wager / economy", pattern: /[/\\]games[/\\](?:economy|stakes)/ },
  ];

  for (const file of files) {
    const rel = relative(REPO, file);
    for (const rule of forbidden) {
      assert.doesNotMatch(rel, rule.pattern, `standalone bundle reached ${rule.name}: ${rel}`);
    }
  }

  for (const spec of external) {
    assert.ok(
      ["react", "react-dom", "react-dom/client", "react/jsx-runtime"].includes(spec),
      `standalone bundle imported a non-React package: ${spec}`,
    );
    assert.doesNotMatch(spec, /^node:/, `standalone bundle imported a node builtin: ${spec}`);
  }

  // The shared engine really is in the graph (otherwise this test proves nothing).
  const names = [...files].map((file) => relative(REPO, file).replace(/\\/g, "/"));
  assert.ok(names.some((name) => name.endsWith("src/lib/memory-grid/constants.js")));
  assert.ok(names.some((name) => name.endsWith("src/lib/aiDifficulty.ts")));
  assert.ok(names.some((name) => name.endsWith("src/lib/results/viewerOutcome.ts")));
  assert.ok(names.some((name) => name.endsWith("src/lib/physics2d/deterministic.ts")));
  assert.ok(names.some((name) => name.endsWith("standalone/memory-grid/src/match.ts")));
  assert.ok(names.some((name) => name.endsWith("standalone/memory-grid/src/Board.tsx")));
  assert.ok(names.some((name) => name.endsWith("standalone/memory-grid/src/RoundResult.tsx")));
  assert.ok(names.some((name) => name.endsWith("standalone/memory-grid/src/ResultScreen.tsx")));
  assert.ok(names.some((name) => name.endsWith("standalone/memory-grid/src/portal-config.ts")));
  // The tile face travels with the package as an asset, not over the network.
  assert.match(
    readFileSync(join(REPO, "standalone/memory-grid/src/Board.tsx"), "utf8"),
    /new URL\("[^"]*logo1\.png", import\.meta\.url\)/,
    "the face is a bundled asset reference, not a remote URL",
  );
});

test("the standalone sources make no network, socket or storage calls", () => {
  const scans = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else scans.push(full);
    }
  };
  visit(join(STANDALONE, "src"));
  scans.push(join(STANDALONE, "index.html"));

  for (const file of scans) {
    const source = readFileSync(file, "utf8");
    const rel = relative(REPO, file);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${rel} must not call fetch`);
    assert.doesNotMatch(source, /\bXMLHttpRequest\b/, `${rel} must not use XHR`);
    assert.doesNotMatch(source, /\bWebSocket\b/, `${rel} must not open a socket`);
    assert.doesNotMatch(source, /\bsendBeacon\b/, `${rel} must not beacon`);
    assert.doesNotMatch(source, /localStorage|sessionStorage/, `${rel} must not persist anything`);
    // A remote URL may only appear as documentation. Anything the browser would
    // actually REQUEST — a stylesheet url(), a markup src/href, an @import or a
    // quoted literal — is refused.
    assert.doesNotMatch(source, /url\(\s*["']?https?:/i, `${rel} must not load a remote asset`);
    assert.doesNotMatch(
      source,
      /\b(?:src|href)\s*=\s*["']https?:/i,
      `${rel} must not reference a remote origin`,
    );
    assert.doesNotMatch(source, /@import[^;]*https?:/i, `${rel} must not import a remote stylesheet`);
    if (/\.(?:html|css)$/i.test(file)) {
      assert.doesNotMatch(source, /https?:\/\//i, `${rel} must contain no remote origin at all`);
    }
  }
});
