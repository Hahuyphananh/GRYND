/**
 * Odds — shared-target prediction engine unit tests.
 *
 * The current game (rules version 2) works like this:
 *
 *   * a match is EXACTLY FIVE ROUNDS and the number domain is 1..100 in
 *     every round — there is no shrinking range any more;
 *   * each round the SERVER draws ONE target in 1..100 and gives BOTH seats
 *     the same clue derived from it (`createClue`), which never discloses it;
 *   * each seat submits ONE prediction — an exact number or an inclusive
 *     range — and the round resolves only when both are in;
 *   * scoring is width-based: exact hit = 100, exact miss = 0, a range that
 *     contains the target = max(1, round(100 / width)) where
 *     width = max - min + 1, a range that misses = 0;
 *   * the higher CUMULATIVE score after five rounds wins; an exact tie is a
 *     draw.
 *
 * Everything here is the pure engine in `src/lib/odds.ts`, which both the PvP
 * and the AI routes score through — a rule change cannot apply to one and not
 * the other.
 *
 * Run:  node --import tsx --test tests/odds-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_CLUE_CANDIDATES,
  ODDS_STATE_VERSION,
  TARGET_MAX,
  TARGET_MIN,
  TOTAL_ROUNDS,
  botPrediction,
  createClue,
  createRound,
  currentRoundOf,
  decideMatchWinner,
  describePrediction,
  hasSubmitted,
  initInteractiveOddsGame,
  initPvPOddsGame,
  isCurrentOddsState,
  normalizePrediction,
  parsePrediction,
  predictionOf,
  predictionWidth,
  resolveRound,
  scorePrediction,
  submitAIPick,
  submitAIPrediction,
  seededUnitSource,
  submitPrediction,
  viewForPlayer,
} from "../src/lib/odds.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Every prediction the engine considers legal, as `{min,max}` spans. */
const exact = (value) => ({ kind: "exact", value });
const range = (min, max) => ({ kind: "range", min, max });

/**
 * Open a fresh match whose live round targets a known number, so a scoring
 * assertion never depends on the RNG.
 */
function matchTargeting(target) {
  const state = initPvPOddsGame({ random: () => 0 });
  currentRoundOf(state).target = target;
  return state;
}

/** Both seats submit in one round, then the round resolves. */
function playRound(state, mine, theirs, target) {
  currentRoundOf(state).target = target;
  const first = submitPrediction(state, "player1", mine);
  const second = submitPrediction(first.updatedState, "player2", theirs);
  return resolveRound(second.updatedState);
}

// ── Rules constants ──────────────────────────────────────────────────────

test("a match is exactly five rounds over a fixed 1..100 domain", () => {
  assert.equal(TOTAL_ROUNDS, 5);
  assert.equal(TARGET_MIN, 1);
  assert.equal(TARGET_MAX, 100);

  const state = initPvPOddsGame();
  assert.equal(state.totalRounds, 5);
  assert.equal(state.currentRound, 1);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.version, ODDS_STATE_VERSION);
  // The domain does not shrink: there is no `currentMax` / `phase` any more.
  assert.equal(state.currentMax, undefined);
  assert.equal(state.phase, undefined);
});

test("both entry points start the same state", () => {
  const pvp = initPvPOddsGame({ random: () => 0 });
  const ai = initInteractiveOddsGame({ random: () => 0 });
  assert.deepEqual(
    { ...ai, roundStartedAt: 0 },
    { ...pvp, roundStartedAt: 0 },
  );
});

test("every round gets a fresh target inside the domain", () => {
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const round = createRound(1);
    assert.ok(Number.isInteger(round.target));
    assert.ok(round.target >= TARGET_MIN && round.target <= TARGET_MAX);
    assert.equal(round.resolved, false);
    assert.equal(round.player1Prediction, null);
    assert.equal(round.player2Prediction, null);
    assert.equal(round.player1Score, null);
    assert.equal(round.player2Score, null);
    seen.add(round.target);
  }
  // The draw is not degenerate.
  assert.ok(seen.size > 50, `expected a spread of targets, saw ${seen.size}`);
});

