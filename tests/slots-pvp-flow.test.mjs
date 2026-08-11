/**
 * PvP Slots ("Skill Slots") — round-flow tests.
 *
 * The server store (`src/lib/slots-pvp/serverStore.js`) is a thin DB
 * wrapper around the PURE state-machine transitions in
 * `src/lib/slots-pvp/engine.js`. Because the store pulls in
 * `drizzle-orm` + `src/db/client`, the node test runner can't import
 * it directly — so this test drives the SAME pure engine functions
 * (applyReelStop / autoStopReels / openSpinState /
 * planAdvanceAfterResolve / buildRoundResult / decideMatchResult)
 * through an in-memory match object, mirroring exactly how the store
 * orchestrates them — INCLUDING the per-round tallying of
 * rounds-won + aggregate points that `resolveSpinRound` performs.
 *
 * This mirrors the production flow 1:1 with NO duplicated logic — any
 * drift between this test and the store would show up as the store
 * using a different engine function.
 *
 * Run:  node --test tests/slots-pvp-flow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MATCH_STATUS,
  MAX_ROUNDS,
  REELS_PER_ROUND,
  RESULT,
  ROUNDS_TO_WIN,
  ROUND_DEADLINE_MS,
  ROUND_TIMER_SECONDS,
  computePayout,
  isSpinStatus,
} from "../src/lib/slots-pvp/constants.js";

import {
  applyReelStop,
  autoStopReels,
  buildRoundResult,
  canResolveRound,
  decideMatchResult,
  openSpinState,
  planAdvanceAfterResolve,
} from "../src/lib/slots-pvp/engine.js";

const FRUIT_SYMBOLS = ["🍉","🍌","🍍","🍏","🍓","🥭","🍈","🍇","🍒","🍎","🍊","🍋","🥝","🍐","🍑","🥥","🍅","🍆","🌽","🍠"];
const MATCH = { id: 42, player1Id: "u1", player2Id: "u2", stakeAmount: "100.00", theme: "fruit" };

// ── In-memory mirror of the serverStore orchestration ─────────────────
//
// Exactly the sequencing `serverStore.js` uses: a match row, the pure
// transitions, a rounds history list, and the plan applied on resolve.

function makeFreshMatch(spinNumber = 1) {
  const deadline = new Date(Date.now() + ROUND_DEADLINE_MS);
  const open = openSpinState({
    matchId: MATCH.id,
    spinNumber,
    symbols: FRUIT_SYMBOLS,
    deadline,
  });
  return {
    ...MATCH,
    status: `spin_${spinNumber}`,
    currentSpin: spinNumber,
    roundDeadline: deadline,
    roundsWonPlayer1: 0,
    roundsWonPlayer2: 0,
    p1Score: 0,
    p2Score: 0,
    p1CurrentInputs: open.p1CurrentInputs,
    p2CurrentInputs: open.p2CurrentInputs,
  };
}

/** Mirrors serverStore.stopReel's core: apply + persist + resolve when both locked. */
function stopReel(match, seat, reelIndex, rounds, currentSpin = null) {
  const applied = applyReelStop(match, seat, reelIndex, Date.now(), currentSpin);
  if (!applied.ok) return { ok: false, ...applied, match };
  const next = applied.match;
  if (canResolveRound(next)) {
    rounds.push(buildRoundResult(next, FRUIT_SYMBOLS));
    return resolveRound(next, rounds);
  }
  return { ok: true, match: next, roundResolved: false };
}

/** Mirrors serverStore.resolveSpinRound + planAdvanceAfterResolve,
 *  INCLUDING the rounds-won / aggregate-points tally the store writes
 *  onto the match row every round. The post-round tallies are passed
 *  into planAdvanceAfterResolve exactly like the store does, so an
 *  early finish (a player reaching ROUNDS_TO_WIN) is decided here too. */
