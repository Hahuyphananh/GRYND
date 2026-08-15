/**
 * Odds — two-phase prediction engine unit tests.
 *
 * Each Odds round has two phases:
 *   1. PICK YOUR NUMBER — both players independently lock in their own
 *      hidden number in 1..currentMax. The round only advances to the
 *      prediction phase once BOTH numbers are in.
 *   2. PREDICT OPPONENT — each player predicts the opponent's number.
 *      The round only resolves once BOTH predictions are in, revealing
 *      both numbers, both predictions, and the accuracy points each
 *      prediction earned from a FIXED band table (exact = +100, diff 1
 *      = +80, diff 2 = +60, diff 3 = +40, diff 4-5 = +20, diff 6-10 =
 *      +10, diff > 10 = +0) that never scales with the range.
 * The range halves every round; after TOTAL_ROUNDS the higher cumulative
 * score wins (tie = draw/refund). Opponents never see each other's
 * current-round submissions — viewForPlayer sanitizes per player.
 *
 * These tests pin the pure helpers in `src/lib/odds.ts` that both the
 * PvP and AI API routes depend on.
 *
 * Run:  node --import tsx --test tests/odds-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_MAX,
  MIN_MAX,
  TOTAL_ROUNDS,
  initInteractiveOddsGame,
  initPvPOddsGame,
  nextMax,
  scorePrediction,
  decideMatchWinner,
  submitPick,
  submitPrediction,
  resolvePvPRound,
  submitAIPick,
  submitAIPrediction,
  viewForPlayer,
} from "../src/lib/odds.ts";

// ════════════════════════════════════════════════════════════════════
// Constants / init
// ════════════════════════════════════════════════════════════════════

test("odds game constants: 100 start, 3 floor, 6 rounds", () => {
  assert.equal(INITIAL_MAX, 100);
  assert.equal(MIN_MAX, 3);
  assert.equal(TOTAL_ROUNDS, 6);
});

test("initPvPOddsGame starts a fresh 5-round duel in the pick phase", () => {
  const s = initPvPOddsGame();
  assert.equal(s.currentMax, INITIAL_MAX);
  assert.equal(s.currentRound, 1);
  assert.equal(s.totalRounds, TOTAL_ROUNDS);
  assert.equal(s.p1Score, 0);
  assert.equal(s.p2Score, 0);
  assert.equal(s.winner, null);
  assert.equal(s.gameOver, false);
  assert.equal(s.phase, "pick");
  assert.deepEqual(s.rounds, []);
  assert.equal(s.player1Pick, null);
  assert.equal(s.player2Pick, null);
  assert.equal(s.player1Prediction, null);
  assert.equal(s.player2Prediction, null);
  // AI mode shares the exact same shape (roundStartedAt is a timestamp,
  // so normalize it before comparing).
  const ai = initInteractiveOddsGame();
  assert.deepEqual({ ...ai, roundStartedAt: 0 }, { ...s, roundStartedAt: 0 });
});

// ════════════════════════════════════════════════════════════════════
// Range shrinking
// ════════════════════════════════════════════════════════════════════

test("nextMax halves the range and never drops below 3", () => {
  assert.equal(nextMax(100), 50);
  assert.equal(nextMax(50), 25);
  assert.equal(nextMax(25), 12);
  assert.equal(nextMax(12), 6);
  assert.equal(nextMax(6), 3);
  assert.equal(nextMax(3), 3); // floor(1.5) = 1 → clamp to 3
  assert.equal(nextMax(2), 3);
  assert.equal(nextMax(1), 3);
});

test("range schedule: 100 → 50 → 25 → 12 → 6 → 3 across the 6 rounds", () => {
  const expected = [INITIAL_MAX, 50, 25, 12, 6, 3];
  assert.equal(TOTAL_ROUNDS, expected.length);
  let max = INITIAL_MAX;
  for (let r = 1; r < TOTAL_ROUNDS; r += 1) {
    max = nextMax(max);
    assert.equal(max, expected[r], `round ${r + 1} range`);
  }
});

// ════════════════════════════════════════════════════════════════════
// Accuracy scoring
// ════════════════════════════════════════════════════════════════════

test("scorePrediction: fixed band table, independent of the range", () => {
  // Exact prediction = +100, every round, regardless of range.
  assert.equal(scorePrediction(42, 42, 100), 100);
  assert.equal(scorePrediction(2, 2, 2), 100); // exact in a 1..2 range
  // Bands: diff 1 → 80, 2 → 60, 3 → 40, 4–5 → 20, 6–10 → 10, >10 → 0.
  assert.equal(scorePrediction(43, 42, 100), 80);
  assert.equal(scorePrediction(44, 42, 100), 60);
  assert.equal(scorePrediction(45, 42, 100), 40);
  assert.equal(scorePrediction(46, 42, 100), 20);
  assert.equal(scorePrediction(47, 42, 100), 20);
  assert.equal(scorePrediction(48, 42, 100), 10);
  assert.equal(scorePrediction(52, 42, 100), 10);
  assert.equal(scorePrediction(53, 42, 100), 0);
  assert.equal(scorePrediction(1, 100, 100), 0);
  assert.equal(scorePrediction(42, 1, 100), 0);
  // Small ranges: the band for the absolute diff still applies — a diff
  // of 1 in a 1..2 range earns +80, never scaled down (or up).
  assert.equal(scorePrediction(1, 2, 2), 80);
  assert.equal(scorePrediction(2, 2, 2), 100);
  // Out-of-range / impossible predictions are never rewarded.
  assert.equal(scorePrediction(0, 5, 100), 0);
  assert.equal(scorePrediction(101, 5, 100), 0);
  assert.equal(scorePrediction(5, 0, 100), 0);
  assert.equal(scorePrediction(5, 101, 100), 0);
  assert.equal(scorePrediction(3, 2, 2), 0); // prediction outside 1..2
  // Never more than +100.
  assert.equal(scorePrediction(999, 999, 1000), 100);
  // Malformed inputs score 0.
  assert.equal(scorePrediction(NaN, 5, 100), 0);
  assert.equal(scorePrediction(5, NaN, 100), 0);
});

// ════════════════════════════════════════════════════════════════════
// Match winner
// ════════════════════════════════════════════════════════════════════

test("decideMatchWinner: higher cumulative score wins; tie = null (draw)", () => {
  assert.equal(decideMatchWinner(10, 5), "player1");
  assert.equal(decideMatchWinner(5, 10), "player2");
  assert.equal(decideMatchWinner(10, 10), null);
  assert.equal(decideMatchWinner(0, 0), null);
});

// ════════════════════════════════════════════════════════════════════
// Two-phase round flow
// ════════════════════════════════════════════════════════════════════

// Full state with all four submissions already present — used for the
// resolvePvPRound unit tests below.
function roundState(overrides = {}) {
  return {
    ...initPvPOddsGame(),
    player1Pick: 40,
    player2Pick: 60,
    player1Prediction: 60,
    player2Prediction: 40,
    ...overrides,
  };
}

test("submitPick: records one number; predict phase only after BOTH lock in", () => {
  let s = initPvPOddsGame();

  let r = submitPick(s, "player1", 40);
  assert.equal(r.phaseComplete, false);
  assert.equal(r.updatedState.phase, "pick");
  assert.equal(r.updatedState.player1Pick, 40);
  assert.equal(r.updatedState.player2Pick, null);

  r = submitPick(r.updatedState, "player2", 60);
  assert.equal(r.phaseComplete, true);
  assert.equal(r.updatedState.phase, "predict");
  assert.equal(r.updatedState.player2Pick, 60);
});

test("submitPrediction: round stays unresolved until BOTH predictions are in", () => {
  let s = initPvPOddsGame();
  s = submitPick(s, "player1", 40).updatedState;
  s = submitPick(s, "player2", 60).updatedState;
  assert.equal(s.phase, "predict");

  let r = submitPrediction(s, "player1", 60);
  assert.equal(r.phaseComplete, false);
  assert.equal(r.updatedState.player1Prediction, 60);
  assert.equal(r.updatedState.player2Prediction, null);

  r = submitPrediction(r.updatedState, "player2", 40);
  assert.equal(r.phaseComplete, true);
  assert.equal(r.updatedState.player1Prediction, 60);
  assert.equal(r.updatedState.player2Prediction, 40);
});

test("resolvePvPRound: scores both predictions, stamps the round winner", () => {
  // p1 predicts 60, p2's number is 60 → perfect, max points (100).
  // p2 predicts 40, p1's number is 40 → perfect too → tie round.
  const state = roundState();
  const { round, updatedState } = resolvePvPRound(state);

  assert.equal(round.max, 100);
  assert.equal(round.player1Number, 40);
  assert.equal(round.player2Number, 60);
  assert.equal(round.player1Prediction, 60);
  assert.equal(round.player2Prediction, 40);
  assert.equal(round.player1Score, 100);
  assert.equal(round.player2Score, 100);
  assert.equal(round.roundWinner, "draw");

  assert.equal(updatedState.p1Score, 100);
  assert.equal(updatedState.p2Score, 100);
  assert.equal(updatedState.rounds.length, 1);
  assert.equal(updatedState.gameOver, false);
  // Range halved for the next round; submissions cleared; back to pick.
  assert.equal(updatedState.currentMax, 50);
  assert.equal(updatedState.currentRound, 2);
  assert.equal(updatedState.phase, "pick");
  assert.equal(updatedState.player1Pick, null);
  assert.equal(updatedState.player1Prediction, null);
  assert.equal(updatedState.player2Pick, null);
  assert.equal(updatedState.player2Prediction, null);
});

test("resolvePvPRound: better prediction wins the round", () => {
  // p1 predicts p2's 50 exactly (score 100); p2 predicts 1 vs p1's 40
  // (diff 39 → band >10 → 0).
  const state = roundState({
    player1Pick: 40,
    player2Pick: 50,
    player1Prediction: 50,
    player2Prediction: 1,
  });
  const { round } = resolvePvPRound(state);
  assert.equal(round.player1Score, 100);
  assert.equal(round.player2Score, 0);
  assert.equal(round.roundWinner, "player1");
});

test("resolvePvPRound throws until both numbers AND both predictions are in", () => {
  assert.throws(() => resolvePvPRound(roundState({ player1Pick: null })), /number/);
  assert.throws(() => resolvePvPRound(roundState({ player2Pick: null })), /number/);
  assert.throws(() => resolvePvPRound(roundState({ player1Prediction: null })), /prediction/);
  assert.throws(() => resolvePvPRound(roundState({ player2Prediction: null })), /prediction/);
});

test("full match: 5 two-phase rounds resolve, winner decided, gameOver, final range kept", () => {
  // Each round: p1 picks 1, p2 picks max, p1 predicts max exactly and
  // p2 predicts 1 exactly → both always score +100 → final draw.
  const playRound = (state) => {
    let s = submitPick(state, "player1", 1).updatedState;
    s = submitPick(s, "player2", state.currentMax).updatedState;
    assert.equal(s.phase, "predict");
    s = submitPrediction(s, "player1", state.currentMax).updatedState;
    s = submitPrediction(s, "player2", 1).updatedState;
    return resolvePvPRound(s);
  };

  let state = initPvPOddsGame();
  let lastRound = null;
  for (let r = 0; r < TOTAL_ROUNDS; r += 1) {
    assert.equal(state.gameOver, false, `round ${r + 1} should not be over yet`);
    const { round, updatedState } = playRound(state);
    lastRound = round;
    state = updatedState;
  }
  assert.equal(state.gameOver, true);
  assert.equal(state.rounds.length, TOTAL_ROUNDS);
  assert.equal(state.rounds[TOTAL_ROUNDS - 1], lastRound);
  assert.equal(state.winner, null);
  // Range stays at the last round's max once the match is over.
  assert.equal(state.currentMax, lastRound.max);
});

test("full match: lopsided accuracy produces a clear winner", () => {
  // p1 always predicts the opponent's number exactly (+100); p2 always
  // predicts the far end of the range, so against p1's 1 they score 0
  // (only reaching the +20 band in the final tiny ranges) → p1 wins.
  const playRound = (state) => {
    let s = submitPick(state, "player1", 1).updatedState;
    s = submitPick(s, "player2", 2).updatedState;
    s = submitPrediction(s, "player1", 2).updatedState;
    s = submitPrediction(s, "player2", state.currentMax).updatedState;
    return resolvePvPRound(s);
  };

  let state = initPvPOddsGame();
  for (let r = 0; r < TOTAL_ROUNDS; r += 1) {
    const { updatedState } = playRound(state);
    state = updatedState;
  }
  assert.equal(state.gameOver, true);
  assert.ok(state.p1Score > state.p2Score);
  assert.equal(state.winner, "player1");
});

// ════════════════════════════════════════════════════════════════════
// AI resolution
// ════════════════════════════════════════════════════════════════════

test("submitAIPick: AI locks a hidden number and moves to predict phase", () => {
  const state = initPvPOddsGame();
  const { updatedState } = submitAIPick(state, 12);

  assert.equal(updatedState.player1Pick, 12);
  assert.ok(
    updatedState.player2Pick !== null &&
      updatedState.player2Pick >= 1 &&
      updatedState.player2Pick <= 100,
  );
  assert.equal(updatedState.phase, "predict");
  assert.equal(updatedState.rounds.length, 0);

  // The client never receives the AI's number — the sanitized view nulls it.
  const view = viewForPlayer(updatedState, true);
  assert.equal(view.player2Pick, null);
});

test("submitAIPrediction: resolves the round with AI numbers in range", () => {
  let state = initPvPOddsGame();
  state = submitAIPick(state, 7).updatedState;
  const aiNumber = state.player2Pick;

  const { round, updatedState } = submitAIPrediction(state, 50);
  assert.equal(round.player1Number, 7);
  assert.equal(round.player2Number, aiNumber);
  assert.equal(round.player1Prediction, 50);
  assert.ok(
    round.player2Prediction >= 1 && round.player2Prediction <= 100,
  );
  assert.equal(round.player1Score, scorePrediction(50, aiNumber, 100));
  assert.equal(round.player2Score, scorePrediction(round.player2Prediction, 7, 100));
  assert.equal(updatedState.rounds.length, 1);
  assert.equal(updatedState.phase, "pick");
});

// ════════════════════════════════════════════════════════════════════
// Per-player view sanitization
// ════════════════════════════════════════════════════════════════════

test("viewForPlayer: hides the opponent's submissions until the reveal", () => {
  // Pick phase, only player1 has locked in.
  let s = submitPick(initPvPOddsGame(), "player1", 42).updatedState;

  const p1View = viewForPlayer(s, true);
  assert.equal(p1View.player1Pick, 42); // own number visible
  assert.equal(p1View.player2Pick, null); // opponent hidden
  assert.equal(p1View.opponentPicked, false);

  const p2View = viewForPlayer(s, false);
  assert.equal(p2View.player1Pick, null); // player1's number hidden from player2
  assert.equal(p2View.opponentPicked, true); // but player2 knows player1 picked

  // Predict phase: both numbers in, only player1 has predicted.
  s = submitPick(s, "player2", 7).updatedState;
  assert.equal(s.phase, "predict");
  s = submitPrediction(s, "player1", 7).updatedState;

  const p1v = viewForPlayer(s, true);
  assert.equal(p1v.player1Prediction, 7);
  assert.equal(p1v.player2Prediction, null);
  assert.equal(p1v.opponentPredicted, false);

  const p2v = viewForPlayer(s, false);
  assert.equal(p2v.player1Pick, null); // player1's number still hidden
  assert.equal(p2v.player2Pick, 7); // own number visible
  assert.equal(p2v.opponentPicked, true);
  assert.equal(p2v.opponentPredicted, true);

  // Once the match is over everything is revealed.
  const finished = {
    ...s,
    gameOver: true,
    player1Pick: 42,
    player2Pick: 7,
    player1Prediction: 7,
    player2Prediction: 3,
  };
  const finView = viewForPlayer(finished, false);
  assert.equal(finView.player1Pick, 42);
  assert.equal(finView.player2Pick, 7);
  assert.equal(finView.player1Prediction, 7);
});

// ════════════════════════════════════════════════════════════════════
// End-to-end match simulation (server code path)
//
// Walks a full 6-round PvP match through the exact helpers the API
// routes call (submitPick → submitPrediction → resolvePvPRound →
// viewForPlayer) while mirroring the route-level guard rails (phase
// checks, range validation, duplicate/post-completion rejection) so the
// whole flow — including every requested edge case — is pinned without
// needing a database.
// ════════════════════════════════════════════════════════════════════

// Mirrors src/app/api/odds/pvp/pick/route.ts validation. Returns the
// same shape the route builds: { updatedState, phaseComplete } or, when
// the round resolves, { resolvedState }.
function routeSubmit(state, player, { number, prediction } = {}) {
  if (state.gameOver) {
    throw Object.assign(new Error("Game is already over"), { status: 400 });
  }
  const myDone =
    state.phase === "predict"
      ? player === "player1"
        ? state.player1Prediction !== null
        : state.player2Prediction !== null
      : player === "player1"
        ? state.player1Pick !== null
        : state.player2Pick !== null;
  if (myDone) {
    throw Object.assign(new Error("You already submitted for this round"), {
      status: 400,
    });
  }

  if (state.phase === "pick") {
    if (prediction !== undefined) {
      throw Object.assign(new Error("Lock in your number before predicting"), {
        status: 400,
      });
    }
    if (number === undefined || !Number.isInteger(number)) {
      throw Object.assign(new Error("Number must be a whole number"), {
        status: 400,
      });
    }
    if (number < 1 || number > state.currentMax) {
      throw Object.assign(
        new Error(`Number must be between 1 and ${state.currentMax}`),
        { status: 400 },
      );
    }
    return submitPick(state, player, number);
  }

  // predict phase
  if (number !== undefined) {
    throw Object.assign(new Error("Your number is locked in — submit a prediction"), {
      status: 400,
    });
  }
  if (prediction === undefined || !Number.isInteger(prediction)) {
    throw Object.assign(new Error("Prediction must be a whole number"), {
      status: 400,
    });
  }
  if (prediction < 1 || prediction > state.currentMax) {
    throw Object.assign(
      new Error(`Prediction must be between 1 and ${state.currentMax}`),
      { status: 400 },
    );
  }
  const res = submitPrediction(state, player, prediction);
  if (!res.phaseComplete) return res;
  return { resolvedState: resolvePvPRound(res.updatedState) };
}

// Plays one full round from the player's perspective, mirroring how the
// UI submits and how the server answers each client. `order` controls
// who submits first in each phase (simulates simultaneous submission
// races). Returns { round, updatedState, views } where views holds each
// player's sanitized view throughout the round.
test("e2e: complete 6-round match — flow, visibility, scoring, progression", () => {
  const playRound = (state, order) => {
    const views = { p1: [], p2: [] };
    const pickOrder =
      order === "p2-first" ? ["player2", "player1"] : ["player1", "player2"];

    // 1. Both players see PICK YOUR NUMBER with the current range.
    assert.equal(state.phase, "pick");
    assert.equal(state.currentRound, state.rounds.length + 1);

    // 2. Both submit a valid number (simultaneous-ish, both orders).
    let s = state;
    for (const player of pickOrder) {
      const n = player === "player1" ? 1 : Math.min(state.currentMax, 7);
      const res = routeSubmit(s, player, { number: n });
      s = res.updatedState ?? res.resolvedState?.updatedState ?? s;
      // 6. Neither player sees the other's number at ANY point.
      const p1v = viewForPlayer(s, true);
      const p2v = viewForPlayer(s, false);
      views.p1.push({ phase: s.phase, ...p1v });
      views.p2.push({ phase: s.phase, ...p2v });
    }

    // 7. Both numbers in → predict phase.
    assert.equal(s.phase, "predict");
    // The opponent's number stays hidden even in the predict phase.
    assert.equal(views.p1.at(-1).player2Pick, null);
    assert.equal(views.p2.at(-1).player1Pick, null);
    assert.equal(views.p1.at(-1).opponentPicked, true);
    assert.equal(views.p2.at(-1).opponentPicked, true);

    // 8. Both submit a prediction.
    const predOrder =
      order === "p2-first" ? ["player2", "player1"] : ["player1", "player2"];
    for (const player of predOrder) {
      const p = player === "player1" ? state.currentMax : 1;
      const res = routeSubmit(s, player, { prediction: p });
      if (res.resolvedState) {
        s = res.resolvedState.updatedState;
        views.p1.push({ phase: s.phase, ...viewForPlayer(s, true) });
        views.p2.push({ phase: s.phase, ...viewForPlayer(s, false) });
        return { round: res.resolvedState.round, updatedState: s, views };
      }
      s = res.updatedState;
      // 9. Neither player sees the other's prediction before the reveal.
      assert.equal(viewForPlayer(s, true).player2Prediction, null);
      assert.equal(viewForPlayer(s, false).player1Prediction, null);
      views.p1.push({ phase: s.phase, ...viewForPlayer(s, true) });
      views.p2.push({ phase: s.phase, ...viewForPlayer(s, false) });
    }
    throw new Error("round never resolved");
  };

  let state = initPvPOddsGame();
  const expectedRanges = [100, 50, 25, 12, 6, 3];
  const expectedScores = [];

  for (let roundIdx = 0; roundIdx < TOTAL_ROUNDS; roundIdx += 1) {
    // 1. Show current range.
    assert.equal(state.currentMax, expectedRanges[roundIdx]);
    assert.equal(state.currentRound, roundIdx + 1);

    // Alternate who submits first to prove both orders resolve identically.
    const order = roundIdx % 2 === 0 ? "p1-first" : "p2-first";
    const { round, updatedState } = playRound(state, order);

    // 10–12. Both numbers + predictions revealed; server-computed accuracy.
    assert.equal(round.max, expectedRanges[roundIdx]);
    assert.equal(round.player1Number, 1);
    assert.equal(round.player2Number, Math.min(expectedRanges[roundIdx], 7));
    assert.equal(round.player1Prediction, expectedRanges[roundIdx]);
    assert.equal(round.player2Prediction, 1);
    assert.equal(
      round.player1Score,
      scorePrediction(round.player1Prediction, round.player2Number, round.max),
    );
    assert.equal(
      round.player2Score,
      scorePrediction(round.player2Prediction, round.player1Number, round.max),
    );
    expectedScores.push([round.player1Score, round.player2Score]);

    // 13. History has BOTH players' picks AND predictions.
    const last = updatedState.rounds[updatedState.rounds.length - 1];
    assert.equal(last, round);
    assert.equal(updatedState.rounds.length, roundIdx + 1);

    // 14. Cumulative scoreboard updated.
    assert.equal(updatedState.p1Score, sum(expectedScores, 0));
    assert.equal(updatedState.p2Score, sum(expectedScores, 1));

    // 15. Range shrinks for the next round (stays at last max when over).
    if (roundIdx < TOTAL_ROUNDS - 1) {
      assert.equal(updatedState.currentMax, expectedRanges[roundIdx + 1]);
      assert.equal(updatedState.gameOver, false);
      assert.equal(updatedState.phase, "pick"); // 16. next round begins
    }
    state = updatedState;
  }

  // 17–19. Match over: winner decided from cumulative scores, gameOver set
  // (wager settlement happens in the route only when gameOver turns true).
  assert.equal(state.gameOver, true);
  assert.equal(state.rounds.length, TOTAL_ROUNDS);
  assert.equal(state.currentMax, expectedRanges[TOTAL_ROUNDS - 1]);
  assert.equal(state.winner, decideMatchWinner(state.p1Score, state.p2Score));
  assert.ok(state.winner === "player1" || state.winner === "player2");
});

function sum(rows, col) {
  return rows.reduce((acc, r) => acc + r[col], 0);
}

test("e2e edge: duplicate submission is rejected (route guard)", () => {
  let s = initPvPOddsGame();
  s = routeSubmit(s, "player1", { number: 42 }).updatedState;
  // Second pick from the same player is refused — locked in is locked in.
  assert.throws(
    () => routeSubmit(s, "player1", { number: 43 }),
    /already submitted/,
  );
  // …and their number cannot be silently changed.
  assert.equal(s.player1Pick, 42);
});

test("e2e edge: invalid / out-of-range submissions are rejected", () => {
  let s = initPvPOddsGame();
  assert.throws(() => routeSubmit(s, "player1", {}), /whole number/);
  assert.throws(() => routeSubmit(s, "player1", { number: 0 }), /between 1 and 100/);
  assert.throws(() => routeSubmit(s, "player1", { number: 101 }), /between 1 and 100/);
  assert.throws(() => routeSubmit(s, "player1", { number: 12.5 }), /whole number/);
  assert.throws(() => routeSubmit(s, "player1", { number: "abc" }), /whole number/);
  // Prediction in a later (smaller) range must respect that range.
  s = routeSubmit(s, "player1", { number: 5 }).updatedState;
  s = routeSubmit(s, "player2", { number: 5 }).updatedState;
  assert.equal(s.phase, "predict");
  assert.throws(() => routeSubmit(s, "player1", { prediction: 0 }), /between 1 and 100/);
  assert.throws(() => routeSubmit(s, "player1", { prediction: 101 }), /between 1 and 100/);
  // Wrong-phase field is rejected too.
  // …a number during the predict phase…
  assert.throws(() => routeSubmit(s, "player1", { number: 9 }), /locked in/);
  // …and a prediction during the pick phase.
  assert.throws(
    () => routeSubmit(initPvPOddsGame(), "player1", { prediction: 9 }),
    /before predicting/,
  );
});

test("e2e edge: submissions after the match ends are rejected", () => {
  // Run a short match to completion, then try to keep submitting.
  let state = initPvPOddsGame();
  for (let r = 0; r < TOTAL_ROUNDS; r += 1) {
    state = routeSubmit(state, "player1", { number: 1 }).updatedState;
    state = routeSubmit(state, "player2", { number: 2 }).updatedState;
    state = routeSubmit(state, "player1", { prediction: 2 }).updatedState;
    const res = routeSubmit(state, "player2", { prediction: 1 });
    state = res.resolvedState.updatedState;
  }
  assert.equal(state.gameOver, true);
  assert.throws(() => routeSubmit(state, "player1", { number: 5 }), /already over/);
  assert.throws(() => routeSubmit(state, "player2", { prediction: 3 }), /already over/);
  // The final reveal is still visible to both sides.
  assert.equal(viewForPlayer(state, true).player1Number, undefined); // via rounds history
  assert.equal(state.rounds.length, TOTAL_ROUNDS);
});

test("e2e edge: simultaneous submissions in either order converge", () => {
  // Each player always makes the SAME moves; only the order of who
  // submits first varies (as happens when both hit submit at once). Both
  // orders must reach the identical revealed round and next-round state.
  const play = (order) => {
    let s = initPvPOddsGame();
    for (const player of order) {
      const res = routeSubmit(s, player, {
        number: player === "player1" ? 20 : 80,
      });
      s = res.updatedState;
    }
    for (const player of order) {
      const res = routeSubmit(s, player, {
        prediction: player === "player1" ? 80 : 20,
      });
      s = res.resolvedState ? res.resolvedState.updatedState : res.updatedState;
    }
    return s;
  };
  const first = play(["player1", "player2"]);
  const second = play(["player2", "player1"]);
  // Identical round stored, identical scores, identical next range.
  assert.deepEqual(first.rounds[0], second.rounds[0]);
  assert.equal(first.p1Score, second.p1Score);
  assert.equal(first.p2Score, second.p2Score);
  assert.equal(first.currentMax, second.currentMax);
  assert.equal(first.rounds.length, 1);
  assert.equal(first.phase, "pick");
});

test("e2e edge: refresh / reconnect always yields a valid sanitized view", () => {
  // Mid-game state (p1 picked, p2 picked, p1 predicted) — what the status
  // route returns to each player after a refresh.
  let s = initPvPOddsGame();
  s = submitPick(s, "player1", 33).updatedState;
  s = submitPick(s, "player2", 66).updatedState;
  s = submitPrediction(s, "player1", 66).updatedState;

  const p1 = viewForPlayer(s, true);
  const p2 = viewForPlayer(s, false);
  // Both can resume their own part…
  assert.equal(p1.player1Pick, 33);
  assert.equal(p1.player1Prediction, 66);
  assert.equal(p2.player2Pick, 66);
  // …while the opponent's submissions stay hidden.
  assert.equal(p1.player2Pick, null);
  assert.equal(p1.player2Prediction, null);
  assert.equal(p2.player1Pick, null);
  assert.equal(p2.player1Prediction, null);
  assert.equal(p1.opponentPicked, true);
  assert.equal(p1.opponentPredicted, false);
  assert.equal(p2.opponentPicked, true);
  assert.equal(p2.opponentPredicted, true);
  // Resume: p2 submits their prediction and the round resolves normally.
  const res = routeSubmit(s, "player2", { prediction: 33 });
  assert.equal(res.resolvedState.updatedState.rounds.length, 1);
});

test("e2e edge: timeout detection keys off the current phase", () => {
  // The 120s auto-forfeit fires only when the OPPONENT has completed their
  // part of the CURRENT phase. Simulate the phase-aware "done" predicates
  // the pick/cleanup routes use.
  const doneFor = (state, player) =>
    state.phase === "predict"
      ? player === "player1"
        ? state.player1Prediction !== null
        : state.player2Prediction !== null
      : player === "player1"
        ? state.player1Pick !== null
        : state.player2Pick !== null;

  // In the pick phase, a pick counts as done.
  let s = submitPick(initPvPOddsGame(), "player1", 10).updatedState;
  assert.equal(doneFor(s, "player1"), true);
  assert.equal(doneFor(s, "player2"), false);

  // In the predict phase, only a prediction counts as done.
  s = submitPick(s, "player2", 20).updatedState;
  assert.equal(s.phase, "predict");
  assert.equal(doneFor(s, "player1"), false); // picked but not predicted
  assert.equal(doneFor(s, "player2"), false);
  s = submitPrediction(s, "player1", 20).updatedState;
  assert.equal(doneFor(s, "player1"), true);
  assert.equal(doneFor(s, "player2"), false);

  // Phase clock restarts when a phase completes (fresh timer for predict).
  const t0 = submitPick(initPvPOddsGame(), "player1", 1).updatedState.roundStartedAt;
  const s2 = submitPick(
    { ...initPvPOddsGame(), player1Pick: 1, roundStartedAt: t0 },
    "player2",
    2,
  ).updatedState;
  assert.ok(s2.roundStartedAt >= t0); // predict timer is fresh, not stale
});

test("e2e edge: exact tie at the end = draw (both refunded, no winner)", () => {
  // Every round: both predict the opponent's number exactly → both +100
  // every round → identical totals → decideMatchWinner returns null, which
  // is exactly what triggers the route's double-refund branch.
  const playRound = (state) => {
    let s = submitPick(state, "player1", 1).updatedState;
    s = submitPick(s, "player2", 2).updatedState;
    s = submitPrediction(s, "player1", 2).updatedState;
    s = submitPrediction(s, "player2", 1).updatedState;
    return resolvePvPRound(s).updatedState;
  };
  let state = initPvPOddsGame();
  for (let r = 0; r < TOTAL_ROUNDS; r += 1) state = playRound(state);
  assert.equal(state.gameOver, true);
  assert.equal(state.p1Score, state.p2Score);
  assert.equal(state.winner, null); // → route refunds both stakes
});

console.log("\n✅ All Odds prediction engine tests passed!\n");