// ── Exact predictions ─────────────────────────────────────────────────────

test("an exact hit is worth 100 and an exact miss is worth 0", () => {
  for (const target of [TARGET_MIN, 37, 50, 99, TARGET_MAX]) {
    assert.equal(scorePrediction(exact(target), target), 100);
    const wrong = target === TARGET_MAX ? target - 1 : target + 1;
    assert.equal(scorePrediction(exact(wrong), target), 0);
  }
});

test("an exact prediction has width 1", () => {
  assert.equal(predictionWidth(exact(42)), 1);
});

// ── Range predictions ────────────────────────────────────────────────────

test("a range containing the target pays 100 / width, rounded", () => {
  // width 1 is a one-number range — the same as an exact call.
  assert.equal(scorePrediction(range(42, 42), 42), 100);
  assert.equal(scorePrediction(range(41, 42), 42), 50); // 2 → 50
  assert.equal(scorePrediction(range(41, 43), 42), 33); // 3 → 33.33
  assert.equal(scorePrediction(range(40, 44), 42), 20); // 5 → 20
  assert.equal(scorePrediction(range(38, 47), 42), 10); // 10 → 10
  assert.equal(scorePrediction(range(33, 52), 42), 5); // 20 → 5
  assert.equal(scorePrediction(range(18, 67), 42), 2); // 50 → 2
  assert.equal(scorePrediction(range(1, 100), 42), 1); // 100 → 1
});

test("the documented widths score exactly 100, 50, 20, 10, 5, 2 and 1", () => {
  const cases = [
    [1, 100],
    [2, 50],
    [5, 20],
    [10, 10],
    [20, 5],
    [50, 2],
    [100, 1],
  ];
  for (const [width, expected] of cases) {
    // Start far enough left that the window fits inside 1..100.
    const min = Math.min(50, TARGET_MAX - width + 1);
    const max = min + width - 1;
    assert.ok(max <= TARGET_MAX, `width ${width} fits the domain`);
    // The target sits at both edges and in the middle: width is what pays.
    for (const target of [min, min + Math.floor(width / 2), max]) {
      const prediction = width === 1 ? exact(min) : range(min, max);
      assert.equal(
        scorePrediction(prediction, target),
        expected,
        `width ${width} vs target ${target}`,
      );
      assert.equal(predictionWidth(prediction), width);
    }
  }
});

test("a range that misses the target scores nothing, however narrow", () => {
  assert.equal(scorePrediction(range(1, 2), 3), 0);
  assert.equal(scorePrediction(range(99, 100), 98), 0);
  assert.equal(scorePrediction(range(50, 51), 52), 0);
  // Just outside the edge is still outside.
  assert.equal(scorePrediction(range(10, 20), 21), 0);
  assert.equal(scorePrediction(range(10, 20), 9), 0);
});

test("a correct range is always worth at least one point", () => {
  for (let min = TARGET_MIN; min <= TARGET_MAX; min += 7) {
    for (let max = min; max <= TARGET_MAX; max += 11) {
      const score = scorePrediction(range(min, max), min);
      assert.ok(score >= 1, `range ${min}-${max} must score at least 1`);
      assert.equal(score, Math.max(1, Math.round(100 / (max - min + 1))));
    }
  }
});

// ── Input validation ─────────────────────────────────────────────────────

test("every prediction must be an integer inside 1..100", () => {
  for (const value of [0, -1, 101, 1000, 1.5, "42", null, undefined, NaN]) {
    assert.equal(parsePrediction({ exact: value }).ok, false, `exact ${value}`);
  }
  assert.equal(parsePrediction({ exact: 1 }).ok, true);
  assert.equal(parsePrediction({ exact: 100 }).ok, true);

  for (const [min, max] of [
    [0, 10],
    [10, 101],
    [1.5, 10],
    [10, 1.5],
    [-5, 5],
  ]) {
    assert.equal(
      parsePrediction({ min, max }).ok,
      false,
      `range ${min}-${max}`,
    );
  }
  assert.equal(parsePrediction({ min: 1, max: 100 }).ok, true);
});