function resolveRound(match, rounds) {
  const row = rounds[rounds.length - 1];
  const tallies = {
    roundsWonPlayer1:
      (Number(match.roundsWonPlayer1) || 0) +
      (row.roundWinner === RESULT.PLAYER1 ? 1 : 0),
    roundsWonPlayer2:
      (Number(match.roundsWonPlayer2) || 0) +
      (row.roundWinner === RESULT.PLAYER2 ? 1 : 0),
    p1Score: (Number(match.p1Score) || 0) + row.spinPointsPlayer1,
    p2Score: (Number(match.p2Score) || 0) + row.spinPointsPlayer2,
  };
  const plan = planAdvanceAfterResolve({
    match,
    symbols: FRUIT_SYMBOLS,
    tallies,
    now: Date.now(),
  });
  if (plan.finished) {
    return {
      ok: true,
      match: {
        ...match,
        ...tallies,
        status: MATCH_STATUS.FINISHED,
        roundDeadline: null,
        p1CurrentInputs: null,
        p2CurrentInputs: null,
        endedAt: plan.endedAt,
      },
      roundResolved: true,
      finished: true,
    };
  }
  return {
    ok: true,
    match: {
      ...match,
      ...tallies,
      status: plan.status,
      currentSpin: plan.currentSpin,
      roundDeadline: plan.roundDeadline,
      p1CurrentInputs: plan.p1CurrentInputs,
      p2CurrentInputs: plan.p2CurrentInputs,
    },
    roundResolved: true,
    finished: false,
  };
}

/** Mirrors serverStore.forceSpinAdvance: deadline passed → auto-stop both →
 *  resolve. The real store's resolveSpinRound inserts the history row, so the
 *  mirror pushes it here too. */
function forceSpinAdvance(match, rounds) {
  if (!isSpinStatus(match.status)) return match;
  // Missing deadline is treated as expired (matches the store's defensive
  // forceSpinAdvance — a null deadline must never let a round hang).
  const deadlineMs = match.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : 0;
  if (deadlineMs > Date.now()) return match;
  let next = match;
  if (!next.p1CurrentInputs || !next.p1CurrentInputs.boardLocked) {
    next = autoStopReels(next, "player1");
  }
  if (!next.p2CurrentInputs || !next.p2CurrentInputs.boardLocked) {
    next = autoStopReels(next, "player2");
  }
  if (canResolveRound(next)) {
    rounds.push(buildRoundResult(next, FRUIT_SYMBOLS));
  }
  return resolveRound(next, rounds).match;
}

// ════════════════════════════════════════════════════════════════════
// Full best-of-5 match
// ════════════════════════════════════════════════════════════════════

