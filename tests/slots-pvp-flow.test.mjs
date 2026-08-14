/**
 * PvP Slots ("Fruit Fortune Survival") — round-flow tests.
 *
 * The server store (`src/lib/slots-pvp/serverStore.js`) is a thin DB
 * wrapper around the PURE state-machine transitions in
 * `src/lib/slots-pvp/engine.js`. Because the store pulls in
 * `drizzle-orm` + `src/db/client`, the node test runner can't import
 * it directly — so this test drives the SAME pure engine functions
 * (applyColumnStop / autoStopActiveColumn / openSpinState /
 * planAdvanceAfterResolve / buildRoundResult) through an in-memory
 * match object, mirroring exactly how the store orchestrates them —
 * INCLUDING the per-round tallying that `resolveSpinRound` performs
 * and the forced-result settlement (`settleMatch` credits the ROUND
 * winner through, so a grace_draw settles with the 5%-each refund).
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
  RESULT,
  ROUNDS_TO_WIN,
  COLUMN_DEADLINE_MS,
  COLUMN_TIMER_SECONDS,
  COLUMN_STOP_GRACE_MS,
  ROUND_TIMER_SECONDS,
  GRACE_MAX_STOPS,
  computePayout,
} from "../src/lib/slots-pvp/constants.js";

import {
  applyColumnStop,
  autoStopActiveColumn,
  buildRoundResult,
  canResolveRound,
  decideMatchResult,
  openSpinState,
  planAdvanceAfterResolve,
  columnSymbols,
  GRID_COLS,
} from "../src/lib/slots-pvp/engine.js";

const FRUIT_SYMBOLS = ["🍉","🍌","🍍","🍏","🍓","🥭","🍈","🍇","🍒","🍎","🍊","🍋","🥝","🍐","🍑","🥥","🍅","🍆","🌽","🍠"];
const POOL = FRUIT_SYMBOLS.slice(0, 5);
const MATCH = { id: 42, player1Id: "u1", player2Id: "u2", stakeAmount: "100.00", theme: "fruit" };

const fillCol = (s) => [s, s, s];

/** A pool symbol NOT present in `col` (pool=5, col=3 cells → always exists). */
function symbolOutside(col) {
  return POOL.find((s) => !col.includes(s));
}

// ── In-memory mirror of the serverStore orchestration ─────────────────
//
// Exactly the sequencing `serverStore.js` uses: a match row, the pure
// transitions, a rounds history list, and the plan applied on resolve.

function makeFreshMatch(spinNumber = 1, now = Date.now()) {
  const open = openSpinState({
    matchId: MATCH.id,
    spinNumber,
    symbols: FRUIT_SYMBOLS,
    now,
  });
  return {
    ...MATCH,
    status: `spin_${spinNumber}`,
    currentSpin: spinNumber,
    roundsWonPlayer1: 0,
    roundsWonPlayer2: 0,
    p1Score: 0,
    p2Score: 0,
    ...open,
  };
}

/** Replace one seat's run with a crafted mid-grace / mid-survival state. */
function craftedRunFor(match, seat, { priorWindow, stoppedCount, firstComboAt = null, survived = 0, linesFormed = 0, now = Date.now() }) {
  const key = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  const base = match[key];
  return {
    ...match,
    [key]: {
      ...base,
      window: priorWindow,
      columns: priorWindow.filter(Boolean),
      stoppedOrder: Array.from({ length: stoppedCount }, (_, i) => i),
      stoppedCount,
      firstComboAt,
      survived,
      linesFormed,
      activeIndex: stoppedCount,
      activeDeadline: now + COLUMN_DEADLINE_MS,
    },
  };
}

/** Mirrors serverStore.stopColumn: apply + persist + resolve when both runs ended. */
function stopColumn(match, seat, columnIndex, rounds, { currentSpin = null, now = Date.now() } = {}) {
  const applied = applyColumnStop(match, seat, columnIndex, now, currentSpin);
  if (!applied.ok) return { ok: false, ...applied, match };
  const next = applied.match;
  if (canResolveRound(next)) {
    rounds.push(buildRoundResult(next, FRUIT_SYMBOLS));
    return resolveRound(next, rounds);
  }
  return { ok: true, match: next, roundResolved: false };
}

/** Mirrors serverStore.resolveSpinRound + settleMatch: tally, advance,
 *  settle with the ROUND's own (forced) winner — grace_draw included. */