test("a reversed or incomplete range is rejected", () => {
  const reversed = parsePrediction({ min: 60, max: 40 });
  assert.equal(reversed.ok, false);
  assert.match(reversed.error, /minimum cannot be greater/i);

  assert.equal(parsePrediction({ min: 40 }).ok, false);
  assert.equal(parsePrediction({ max: 40 }).ok, false);
  // Both forms at once is ambiguous, so it is refused rather than guessed.
  assert.equal(parsePrediction({ exact: 40, min: 40, max: 50 }).ok, false);
  // Nothing at all is refused.
  assert.equal(parsePrediction({}).ok, false);
  assert.equal(parsePrediction(null).ok, false);
});

test("the engine refuses an out-of-domain prediction even if a route let it through", () => {
  // normalizePrediction is the backstop behind parsePrediction.
  assert.equal(normalizePrediction(exact(0)), null);
  assert.equal(normalizePrediction(exact(101)), null);
  assert.equal(normalizePrediction(range(60, 40)), null);
  assert.equal(normalizePrediction(range(60, 101)), null);
  assert.equal(normalizePrediction({ kind: "nonsense" }), null);
  assert.equal(normalizePrediction(null), null);

  // And such a value scores nothing rather than being trusted.
  assert.equal(scorePrediction(exact(0), 50), 0);
  assert.equal(scorePrediction(range(60, 40), 50), 0);
});

// ── Five-round progression ───────────────────────────────────────────────

test("a match runs through five rounds and accumulates each round's scores", () => {
  let state = matchTargeting(50);

  const perRound = [
    // [my call, their call, target, expected my pts, expected their pts]
    [exact(50), exact(51), 50, 100, 0],
    [range(40, 49), range(41, 60), 50, 0, 5],
    [range(46, 50), range(1, 100), 50, 20, 1],
    [exact(10), exact(74), 74, 0, 100],
    [range(70, 79), range(70, 79), 74, 10, 10],
  ];

  let expectedMine = 0;
  let expectedTheirs = 0;

  perRound.forEach(([mine, theirs, target, myPts, theirPts], index) => {
    assert.equal(state.currentRound, index + 1, "round number advances by one");
    assert.equal(state.gameOver, false, "match is live before the last round");

    const { round, updatedState } = playRound(state, mine, theirs, target);

    expectedMine += myPts;
    expectedTheirs += theirPts;

    assert.equal(round.player1Score, myPts, `round ${index + 1} my points`);
    assert.equal(round.player2Score, theirPts, `round ${index + 1} their points`);
    assert.equal(round.resolved, true);
    assert.equal(round.target, target, "the round records the target it scored");
    assert.equal(updatedState.p1Score, expectedMine);
    assert.equal(updatedState.p2Score, expectedTheirs);

    state = updatedState;
  });

  assert.equal(state.gameOver, true);
  assert.equal(state.rounds.length, TOTAL_ROUNDS);
  assert.equal(state.currentRound, TOTAL_ROUNDS, "no sixth round is opened");
  assert.equal(state.p1Score, 130);
  assert.equal(state.p2Score, 116);
  assert.equal(state.winner, "player1");
});

test("each new round opens fresh with its own target and clue", () => {
  const state = matchTargeting(70);
  const { updatedState } = playRound(state, exact(70), exact(70), 70);

  assert.equal(updatedState.currentRound, 2);
  const live = currentRoundOf(updatedState);
  assert.equal(live.resolved, false);
  assert.equal(live.player1Prediction, null);
  assert.equal(live.player2Prediction, null);
  assert.equal(live.player1Score, null);
  assert.ok(typeof live.clue === "string" && live.clue.length > 0);
  assert.ok(updatedState.roundStartedAt >= state.roundStartedAt);
});