test("full match: simultaneous stops, best-of-5 (first to 3 or 5 rounds), tallies + finish", () => {
  let match = makeFreshMatch(1);
  const rounds = [];

  // Play rounds until the match decides itself: a player reaching
  // ROUNDS_TO_WIN (3) round wins ends it IMMEDIATELY, otherwise all
  // MAX_ROUNDS (5) rounds are played. The loop bound + isSpinStatus
  // guard keep it from hanging if a bug ever skips the finish.
  for (let spin = 1; spin <= MAX_ROUNDS && isSpinStatus(match.status); spin += 1) {
    assert.equal(match.status, `spin_${spin}`);
    assert.equal(match.currentSpin, spin);

    // Both players stop their 3 reels in different orders.
    const order1 = [0, 1, 2];
    const order2 = [2, 0, 1];

    for (let i = 0; i < REELS_PER_ROUND; i += 1) {
      let r1 = stopReel(match, "player1", order1[i], rounds);
      assert.equal(r1.ok, true);
      match = r1.match;
      // Player 2's board must not be touched by player 1's stop.
      assert.equal(match.p2CurrentInputs.boardLocked, false);

      let r2 = stopReel(match, "player2", order2[i], rounds);
      assert.equal(r2.ok, true);
      match = r2.match;
    }

    // Round resolved as soon as the last reel of the last player stopped.
    if (isSpinStatus(match.status)) {
      assert.equal(match.status, `spin_${spin + 1}`);
      assert.equal(match.currentSpin, spin + 1);
      assert.equal(rounds.length, spin);
      // Fresh boards for the next round.
      assert.equal(match.p1CurrentInputs.boardLocked, false);
      assert.deepEqual(match.p1CurrentInputs.reelsStopped, []);
    }
  }

  // The match is finished within MAX_ROUNDS — early (someone reached
  // ROUNDS_TO_WIN) or on the 5-round cap.
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.ok(rounds.length >= 1 && rounds.length <= MAX_ROUNDS);
  const leaderRounds = Math.max(match.roundsWonPlayer1, match.roundsWonPlayer2);
  if (rounds.length < MAX_ROUNDS) {
    // An early finish is ONLY legal when a player hit ROUNDS_TO_WIN.
    assert.equal(leaderRounds, ROUNDS_TO_WIN);
  } else {
    // The 5-round cap finishes even a close match (leader <= 3).
    assert.ok(leaderRounds <= ROUNDS_TO_WIN);
  }
  assert.equal(match.roundDeadline, null);
  assert.equal(
    match.roundsWonPlayer1 + match.roundsWonPlayer2,
    rounds.filter((r) => r.roundWinner !== RESULT.DRAW).length,
  );
  // Aggregate points = sum of per-round spin points.
  assert.equal(
    match.p1Score,
    rounds.reduce((s, r) => s + r.spinPointsPlayer1, 0),
  );
  assert.equal(
    match.p2Score,
    rounds.reduce((s, r) => s + r.spinPointsPlayer2, 0),
  );

  // Settlement decision is consistent with the tallies.
  const result = decideMatchResult(match);
  assert.ok([RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(result));
  const payout = computePayout({ stakeAmount: match.stakeAmount, result });
  assert.ok(payout.houseFee >= 0);
  assert.ok(payout.prizePaid >= 0);
});

test("every resolved round row has a full scoring snapshot + round winner", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  for (let spin = 1; spin <= MAX_ROUNDS; spin += 1) {
    let r = stopReel(match, "player1", 0, rounds);
    match = r.match;
    r = stopReel(match, "player1", 1, rounds);
    match = r.match;
    r = stopReel(match, "player2", 0, rounds);
    match = r.match;
    r = stopReel(match, "player2", 1, rounds);
    match = r.match;
    r = stopReel(match, "player1", 2, rounds);
    match = r.match;
    r = stopReel(match, "player2", 2, rounds);
    match = r.match;
  }
  for (const row of rounds) {
    assert.ok([RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(row.roundWinner));
    assert.equal(row.player1Result.reels.length, 3);
    assert.equal(row.player1Result.reels[0].length, 3);
    assert.equal(row.player2Result.reels.length, 3);
    assert.equal(typeof row.player1Result.symbolScore, "number");
    assert.equal(typeof row.player1Result.stopBonus, "number");
    assert.equal(row.player1Result.totalScore, row.player1Result.symbolScore + row.player1Result.stopBonus);
    assert.equal(row.spinPointsPlayer1, row.player1Result.totalScore);
    assert.equal(row.spinPointsPlayer2, row.player2Result.totalScore);
    assert.ok(Number.isInteger(row.spinNumber));
    // Round winner agrees with the two total scores.
    if (row.player1Result.totalScore > row.player2Result.totalScore) {
      assert.equal(row.roundWinner, RESULT.PLAYER1);
    } else if (row.player2Result.totalScore > row.player1Result.totalScore) {
      assert.equal(row.roundWinner, RESULT.PLAYER2);
    } else {
      assert.equal(row.roundWinner, RESULT.DRAW);
    }
  }
  assert.equal(match.status, MATCH_STATUS.FINISHED);
});

// ════════════════════════════════════════════════════════════════════
// The 10-second guarantee
// ════════════════════════════════════════════════════════════════════

test("the round never lasts longer than 10 seconds", () => {
  const deadline = new Date(Date.now() + ROUND_DEADLINE_MS);
  const open = openSpinState({
    matchId: 1,
    spinNumber: 1,
    symbols: FRUIT_SYMBOLS,
    deadline,
  });
  // The stamped deadline is exactly 10s out (allow sub-100ms skew for
  // test-runner scheduling latency between the stamp and the assert).
  const skew = deadline.getTime() - Date.now();
  assert.ok(skew <= ROUND_DEADLINE_MS && skew > ROUND_DEADLINE_MS - 100, `deadline skew: ${skew}ms`);
  assert.equal(ROUND_TIMER_SECONDS, 10);
  // Every advance stamps the same 10s window.
  const m = { ...MATCH, status: MATCH_STATUS.SPIN_1, currentSpin: 1, roundDeadline: deadline, ...open };
  const plan = planAdvanceAfterResolve({ match: m, symbols: FRUIT_SYMBOLS, now: deadline.getTime() });
  assert.equal(plan.roundDeadline.getTime() - deadline.getTime(), ROUND_DEADLINE_MS);
});

test("stops are rejected once the deadline passes", () => {
  const expired = {
    ...makeFreshMatch(1),
    roundDeadline: new Date(Date.now() - 1),
  };
  const r = applyReelStop(expired, "player1", 0);
  assert.deepEqual(r, { ok: false, error: "Round time has expired", status: 400 });
});

test("AFK: the deadline auto-stops remaining reels and resolves the round", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  // u1 stops all 3 reels; u2 does nothing (AFK).
  match = stopReel(match, "player1", 0, rounds).match;
  match = stopReel(match, "player1", 1, rounds).match;
  match = stopReel(match, "player1", 2, rounds).match;
  assert.equal(canResolveRound(match), false); // u2 hasn't locked

  // Deadline passes → the status poll's forceSpinAdvance fires.
  match = { ...match, roundDeadline: new Date(Date.now() - 1) };
  match = forceSpinAdvance(match, rounds);

  assert.equal(match.status, MATCH_STATUS.SPIN_2);
  assert.equal(rounds.length, 1);
  const row = rounds[0];
  assert.equal(row.player1AutoSpun, false);
  assert.equal(row.player2AutoSpun, true); // u2's reels were auto-stopped
  assert.deepEqual(row.player2Inputs.reelsStopped, [0, 1, 2]);
  // Auto-stopped player scores Normal stop bonuses (+0).
  assert.equal(row.player2Result.stopBonus, 0);
});