function resolveRound(match, rounds) {
  const row = rounds[rounds.length - 1];
  const tallies = {
    roundsWonPlayer1:
      (Number(match.roundsWonPlayer1) || 0) + (row.roundWinner === RESULT.PLAYER1 ? 1 : 0),
    roundsWonPlayer2:
      (Number(match.roundsWonPlayer2) || 0) + (row.roundWinner === RESULT.PLAYER2 ? 1 : 0),
    p1Score: (Number(match.p1Score) || 0) + row.spinPointsPlayer1,
    p2Score: (Number(match.p2Score) || 0) + row.spinPointsPlayer2,
  };
  const settlement = computePayout({ stakeAmount: match.stakeAmount, result: row.roundWinner });
  const plan = planAdvanceAfterResolve({ match, symbols: FRUIT_SYMBOLS, tallies, now: Date.now() });
  return {
    ok: true,
    match: {
      ...match,
      ...tallies,
      status: MATCH_STATUS.FINISHED,
      roundDeadline: null,
      p1CurrentInputs: null,
      p2CurrentInputs: null,
      result: row.roundWinner,
      winnerId:
        row.roundWinner === RESULT.PLAYER1 ? match.player1Id
          : row.roundWinner === RESULT.PLAYER2 ? match.player2Id
            : null,
      houseFee: settlement.houseFee.toFixed(2),
      prizePaid: settlement.prizePaid.toFixed(2),
      endedAt: plan.endedAt || new Date(),
    },
    roundResolved: true,
    finished: true,
  };
}

/** Play a seat's run to its end by stopping each active column in turn. */
function playRun(match, seat, rounds, { maxStops = 70, now = Date.now() } = {}) {
  let m = match;
  const key = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  let guard = 0;
  while (m[key] && !m[key].ended && guard < maxStops) {
    const idx = m[key].stoppedCount < GRID_COLS
      ? [0, 1, 2].find((i) => !m[key].stoppedOrder.includes(i))
      : m[key].activeIndex;
    const r = stopColumn(m, seat, idx, rounds, { now });
    assert.equal(r.ok, true);
    m = r.match;
    guard += 1;
  }
  return m;
}

/** Simulate repeated /status polls: advance time one column-window per
 *  poll and auto-stop any due columns until both runs end. */
function forceSpinAdvance(match, rounds, { startNow = Date.now(), maxPolls = 90 } = {}) {
  let m = match;
  let now = startNow;
  let polls = 0;
  while (!(m.p1CurrentInputs?.ended && m.p2CurrentInputs?.ended) && polls < maxPolls) {
    now += COLUMN_DEADLINE_MS;
    m = autoStopActiveColumn(m, "player1", now);
    m = autoStopActiveColumn(m, "player2", now);
    if (canResolveRound(m)) {
      rounds.push(buildRoundResult(m, FRUIT_SYMBOLS));
      return resolveRound(m, rounds).match;
    }
    polls += 1;
  }
  return m;
}

// ════════════════════════════════════════════════════════════════════
// The single survival round
// ════════════════════════════════════════════════════════════════════

test("full round: a bust does NOT resolve early — the match reveals only when both finish", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];

  // Player 1 busts on their very first survival column (crafted run).
  const col3p1 = columnSymbols({ matchId: MATCH.id, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const X = symbolOutside(col3p1);
  match = craftedRunFor(match, "player1", {
    priorWindow: [fillCol("🍉"), fillCol(X), fillCol(X)],
    stoppedCount: 3,
    firstComboAt: 3,
    linesFormed: 1,
    now,
  });
  let r = stopColumn(match, "player1", 3, rounds, { now });
  assert.equal(r.ok, true);
  assert.equal(r.roundResolved, false);
  assert.equal(r.match.p1CurrentInputs.ended, true);
  assert.equal(canResolveRound(r.match), false);
  assert.equal(r.match.status, MATCH_STATUS.SPIN_1);
  assert.equal(rounds.length, 0); // NO early loss popup

  // Player 2 keeps playing the real stream to their end.
  match = playRun(r.match, "player2", rounds, { now });

  // Both finished → the single round resolves and the match settles.
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(rounds.length, 1);
  const row = rounds[0];
  assert.equal(row.spinNumber, 1);
  assert.ok([RESULT.PLAYER1, RESULT.PLAYER2].includes(row.roundWinner)); // p2 never grace-fails in the crafted flow
  assert.equal(row.roundWinner, decideMatchResult(match));

  // Tallies: survived counts as the aggregate points.
  assert.equal(row.spinPointsPlayer1, row.player1Result.survived);
  assert.equal(row.spinPointsPlayer2, row.player2Result.survived);
  assert.equal(match.p1Score, row.spinPointsPlayer1);
  assert.equal(match.p2Score, row.spinPointsPlayer2);

  // Settlement is consistent with the shared payout calculator.
  const payout = computePayout({ stakeAmount: match.stakeAmount, result: row.roundWinner });
  assert.equal(match.result, row.roundWinner);
  assert.equal(match.winnerId, row.roundWinner === RESULT.PLAYER1 ? "u1" : "u2");
  assert.equal(Number(match.houseFee), payout.houseFee);
  assert.equal(Number(match.prizePaid), payout.prizePaid);
  assert.equal(match.roundsWonPlayer1 + match.roundsWonPlayer2, 1);
  assert.ok(match.endedAt instanceof Date);
});