test("scores can only come from the resolver, never from a stored value", () => {
  const state = matchTargeting(30);
  // A tampered/forged score on the live round is overwritten on resolve.
  currentRoundOf(state).player1Score = 9999;
  currentRoundOf(state).player2Score = 9999;

  const { round, updatedState } = playRound(state, exact(30), exact(31), 30);
  assert.equal(round.player1Score, 100);
  assert.equal(round.player2Score, 0);
  assert.equal(updatedState.p1Score, 100);
  assert.equal(updatedState.p2Score, 0);
});

// ── Outcomes ─────────────────────────────────────────────────────────────

test("decideMatchWinner picks the higher cumulative score, or a draw", () => {
  assert.equal(decideMatchWinner(300, 200), "player1");
  assert.equal(decideMatchWinner(200, 300), "player2");
  assert.equal(decideMatchWinner(250, 250), null);
  assert.equal(decideMatchWinner(0, 0), null);
});

test("the match declares a winner, a loser, or a draw on the final round", () => {
  /** Play all five rounds with a per-round pair of calls. */
  const runMatch = (pairs) => {
    let state = matchTargeting(50);
    pairs.forEach(([mine, theirs, target], index) => {
      const isLast = index === pairs.length - 1;
      const { updatedState } = playRound(state, mine, theirs, target);
      if (!isLast) assert.equal(updatedState.winner, null);
      state = updatedState;
    });
    return state;
  };

  const win = runMatch([
    [exact(50), exact(1), 50],
    [exact(50), exact(2), 50],
    [exact(50), exact(3), 50],
    [exact(50), exact(4), 50],
    [exact(50), exact(5), 50],
  ]);
  assert.equal(win.gameOver, true);
  assert.equal(win.winner, "player1");

  const loss = runMatch([
    [exact(1), exact(50), 50],
    [exact(2), exact(50), 50],
    [exact(3), exact(50), 50],
    [exact(4), exact(50), 50],
    [exact(5), exact(50), 50],
  ]);
  assert.equal(loss.winner, "player2");

  const draw = runMatch([
    [range(45, 55), range(45, 55), 50],
    [exact(50), exact(50), 50],
    [range(1, 10), range(1, 10), 5],
    [range(90, 100), range(90, 100), 95],
    [exact(7), exact(7), 7],
  ]);
  assert.equal(draw.gameOver, true);
  assert.equal(draw.winner, null, "an exact tie is a draw, not a coin flip");
  assert.equal(draw.p1Score, draw.p2Score);
});

// ── Submission rules ─────────────────────────────────────────────────────

test("one submission per seat per round — locked in is locked in", () => {
  const state = matchTargeting(50);
  const first = submitPrediction(state, "player1", exact(50));
  assert.equal(first.roundComplete, false);
  assert.equal(hasSubmitted(first.updatedState, true), true);
  assert.equal(hasSubmitted(first.updatedState, false), false);
  assert.deepEqual(predictionOf(first.updatedState, true), exact(50));

  assert.throws(
    () => submitPrediction(first.updatedState, "player1", exact(51)),
    /already submitted/i,
  );

  // The other seat may still submit, and that completes the round.
  const second = submitPrediction(first.updatedState, "player2", range(40, 60));
  assert.equal(second.roundComplete, true);
});

test("an invalid prediction is refused before it can be stored", () => {
  const state = matchTargeting(50);
  assert.throws(() => submitPrediction(state, "player1", exact(0)), /between/i);
  assert.throws(
    () => submitPrediction(state, "player1", range(80, 20)),
    /between/i,
  );
  assert.equal(currentRoundOf(state).player1Prediction, null);
});

test("a round cannot resolve until both seats have called", () => {
  const state = matchTargeting(50);
  assert.throws(() => resolveRound(state), /both players/i);

  const mine = submitPrediction(state, "player1", exact(50));
  assert.throws(() => resolveRound(mine.updatedState), /both players/i);
});

test("nothing can be submitted or resolved after the match is over", () => {
  let state = matchTargeting(50);
  for (let i = 0; i < TOTAL_ROUNDS; i += 1) {
    state = playRound(state, exact(50), exact(50), 50).updatedState;
  }
  assert.equal(state.gameOver, true);

  assert.throws(() => submitPrediction(state, "player1", exact(50)), /over/i);
  assert.throws(() => resolveRound(state), /over/i);
});