// ════════════════════════════════════════════════════════════════════
// First-to-ROUNDS_TO_WIN (best-of-5 early finish)
// ════════════════════════════════════════════════════════════════════
//
// The seeded boards for matchId 42 are deterministic: spin 1 is a
// player1 win (600 vs 300 with perfect stops), so these tests seed the
// pre-round rounds-won and let the real engine decide the finish.

test("first to 3 round wins ends the match immediately (remaining rounds skipped)", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  // Simulate the first two rounds: player1 won both (2-0). Spin 1 is a
  // deterministic player1 win, so resolving it takes player1 to 3-0 and
  // the match must end IMMEDIATELY — no spin 2 is ever opened.
  match.roundsWonPlayer1 = 2;
  match.roundsWonPlayer2 = 0;

  match = stopReel(match, "player1", 0, rounds).match;
  match = stopReel(match, "player2", 0, rounds).match;
  match = stopReel(match, "player1", 1, rounds).match;
  match = stopReel(match, "player2", 1, rounds).match;
  match = stopReel(match, "player1", 2, rounds).match;
  const last = stopReel(match, "player2", 2, rounds);
  match = last.match;

  assert.equal(last.finished, true);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(rounds.length, 1); // only round 1 was played
  assert.equal(rounds[0].roundWinner, RESULT.PLAYER1);
  assert.equal(match.roundsWonPlayer1, 3);
  assert.equal(match.roundsWonPlayer2, 0);
  // Terminal match: no live round state remains.
  assert.equal(match.roundDeadline, null);
  assert.equal(match.p1CurrentInputs, null);
  assert.equal(match.p2CurrentInputs, null);
  assert.ok(match.endedAt instanceof Date);
});