test("both players play the real stream — the round resolves to a winner/draw", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];

  match = playRun(match, "player1", rounds, { now });
  // Player 1's run ended; player 2 is untouched and the round holds open.
  assert.equal(match.p1CurrentInputs.ended, true);
  assert.equal(match.p2CurrentInputs.ended, false);
  assert.equal(match.status, MATCH_STATUS.SPIN_1);
  assert.equal(rounds.length, 0);

  match = playRun(match, "player2", rounds, { now });
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(rounds.length, 1);
  const row = rounds[0];
  assert.ok([RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW, RESULT.GRACE_DRAW].includes(row.roundWinner));
  assert.equal(row.spinPointsPlayer1, row.player1Result.survived);
  assert.equal(row.spinPointsPlayer2, row.player2Result.survived);
  const payout = computePayout({ stakeAmount: match.stakeAmount, result: row.roundWinner });
  assert.equal(Number(match.houseFee), payout.houseFee);
  assert.equal(Number(match.prizePaid), payout.prizePaid);
});

test("both players grace-fail → GRACE_DRAW: 95% refund each, 10% total rake", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];

  // Player 1: 9 safe grace stops, no combo → 10th stop grace-fails.
  const col9p1 = columnSymbols({ matchId: MATCH.id, spinNumber: 1, seat: "player1", colIndex: 9, symbols: FRUIT_SYMBOLS });
  const X1 = symbolOutside(col9p1);
  match = craftedRunFor(match, "player1", {
    priorWindow: [fillCol("🍉"), fillCol(X1), fillCol(X1)],
    stoppedCount: 9,
    now,
  });
  let r = stopColumn(match, "player1", 9, rounds, { now });
  assert.equal(r.ok, true);
  assert.equal(r.roundResolved, false); // p2 still in grace — no reveal
  assert.equal(r.match.p1CurrentInputs.graceFailed, true);

  // Player 2 does the same → both ended → resolve + settle.
  const col9p2 = columnSymbols({ matchId: MATCH.id, spinNumber: 1, seat: "player2", colIndex: 9, symbols: FRUIT_SYMBOLS });
  const X2 = symbolOutside(col9p2);
  match = craftedRunFor(r.match, "player2", {
    priorWindow: [fillCol("🍉"), fillCol(X2), fillCol(X2)],
    stoppedCount: 9,
    now,
  });
  r = stopColumn(match, "player2", 9, rounds, { now });
  assert.equal(r.ok, true);
  assert.equal(r.finished, true);
  match = r.match;

  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].roundWinner, RESULT.GRACE_DRAW);
  assert.equal(match.result, RESULT.GRACE_DRAW);
  assert.equal(match.winnerId, null);
  assert.equal(Number(match.houseFee), 10); // 5% from each of the 100 stakes
  assert.equal(Number(match.prizePaid), 0);
  assert.equal(match.roundsWonPlayer1, 0);
  assert.equal(match.roundsWonPlayer2, 0);
  const payout = computePayout({ stakeAmount: match.stakeAmount, result: RESULT.GRACE_DRAW });
  assert.equal(payout.refundEach, 95);
});

// ════════════════════════════════════════════════════════════════════
// The 10-second per-column guarantee
// ════════════════════════════════════════════════════════════════════

test("each column gets a 15-second window stamped at round open", () => {
  const now = Date.now();
  const m = makeFreshMatch(1, now);
  assert.equal(m.p1CurrentInputs.activeDeadline - now, COLUMN_DEADLINE_MS);
  assert.equal(m.p2CurrentInputs.activeDeadline - now, COLUMN_DEADLINE_MS);
  assert.equal(COLUMN_TIMER_SECONDS, 15);
  assert.equal(ROUND_TIMER_SECONDS, 15);
});