// ── Secrecy ──────────────────────────────────────────────────────────────

test("the live round's target and the opponent's call never leave the server", () => {
  const state = matchTargeting(64);
  const submitted = submitPrediction(state, "player1", exact(64)).updatedState;

  const myView = viewForPlayer(submitted, true);
  const live = myView.rounds[myView.currentRound - 1];
  assert.equal(live.target, null, "the live target is withheld");
  assert.deepEqual(live.player1Prediction, exact(64), "my own call is visible");
  assert.equal(live.player2Prediction, null, "their pending call is withheld");
  assert.equal(live.player1Score, null);
  assert.equal(live.player2Score, null);
  assert.equal(myView.mySubmitted, true);
  assert.equal(myView.opponentSubmitted, false);

  // The opponent's own view sees THEIR call and not mine.
  const theirView = viewForPlayer(submitted, false);
  const theirLive = theirView.rounds[theirView.currentRound - 1];
  assert.equal(theirLive.player1Prediction, null);
  assert.equal(theirLive.player2Prediction, null);
  assert.equal(theirView.mySubmitted, false);

  // A raw serialization of my view contains neither the target nor their call.
  const serialized = JSON.stringify(myView);
  assert.ok(!serialized.includes('"target":64'));
});

test("a resolved round is public: target, both calls, both scores", () => {
  const state = matchTargeting(64);
  const { updatedState } = playRound(state, exact(64), range(61, 70), 64);

  const view = viewForPlayer(updatedState, true);
  // Round 1 resolved; round 2 is now live and still secret.
  const revealed = view.rounds[0];
  assert.equal(revealed.resolved, true);
  assert.equal(revealed.target, 64);
  assert.deepEqual(revealed.player1Prediction, exact(64));
  assert.deepEqual(revealed.player2Prediction, range(61, 70));
  assert.equal(revealed.player1Score, 100);
  assert.equal(revealed.player2Score, 10);

  const live = view.rounds[view.currentRound - 1];
  assert.equal(live.resolved, false);
  assert.equal(live.target, null);
});

// ── Clues ───────────────────────────────────────────────────────────────
//
// Clues are server-generated sentences derived from the round's target, and
// every one of them is checked here: the FORMAT (broad formats only in rounds
// 1–2, intervals later), the TRUTH of every boundary it states, the floor of
// MIN_CLUE_CANDIDATES survivors, and the absence of parity / exact reveals.

const CLUE_PATTERNS = {
  higher: /^Higher than (\d+)\.$/,
  lower: /^Lower than (\d+)\.$/,
  interval: /^Between (\d+) and (\d+), inclusive\.$/,
  "upper-half": /^Somewhere in the upper half\.$/,
  "lower-half": /^Somewhere in the lower half\.$/,
};

/** Read a clue back into what it CLAIMS, so the tests can check the claim. */
function readClue(text) {
  for (const [kind, pattern] of Object.entries(CLUE_PATTERNS)) {
    const match = pattern.exec(text);
    if (match) return { kind, bounds: match.slice(1).map(Number) };
  }
  return null;
}

test("clues are informative but never disclose the target", () => {
  for (let target = TARGET_MIN; target <= TARGET_MAX; target += 1) {
    for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
      const clue = createClue(target, round);
      assert.ok(clue.text.length > 0, `round ${round} target ${target} has text`);
      assert.ok(
        clue.candidates.length >= MIN_CLUE_CANDIDATES,
        `round ${round} target ${target} left ${clue.candidates.length} candidates`,
      );
      assert.ok(
        clue.candidates.includes(target),
        `round ${round} clue must include its own target`,
      );
      assert.ok(
        clue.candidates.length < TARGET_MAX - TARGET_MIN + 1,
        `round ${round} clue must narrow the domain`,
      );
    }
  }
});