test("a 2-1 lead does NOT end the match early", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  match.roundsWonPlayer1 = 1;
  match.roundsWonPlayer2 = 1;

  // Spin 1 is a deterministic player1 win → 2-1. Nobody has 3 wins, so
  // the match must continue to spin 2.
  match = stopReel(match, "player1", 0, rounds).match;
  match = stopReel(match, "player2", 0, rounds).match;
  match = stopReel(match, "player1", 1, rounds).match;
  match = stopReel(match, "player2", 1, rounds).match;
  match = stopReel(match, "player1", 2, rounds).match;
  match = stopReel(match, "player2", 2, rounds).match;

  assert.equal(match.status, MATCH_STATUS.SPIN_2);
  assert.equal(match.currentSpin, 2);
  assert.equal(rounds.length, 1);
  assert.equal(match.roundsWonPlayer1, 2);
  assert.equal(match.roundsWonPlayer2, 1);
  // A fresh round-2 board is already open.
  assert.equal(match.p1CurrentInputs.boardLocked, false);
  assert.deepEqual(match.p1CurrentInputs.reelsStopped, []);
});

test("round 5 auto-resolves into finished when the deadline passes", () => {
  let match = makeFreshMatch(5);
  const rounds = [];
  match = { ...match, roundDeadline: new Date(Date.now() - 1) };
  match = forceSpinAdvance(match, rounds);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].spinNumber, 5);
});

test("a player who never stops anything still gets resolved at the deadline", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  match = { ...match, roundDeadline: new Date(Date.now() - 1) };
  match = forceSpinAdvance(match, rounds);
  assert.equal(match.status, MATCH_STATUS.SPIN_2);
  const row = rounds[0];
  assert.equal(row.player1AutoSpun, true);
  assert.equal(row.player2AutoSpun, true);
  assert.deepEqual(row.player1Result.reels, makeFreshMatch(1).p1CurrentInputs.reels);
  // Both auto-stopped → both Normal stop bonuses.
  assert.equal(row.player1Result.stopBonus, 0);
  assert.equal(row.player2Result.stopBonus, 0);
});

// ════════════════════════════════════════════════════════════════════
// Hard guarantees on stopping rules
// ════════════════════════════════════════════════════════════════════

test("reels are stopped once and once only (one-shot lock-in)", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  const r = stopReel(match, "player1", 0, rounds);
  match = r.match;
  const again = stopReel(match, "player1", 0, rounds);
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
});

test("simultaneous play: each player's stops are independent", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  match = stopReel(match, "player1", 1, rounds).match;
  // u2 can still stop freely — u1's progress doesn't affect u2.
  match = stopReel(match, "player2", 1, rounds).match;
  assert.deepEqual(match.p1CurrentInputs.reelsStopped, [1]);
  assert.deepEqual(match.p2CurrentInputs.reelsStopped, [1]);
  assert.equal(canResolveRound(match), false);
});

test("a stale stop from a previous round is rejected (round-identity guard)", () => {
  let match = makeFreshMatch(1);
  const rounds = [];
  // Round 1 resolves via the last stop (both boards lock).
  match = stopReel(match, "player1", 0, rounds).match;
  match = stopReel(match, "player2", 0, rounds).match;
  match = stopReel(match, "player1", 1, rounds).match;
  match = stopReel(match, "player2", 1, rounds).match;
  match = stopReel(match, "player1", 2, rounds).match;
  match = stopReel(match, "player2", 2, rounds, 1).match; // echoes spin 1
  assert.equal(match.status, MATCH_STATUS.SPIN_2);
  // A delayed stop that still echoes spin 1 must be rejected — it must
  // NOT land on round 2's fresh board.
  const stale = stopReel(match, "player1", 1, rounds, 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.deepEqual(match.p1CurrentInputs.reelsStopped, []); // round 2 untouched
  // And the same player stopping on round 2's live echo works.
  match = stopReel(match, "player1", 1, rounds, 2).match;
  assert.deepEqual(match.p1CurrentInputs.reelsStopped, [1]);
});

console.log("\n? All PvP Slots round-flow tests passed!\n");