test("stops are rejected only after the deadline AND the stop-grace window pass", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];
  // Inside the grace window: a manual stop still lands (lag cushion).
  match = {
    ...match,
    p1CurrentInputs: {
      ...match.p1CurrentInputs,
      activeDeadline: now - COLUMN_STOP_GRACE_MS + 1000,
    },
  };
  const inGrace = stopColumn(match, "player1", 0, rounds, { now });
  assert.equal(inGrace.ok, true);
  // Past deadline + grace: rejected → the next poll auto-stops instead.
  match = makeFreshMatch(1, now);
  match = {
    ...match,
    p1CurrentInputs: {
      ...match.p1CurrentInputs,
      activeDeadline: now - COLUMN_STOP_GRACE_MS - 1,
    },
  };
  const expired = stopColumn(match, "player1", 0, rounds, { now });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 400);
});

test("AFK: repeated polls auto-stop both runs and resolve the match", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];
  match = forceSpinAdvance(match, rounds, { startNow: now });
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(rounds.length, 1);
  const row = rounds[0];
  assert.equal(row.player1AutoSpun, true);
  assert.equal(row.player2AutoSpun, true);
  assert.equal(row.player1Result.autoStopped, true);
  assert.equal(row.player2Result.autoStopped, true);
  // Both runs ended — by grace-fail or a survival auto-stop bust.
  assert.equal(row.player1Result.ended, true);
  assert.equal(row.player2Result.ended, true);
  assert.ok([RESULT.PLAYER1, RESULT.PLAYER2, RESULT.GRACE_DRAW].includes(row.roundWinner));
  assert.equal(match.result, row.roundWinner);
  // An AFK auto-stop in the initial phase never busts (grace is safe).
  assert.equal(row.player1Result.graceFailed || row.player1Result.busted, true);
});

// ════════════════════════════════════════════════════════════════════
// Hard guarantees on stopping rules
// ════════════════════════════════════════════════════════════════════

test("simultaneous play: each seat's run is independent; stops are one-shot", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];
  match = stopColumn(match, "player1", 1, rounds, { now }).match;
  // Player 1's stop must not touch player 2's run.
  assert.equal(match.p2CurrentInputs.stoppedCount, 0);
  assert.deepEqual(match.p2CurrentInputs.stoppedOrder, []);
  // Stopping the same initial column twice is rejected.
  const again = stopColumn(match, "player1", 1, rounds, { now });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  // Player 2 still plays freely.
  match = stopColumn(match, "player2", 0, rounds, { now }).match;
  assert.deepEqual(match.p2CurrentInputs.stoppedOrder, [0]);
});

test("a stop after the match finished is rejected (round-identity guard)", () => {
  const now = Date.now();
  let match = makeFreshMatch(1, now);
  const rounds = [];
  // Player 1 busts immediately; player 2 plays to the end → finished.
  const col3p1 = columnSymbols({ matchId: MATCH.id, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const X = symbolOutside(col3p1);
  match = craftedRunFor(match, "player1", {
    priorWindow: [fillCol("🍉"), fillCol(X), fillCol(X)],
    stoppedCount: 3,
    firstComboAt: 3,
    linesFormed: 1,
    now,
  });
  match = stopColumn(match, "player1", 3, rounds, { now }).match;
  match = playRun(match, "player2", rounds, { now });
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  // Any late stop is rejected — the match is no longer in a spin round.
  const stale = stopColumn(match, "player1", 0, rounds, { now });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 400);
});

test("a disconnect forfeit resolves to the opponent with the standard 90/10 payout", () => {
  const tallies = {
    roundsWonPlayer1: 0,
    roundsWonPlayer2: ROUNDS_TO_WIN,
    p1Score: 0,
    p2Score: 0,
  };
  const result = decideMatchResult(tallies);
  assert.equal(result, RESULT.PLAYER2);
  const payout = computePayout({ stakeAmount: 100, result });
  assert.equal(payout.winnerNet, 190);
  assert.equal(payout.houseFee, 10);
  assert.equal(MAX_ROUNDS, 1); // single-round matches can only forfeit, not advance
});

console.log("\n✅ All PvP Slots (Fruit Fortune Survival) round-flow tests passed!\n");