test("every clue is a recognised sentence, and every boundary it states is true", () => {
  for (let target = TARGET_MIN; target <= TARGET_MAX; target += 1) {
    for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
      const clue = createClue(target, round);
      const read = readClue(clue.text);
      assert.ok(
        read,
        `unrecognised clue "${clue.text}" (round ${round}, target ${target})`,
      );
      assert.equal(clue.kind, read.kind, "the reported kind matches the text");
      assert.ok(
        clue.candidates.includes(target),
        `"${clue.text}" must admit its own target ${target}`,
      );

      if (read.kind === "higher") {
        const [bound] = read.bounds;
        assert.ok(target > bound, `"${clue.text}" is a lie about ${target}`);
        assert.equal(clue.candidates.length, TARGET_MAX - bound);
        assert.ok(clue.candidates.every((n) => n > bound));
      } else if (read.kind === "lower") {
        const [bound] = read.bounds;
        assert.ok(target < bound, `"${clue.text}" is a lie about ${target}`);
        assert.equal(clue.candidates.length, bound - TARGET_MIN);
        assert.ok(clue.candidates.every((n) => n < bound));
      } else if (read.kind === "interval") {
        const [min, max] = read.bounds;
        assert.ok(min >= TARGET_MIN && max <= TARGET_MAX);
        assert.ok(min <= target && target <= max, `"${clue.text}" misses ${target}`);
        assert.equal(clue.candidates.length, max - min + 1);
        assert.equal(clue.candidates[0], min);
        assert.equal(clue.candidates[clue.candidates.length - 1], max);
      } else if (read.kind === "lower-half") {
        assert.ok(target <= 50, `lower half is wrong for ${target}`);
        assert.deepEqual(
          clue.candidates,
          Array.from({ length: 50 }, (_, i) => i + 1),
        );
      } else {
        assert.ok(target > 50, `upper half is wrong for ${target}`);
        assert.equal(clue.candidates.length, 50);
        assert.equal(clue.candidates[0], 51);
        assert.equal(clue.candidates[49], 100);
      }
    }
  }
});

test("boundary targets still get a truthful, ambiguous clue", () => {
  for (const target of [1, 2, 5, 50, 51, 95, 99, 100]) {
    for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
      const clue = createClue(target, round);
      assert.ok(readClue(clue.text), `round ${round} target ${target}`);
      assert.ok(clue.candidates.includes(target));
      assert.ok(
        clue.candidates.length >= MIN_CLUE_CANDIDATES,
        `edge target ${target} in round ${round} left ${clue.candidates.length}`,
      );
    }
  }
});

test("rounds 1–2 use only the four broad formats", () => {
  const broad = new Set(["higher", "lower", "upper-half", "lower-half"]);
  for (let target = TARGET_MIN; target <= TARGET_MAX; target += 1) {
    for (const round of [1, 2]) {
      const clue = createClue(target, round);
      assert.ok(
        broad.has(clue.kind),
        `round ${round} used a ${clue.kind} clue ("${clue.text}")`,
      );
      // "Broad" means a wide field is left standing.
      assert.ok(
        clue.candidates.length >= 30,
        `round ${round} clue "${clue.text}" left only ${clue.candidates.length}`,
      );
      // No parity, divisibility or exact-number hints, ever.
      assert.doesNotMatch(clue.text, /even|odd|divisible|remainder/i);
      assert.doesNotMatch(clue.text, /^Between/);
    }
  }
});

test("the clue narrows as the match progresses", () => {
  for (const target of [1, 3, 17, 42, 50, 51, 78, 99, 100]) {
    const width = (round) => createClue(target, round).candidates.length;
    const [r1, r2, r3, r4, r5] = [1, 2, 3, 4, 5].map(width);

    assert.ok(r1 >= 40 && r1 <= 60, `round 1 left ${r1}`);
    assert.ok(
      (r2 >= 30 && r2 <= 45) || r2 === 50,
      `round 2 left ${r2}`,
    );
    assert.ok(r3 >= 16 && r3 <= 30, `round 3 left ${r3}`);
    assert.ok(r4 >= 9 && r4 <= 16, `round 4 left ${r4}`);
    assert.ok(r5 >= 5 && r5 <= 9, `round 5 left ${r5}`);

    // The ladder never gets WIDER, round to round.
    assert.ok(r2 >= r3, `round 3 (${r3}) widened past round 2 (${r2})`);
    assert.ok(r3 >= r4, `round 4 (${r4}) widened past round 3 (${r3})`);
    assert.ok(r4 >= r5, `round 5 (${r5}) widened past round 4 (${r4})`);
    // And the last round is genuinely tighter than the first.
    assert.ok(r1 > r5);
  }
});

test("round 3 offers the moderate formats; rounds 4–5 are intervals only", () => {
  const round3 = new Set();
  for (let target = TARGET_MIN; target <= TARGET_MAX; target += 1) {
    const moderate = createClue(target, 3);
    assert.ok(
      ["higher", "lower", "interval"].includes(moderate.kind),
      `round 3 used ${moderate.kind}`,
    );
    round3.add(moderate.kind);

    for (const round of [4, 5]) {
      const late = createClue(target, round);
      assert.equal(late.kind, "interval", `round ${round} target ${target}`);
      assert.match(late.text, CLUE_PATTERNS.interval);
    }
  }
  assert.ok(round3.size >= 2, `round 3 only produced ${[...round3]}`);
});

test("a clue is deterministic for the same target, round and seed", () => {
  for (const target of [7, 42, 88]) {
    for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
      assert.deepEqual(createClue(target, round), createClue(target, round));

      const seed = target * 31 + round;
      assert.deepEqual(
        createClue(target, round, seededUnitSource(seed)),
        createClue(target, round, seededUnitSource(seed)),
      );
    }
  }
});

test("an injected source picks among legal clues, never an illegal one", () => {
  const seen = new Set();
  for (let seed = 0; seed < 60; seed += 1) {
    const clue = createClue(50, 1, seededUnitSource(seed + 1));
    assert.ok(clue.candidates.includes(50));
    assert.ok(clue.candidates.length >= MIN_CLUE_CANDIDATES);
    assert.ok(readClue(clue.text));
    seen.add(clue.text);
  }
  assert.ok(seen.size > 1, "the boundary should vary between seeds");
});

test("a round stores the sentence for its own target and no clue metadata", () => {
  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    for (let i = 0; i < 40; i += 1) {
      const created = createRound(round);
      assert.equal(created.clue, createClue(created.target, round).text);
      assert.equal("kind" in created, false);
      assert.equal("candidates" in created, false);
    }
  }
});

test("a prediction cannot smuggle a clue or a target into the state", () => {
  const state = matchTargeting(50);
  const clueBefore = currentRoundOf(state).clue;

  const { updatedState } = submitPrediction(state, "player1", {
    kind: "exact",
    value: 50,
    // Nothing a client sends may be copied onto the round.
    clue: "Between 50 and 50, inclusive.",
    target: 50,
    score: 100,
  });

  assert.equal(currentRoundOf(updatedState).clue, clueBefore);
  assert.equal(currentRoundOf(updatedState).target, 50);
  assert.deepEqual(predictionOf(updatedState, true), exact(50));
});

// ── AI entry point ───────────────────────────────────────────────────────

test("an AI round resolves on the human's single submission", () => {
  const state = matchTargeting(50);
  const { round, updatedState } = submitAIPrediction(
    state,
    exact(50),
    "normal",
    // The bot hits: offset 0 inside a 20-wide window that contains 50.
    () => 0,
  );

  assert.equal(round.resolved, true);
  assert.equal(round.player1Score, 100);
  assert.ok(round.player2Prediction, "the bot made a call");
  assert.ok(
    ["player1", "player2"].includes(
      round.player2Score === 0 ? "player1" : "player2",
    ),
  );
  assert.equal(updatedState.currentRound, 2);
  assert.equal(updatedState.gameOver, false);
  assert.equal(updatedState.p1Score, 100);
});

test("the AI plays the same five rounds to the same outcome", () => {
  let state = matchTargeting(50);
  for (let i = 0; i < TOTAL_ROUNDS; i += 1) {
    currentRoundOf(state).target = 50;
    // Always an exact hit: the bot cannot beat a perfect human.
    const { updatedState } = submitAIPrediction(state, exact(50), "hard", () => 0.5);
    state = updatedState;
  }
  assert.equal(state.gameOver, true);
  assert.equal(state.rounds.length, TOTAL_ROUNDS);
  assert.equal(state.p1Score, 500);
  assert.ok(state.p2Score <= 500);
  assert.equal(
    state.winner,
    state.p1Score > state.p2Score
      ? "player1"
      : state.p2Score > state.p1Score
        ? "player2"
        : null,
  );
});

test("submitAIPick is the same resolver as submitAIPrediction", () => {
  const a = submitAIPick(matchTargeting(30), exact(30), "easy", () => 0);
  const b = submitAIPrediction(matchTargeting(30), exact(30), "easy", () => 0);
  // The freshly opened round 2 draws its own random target, so compare what
  // the resolver decided: the resolved round and the running totals.
  // The two calls resolve the same round; only the clock may differ.
  assert.deepEqual({ ...a.round, resolvedAt: 0 }, { ...b.round, resolvedAt: 0 });
  assert.equal(a.updatedState.p1Score, b.updatedState.p1Score);
  assert.equal(a.updatedState.p2Score, b.updatedState.p2Score);
  assert.equal(a.updatedState.currentRound, b.updatedState.currentRound);
});

test("every bot tier produces a legal, in-domain prediction", () => {
  for (const tier of ["easy", "normal", "hard", "bogus", undefined]) {
    for (let i = 0; i < 300; i += 1) {
      const target = TARGET_MIN + (i % (TARGET_MAX - TARGET_MIN + 1));
      const prediction = botPrediction(target, tier);
      assert.ok(normalizePrediction(prediction), `${tier} produced an illegal call`);
      if (prediction.kind === "exact") {
        assert.ok(prediction.value >= TARGET_MIN && prediction.value <= TARGET_MAX);
      } else {
        assert.ok(prediction.min >= TARGET_MIN);
        assert.ok(prediction.max <= TARGET_MAX);
        assert.ok(prediction.min <= prediction.max);
      }
    }
  }
});

test("the bot's call is made against the target it can see, but only via its tier", () => {
  // Easy never lands an exact call; hard occasionally does.
  const easyExact = Array.from({ length: 200 }, () =>
    botPrediction(50, "easy", () => 0.05),
  ).filter((p) => p.kind === "exact");
  assert.equal(easyExact.length, 0);

  const hardExact = Array.from({ length: 200 }, () =>
    botPrediction(50, "hard", () => 0.01),
  ).filter((p) => p.kind === "exact");
  assert.ok(hardExact.length > 0, "hard may fire an exact call");
});

// ── Retired rows ─────────────────────────────────────────────────────────

test("a row from the retired rules is recognised as unplayable", () => {
  const legacy = {
    phase: "predict",
    currentRound: 2,
    totalRounds: 6,
    currentMax: 25,
    rounds: [
      { player1Number: 4, player2Number: 9, player1Prediction: 9, player2Prediction: 4 },
    ],
  };
  assert.equal(isCurrentOddsState(legacy), false);
  assert.equal(isCurrentOddsState(null), false);
  assert.equal(isCurrentOddsState("nope"), false);
  assert.equal(isCurrentOddsState({}), false);

  assert.equal(isCurrentOddsState(initPvPOddsGame()), true);
  // A current-version state with a truncated payload is still refused.
  const broken = initPvPOddsGame();
  broken.rounds[0].clue = null;
  assert.equal(isCurrentOddsState(broken), false);
});

// ── Presentation helper ──────────────────────────────────────────────────

test("a call reads the same way everywhere it is shown", () => {
  assert.equal(describePrediction(exact(42)), "exact 42");
  assert.equal(describePrediction(range(40, 50)), "40–50");
  assert.equal(describePrediction(range(7, 7)), "7–7");
  assert.equal(describePrediction(null), "—");
  assert.equal(describePrediction(exact(0)), "—");
});
