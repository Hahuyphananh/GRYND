/**
 * PvP Slots ("Skill Slots") — round-engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers
 * in `src/lib/slots-pvp/constants.js` and `src/lib/slots-pvp/engine.js`.
 * The spin resolver, the 8-line scorer, the stop-accuracy tiers and the
 * round/match decision rules are the contract every other piece of the
 * match system depends on, so they're tested exhaustively (valid +
 * invalid inputs, boundaries, determinism).
 *
 * The flow-level tests that drive these same functions through a full
 * match (rounds 1..5, deadlines, auto-stop, settlement) live in
 * `tests/slots-pvp-flow.test.mjs`.
 *
 * Run:  node --test tests/slots-pvp-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ROUNDS,
  MIN_STAKE,
  MAX_STAKE,
  MATCH_STATUS,
  ACTIVE_STATES,
  SPIN_STATES,
  TERMINAL_STATES,
  REELS_PER_ROUND,
  ROUNDS_TO_WIN,
  ROUND_TIMER_SECONDS,
  ROUND_DEADLINE_MS,
  READY_WINDOW_MS,
  BETWEEN_ROUNDS_MS,
  FINISHED_GRACE_MS,
  HOUSE_FEE_PCT,
  WINNER_RATIO,
  HOUSE_RATIO,
  SLOTS_PVP_LOCK_NAMESPACE,
  STAKE_PRESETS,
  RESULT,
  SYMBOL_SCORES,
  SCORING_SYMBOL_COUNT,
  LINE_MULTIPLIERS,
  lineMultiplierForCount,
  PERFECT_STOP_BONUS,
  GOOD_STOP_BONUS,
  NORMAL_STOP_BONUS,
  PERFECT_STOP_WINDOW_MS,
  GOOD_STOP_WINDOW_MS,
  stopAccuracyForOffset,
  stopBonusForAccuracy,
  computePayout,
  statusForSpinNumber,
  spinNumberForStatus,
  isSpinStatus,
  round2,
  pickPositiveInt,
} from "../src/lib/slots-pvp/constants.js";

import {
  GRID_COLS,
  GRID_ROWS,
  WINNING_LINES,
  FORCED_LINE_ODDS,
  decideForcedLines,
  cyrb53,
  mulberry32,
  buildReels,
  evaluateBoard,
  resolveSpin,
  spinSeed,
  openSpinState,
  applyReelStop,
  autoStopReels,
  canResolveRound,
  scoreBoard,
  viewerRoundScoreSnapshot,
  decideRoundWinner,
  decideMatchResult,
  buildRoundResult,
  planAdvanceAfterResolve,
} from "../src/lib/slots-pvp/engine.js";

const FRUIT_SYMBOLS = ["🍉","🍌","🍍","🍏","🍓","🥭","🍈","🍇","🍒","🍎","🍊","🍋","🥝","🍐","🍑","🥥","🍅","🍆","🌽","🍠"];

// ════════════════════════════════════════════════════════════════════
// Round structure constants
// ════════════════════════════════════════════════════════════════════

test("a round lasts exactly 10 seconds", () => {
  assert.equal(ROUND_TIMER_SECONDS, 10);
  assert.equal(ROUND_DEADLINE_MS, 10 * 1000);
});

test("a match has at most 5 rounds (best-of-5)", () => {
  assert.equal(MAX_ROUNDS, 5);
  assert.equal(SPIN_STATES.size, MAX_ROUNDS);
});

test("first to 3 round wins ends the match (ROUNDS_TO_WIN)", () => {
  assert.equal(ROUNDS_TO_WIN, 3);
  // Best-of-5 shape: 3 wins decides BEFORE the 5-round cap.
  assert.ok(ROUNDS_TO_WIN < MAX_ROUNDS);
});

test("each player stops exactly 3 reels per round", () => {
  assert.equal(REELS_PER_ROUND, 3);
});

test("status enum matches the slots_pvp_status pgEnum (migration 0059)", () => {
  assert.deepEqual(Object.values(MATCH_STATUS), [
    "waiting",
    "ready",
    "spin_1",
    "spin_2",
    "spin_3",
    "spin_4",
    "spin_5",
    "finished",
    "cancelled",
  ]);
});

test("state sets partition the status machine correctly", () => {
  assert.equal(ACTIVE_STATES.size, 6); // ready + 5 spins
  assert.equal(SPIN_STATES.size, 5);
  assert.equal(TERMINAL_STATES.size, 2);
  for (const s of SPIN_STATES) assert.ok(ACTIVE_STATES.has(s));
  for (const s of TERMINAL_STATES) assert.ok(!ACTIVE_STATES.has(s));
});

test("statusForSpinNumber maps 1..5 and clamps out-of-range", () => {
  assert.equal(statusForSpinNumber(1), MATCH_STATUS.SPIN_1);
  assert.equal(statusForSpinNumber(3), MATCH_STATUS.SPIN_3);
  assert.equal(statusForSpinNumber(5), MATCH_STATUS.SPIN_5);
  assert.equal(statusForSpinNumber(0), MATCH_STATUS.SPIN_1); // clamps low
  assert.equal(statusForSpinNumber(99), MATCH_STATUS.SPIN_5); // clamps high
});

test("spinNumberForStatus round-trips and rejects non-spin states", () => {
  assert.equal(spinNumberForStatus(MATCH_STATUS.SPIN_2), 2);
  assert.equal(spinNumberForStatus(MATCH_STATUS.READY), null);
  assert.equal(spinNumberForStatus(MATCH_STATUS.FINISHED), null);
  assert.equal(isSpinStatus(MATCH_STATUS.SPIN_4), true);
  assert.equal(isSpinStatus(MATCH_STATUS.CANCELLED), false);
});

test("stake + house-fee constants match the mines-pvp 90/10 split", () => {
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 1000000);
  assert.ok(STAKE_PRESETS.length > 0);
  assert.equal(HOUSE_FEE_PCT, 0.1);
  assert.equal(WINNER_RATIO, 0.9);
  assert.equal(HOUSE_RATIO, 0.1);
  assert.equal(typeof SLOTS_PVP_LOCK_NAMESPACE, "number");
  assert.ok(SLOTS_PVP_LOCK_NAMESPACE > 0);
  assert.deepEqual(Object.values(RESULT), ["player1", "player2", "draw"]);
});

// ════════════════════════════════════════════════════════════════════
// Symbol tiers + line multipliers
// ════════════════════════════════════════════════════════════════════

test("symbol tiers are position-based: first 6 theme symbols score 100..500", () => {
  assert.equal(SCORING_SYMBOL_COUNT, 6);
  assert.deepEqual(SYMBOL_SCORES, [100, 125, 150, 200, 300, 500]);
  // Cherry → Diamond in order: symbols[0] = 100 … symbols[5] = 500.
  FRUIT_SYMBOLS.slice(0, 6).forEach((sym, i) => {
    assert.equal(SYMBOL_SCORES[i], [100, 125, 150, 200, 300, 500][i]);
    // Only the first 6 symbols are scoring tiers; the rest score 0.
    assert.equal(i < SCORING_SYMBOL_COUNT, true);
  });
});

test("line multiplier table matches the user spec", () => {
  assert.equal(lineMultiplierForCount(1), 1);
  assert.equal(lineMultiplierForCount(2), 1.25);
  assert.equal(lineMultiplierForCount(3), 1.5);
  assert.equal(lineMultiplierForCount(4), 2);
  assert.equal(lineMultiplierForCount(5), 3);
  assert.equal(lineMultiplierForCount(8), 3); // 5+ clamps to x3
  assert.equal(lineMultiplierForCount(0), 1); // no lines → x1 (score 0)
  assert.equal(LINE_MULTIPLIERS.length, 5);
});

// ════════════════════════════════════════════════════════════════════
// Board geometry + 8 winning lines
// ════════════════════════════════════════════════════════════════════

test("board is 3x3 with exactly 8 winning lines (3 rows + 3 cols + 2 diags)", () => {
  assert.equal(GRID_COLS, 3);
  assert.equal(GRID_ROWS, 3);
  assert.equal(WINNING_LINES.length, 8);
  for (const line of WINNING_LINES) {
    assert.equal(line.cells.length, 3);
    for (const [col, row] of line.cells) {
      assert.ok(col >= 0 && col < 3);
      assert.ok(row >= 0 && row < 3);
    }
  }
});

test("forced-line odds cover [0, 100) with 3/2/1/0 rows", () => {
  assert.deepEqual(
    FORCED_LINE_ODDS.map((r) => r.forcedLines),
    [3, 2, 1, 0],
  );
  assert.equal(decideForcedLines(0.02), 3); // roll < 3 → 3 rows
  assert.equal(decideForcedLines(0.05), 2); // roll < 10 → 2 rows
  assert.equal(decideForcedLines(0.15), 1); // roll < 25 → 1 row
  assert.equal(decideForcedLines(0.5), 0); // else none
  assert.equal(decideForcedLines(0.999), 0);
});

test("determinism + board shape", () => {
  const a = resolveSpin({ symbols: FRUIT_SYMBOLS, seed: 12345 });
  const b = resolveSpin({ symbols: FRUIT_SYMBOLS, seed: 12345 });
  assert.deepEqual(a.reels, b.reels);
  assert.equal(a.symbolScore, b.symbolScore);
  assert.equal(a.lineCount, b.lineCount);
  assert.equal(a.reels.length, GRID_COLS);
  for (const col of a.reels) {
    assert.equal(col.length, GRID_ROWS);
    for (const sym of col) assert.ok(FRUIT_SYMBOLS.includes(sym));
  }
});

test("different seeds → different reels (virtually always)", () => {
  const a = resolveSpin({ symbols: FRUIT_SYMBOLS, seed: 1 });
  const b = resolveSpin({ symbols: FRUIT_SYMBOLS, seed: 2 });
  assert.notDeepEqual(a.reels, b.reels);
});

test("seeded hashing is stable across runs", () => {
  assert.equal(cyrb53("slots:1:p1:spin1", 0), cyrb53("slots:1:p1:spin1", 0));
  assert.notEqual(spinSeed(1, 1, 1), spinSeed(1, 1, 2));
  assert.notEqual(spinSeed(1, 1, 1), spinSeed(1, 2, 1));
  assert.equal(spinSeed(1, 1, 1), spinSeed(1, 1, 1));
});

// ════════════════════════════════════════════════════════════════════
// 8-line scoring (evaluateBoard)
// ════════════════════════════════════════════════════════════════════

// Helper: build a reels grid from a 3x3 matrix written row-first for
// readability. Internal layout is reels[col][row].
function grid(rows) {
  const reels = Array.from({ length: 3 }, () => Array(3).fill(null));
  rows.forEach((rowSyms, r) => {
    rowSyms.forEach((sym, c) => {
      reels[c][r] = sym;
    });
  });
  return reels;
}

test("evaluateBoard detects a horizontal row", () => {
  const reels = grid([
    ["🍉", "🍉", "🍉"], // top row: 3 identical scoring symbols
    ["🍌", "🍍", "🍏"],
    ["🍓", "🥭", "🍈"],
  ]);
  const score = evaluateBoard({ reels, symbols: FRUIT_SYMBOLS });
  assert.equal(score.lineCount, 1);
  assert.equal(score.baseScore, 100); // 🍉 = symbols[0] = Cherry tier
  assert.equal(score.multiplier, 1);
  assert.equal(score.symbolScore, 100);
  assert.equal(score.winningLines[0].line, "top-row");
});

test("evaluateBoard detects vertical + diagonal lines", () => {
  // Left column all 🥭 (symbols[5] = Diamond tier = 500). No other
  // line shares three identical symbols.
  const reels = grid([
    ["🥭", "🍉", "🍍"],
    ["🥭", "🍌", "🍏"],
    ["🥭", "🍓", "🍈"],
  ]);
  const col = evaluateBoard({ reels, symbols: FRUIT_SYMBOLS });
  assert.equal(col.lineCount, 1);
  assert.equal(col.winningLines[0].line, "left-col");
  assert.equal(col.baseScore, 500);
  assert.equal(col.symbolScore, 500);

  // Main diagonal all 🍍 (symbols[2] = Orange tier = 150).
  const reels2 = grid([
    ["🍍", "🍉", "🍌"],
    ["🍏", "🍍", "🍉"],
    ["🍓", "🥭", "🍍"],
  ]);
  const diag = evaluateBoard({ reels: reels2, symbols: FRUIT_SYMBOLS });
  assert.equal(diag.lineCount, 1);
  assert.equal(diag.winningLines[0].line, "diag-down");
  assert.equal(diag.symbolScore, 150);
});

test("evaluateBoard: a line of 3 identical NON-scoring symbols is not a win", () => {
  // 🍈 is symbols[6] — outside the 6 scoring tiers.
  const reels = grid([
    ["🍈", "🍈", "🍈"],
    ["🍉", "🍌", "🍍"],
    ["🍏", "🍓", "🥭"],
  ]);
  const score = evaluateBoard({ reels, symbols: FRUIT_SYMBOLS });
  assert.equal(score.lineCount, 0);
  assert.equal(score.baseScore, 0);
  assert.equal(score.symbolScore, 0);
  assert.deepEqual(score.winningLines, []);
});

test("evaluateBoard: multiple lines sum bases then apply the multiplier", () => {
  // Top row 🍉 (100) + bottom row 🥭 (500) → 2 lines → x1.25.
  const reels = grid([
    ["🍉", "🍉", "🍉"],
    ["🍌", "🍍", "🍏"],
    ["🥭", "🥭", "🥭"],
  ]);
  const score = evaluateBoard({ reels, symbols: FRUIT_SYMBOLS });
  assert.equal(score.lineCount, 2);
  assert.equal(score.baseScore, 600); // 100 + 500
  assert.equal(score.multiplier, 1.25);
  assert.equal(score.symbolScore, 750); // 600 * 1.25
});

test("evaluateBoard: 4 lines → x2, 5+ lines → x3", () => {
  // Plus-shape: top+bottom rows and left+right cols all 🍍 → 4 lines.
  const reels4 = grid([
    ["🍍", "🍍", "🍍"],
    ["🍍", "🍉", "🍍"],
    ["🍍", "🍍", "🍍"],
  ]);
  const s4 = evaluateBoard({ reels: reels4, symbols: FRUIT_SYMBOLS });
  assert.equal(s4.lineCount, 4);
  assert.equal(s4.multiplier, 2);
  assert.equal(s4.baseScore, 4 * 150);
  assert.equal(s4.symbolScore, 4 * 150 * 2);

  // Entire board one scoring symbol (🍉 = symbols[0] = Cherry tier) →
  // all 8 lines win → x3.
  const all = grid([
    ["🍉", "🍉", "🍉"],
    ["🍉", "🍉", "🍉"],
    ["🍉", "🍉", "🍉"],
  ]);
  const s8 = evaluateBoard({ reels: all, symbols: FRUIT_SYMBOLS });
  assert.equal(s8.lineCount, 8);
  assert.equal(s8.multiplier, 3);
  assert.equal(s8.baseScore, 8 * 100);
  assert.equal(s8.symbolScore, 8 * 100 * 3);
});

test("evaluateBoard is deterministic + pure", () => {
  const reels = grid([
    ["🥭", "🥭", "🥭"],
    ["🍉", "🍉", "🍉"],
    ["🍍", "🍍", "🍍"],
  ]);
  const a = evaluateBoard({ reels, symbols: FRUIT_SYMBOLS });
  const b = evaluateBoard({ reels, symbols: FRUIT_SYMBOLS });
  assert.deepEqual(a, b);
  assert.equal(a.symbolScore, (500 + 100 + 150) * 1.5);
});

// ════════════════════════════════════════════════════════════════════
// Stop accuracy
// ════════════════════════════════════════════════════════════════════

test("stop accuracy windows: <3s perfect, <6s good, else normal", () => {
  assert.equal(PERFECT_STOP_WINDOW_MS, 3000);
  assert.equal(GOOD_STOP_WINDOW_MS, 6000);
  assert.equal(stopAccuracyForOffset(0), "perfect");
  assert.equal(stopAccuracyForOffset(2999), "perfect");
  assert.equal(stopAccuracyForOffset(3000), "good");
  assert.equal(stopAccuracyForOffset(5999), "good");
  assert.equal(stopAccuracyForOffset(6000), "normal");
  assert.equal(stopAccuracyForOffset(9999), "normal");
  assert.equal(stopAccuracyForOffset(-5), "normal"); // defensive
  assert.equal(stopAccuracyForOffset(undefined), "normal");
});

test("stop bonuses: perfect +100, good +50, normal +0", () => {
  assert.equal(PERFECT_STOP_BONUS, 100);
  assert.equal(GOOD_STOP_BONUS, 50);
  assert.equal(NORMAL_STOP_BONUS, 0);
  assert.equal(stopBonusForAccuracy("perfect"), 100);
  assert.equal(stopBonusForAccuracy("good"), 50);
  assert.equal(stopBonusForAccuracy("normal"), 0);
  assert.equal(stopBonusForAccuracy("anything-else"), 0);
});

test("scoreBoard: total = symbolScore + stopBonus (per-reel accuracy)", () => {
  const reels = grid([
    ["🍉", "🍉", "🍉"],
    ["🍌", "🍍", "🍏"],
    ["🍓", "🥭", "🍈"],
  ]);
  const score = scoreBoard({
    reels,
    symbols: FRUIT_SYMBOLS,
    stopOffsets: { 0: 500, 1: 4000, 2: 8000 }, // perfect, good, normal
  });
  assert.equal(score.symbolScore, 100);
  assert.equal(score.stopBonus, 100 + 50 + 0);
  assert.equal(score.totalScore, 100 + 150);
  assert.deepEqual(
    score.accuracyByReel.map((a) => a.accuracy),
    ["perfect", "good", "normal"],
  );
});

test("scoreBoard: manual stops keep accuracy even on a partially auto-stopped board", () => {
  const reels = grid([
    ["🍉", "🍉", "🍉"],
    ["🍌", "🍍", "🍏"],
    ["🍓", "🥭", "🍈"],
  ]);
  // Reels 0+1 were stopped manually (recorded offsets); reel 2 was
  // auto-stopped at the deadline (NO offset). The manual stops keep
  // their accuracy — the board-level autoStopped flag must not zero
  // them out.
  const score = scoreBoard({
    reels,
    symbols: FRUIT_SYMBOLS,
    stopOffsets: { 0: 500, 1: 4000 }, // perfect + good; reel 2 absent
  });
  assert.equal(score.stopBonus, 100 + 50);
  assert.deepEqual(
    score.accuracyByReel.map((a) => a.accuracy),
    ["perfect", "good", "normal"],
  );
});

test("scoreBoard: empty/absent offsets → all normal (AFK board)", () => {
  const reels = grid([
    ["🍉", "🍉", "🍉"],
    ["🍌", "🍍", "🍏"],
    ["🍓", "🥭", "🍈"],
  ]);
  const score = scoreBoard({ reels, symbols: FRUIT_SYMBOLS });
  assert.equal(score.stopBonus, 0);
  assert.equal(score.totalScore, score.symbolScore);
  // An offset of exactly 0ms still counts as a (perfect) manual stop.
  const zero = scoreBoard({
    reels,
    symbols: FRUIT_SYMBOLS,
    stopOffsets: { 0: 0, 1: 0, 2: 0 },
  });
  assert.equal(zero.stopBonus, 300);
});

// ════════════════════════════════════════════════════════════════════
// Viewer-visible current round score (status-route snapshot)
// ════════════════════════════════════════════════════════════════════

test("viewerRoundScoreSnapshot: locked board → full server score", () => {
  let m = makeSpinMatch();
  for (const idx of [0, 1, 2]) {
    m = applyReelStop(m, "player1", idx, m.p1CurrentInputs.openedAt + 500).match;
  }
  assert.equal(m.p1CurrentInputs.boardLocked, true);
  const snap = viewerRoundScoreSnapshot({
    inputs: m.p1CurrentInputs,
    symbols: FRUIT_SYMBOLS,
  });
  assert.equal(snap.locked, true);
  const full = scoreBoard({
    reels: m.p1CurrentInputs.reels,
    symbols: FRUIT_SYMBOLS,
    stopOffsets: m.p1CurrentInputs.stopOffsets,
  });
  assert.equal(snap.totalScore, full.totalScore);
  assert.equal(snap.symbolScore, full.symbolScore);
  assert.equal(snap.stopBonus, 300); // three perfect stops (+100 each)
  assert.equal(snap.lineCount, full.lineCount);
  assert.equal(snap.multiplier, full.multiplier);
  assert.equal(snap.accuracyByReel.length, 3);
  // Deterministic — same inputs, same snapshot.
  assert.deepEqual(
    viewerRoundScoreSnapshot({ inputs: m.p1CurrentInputs, symbols: FRUIT_SYMBOLS }),
    snap,
  );
});

test("viewerRoundScoreSnapshot: live board → stop bonuses only, symbol score hidden", () => {
  const m = makeSpinMatch();
  const stopped = applyReelStop(
    m,
    "player1",
    0,
    m.p1CurrentInputs.openedAt + 500,
  ).match;
  const snap = viewerRoundScoreSnapshot({
    inputs: stopped.p1CurrentInputs,
    symbols: FRUIT_SYMBOLS,
  });
  assert.equal(snap.locked, false);
  assert.equal(snap.totalScore, 100); // perfect stop on reel 1
  assert.equal(snap.symbolScore, 0); // still hidden until lock
  assert.equal(snap.stopBonus, 100);
  assert.equal(snap.lineCount, 0);
  assert.deepEqual(snap.accuracyByReel, [
    { reel: 0, accuracy: "perfect", bonus: 100 },
  ]);
  // A later Good stop on reel 3 adds +50.
  const stopped2 = applyReelStop(
    stopped,
    "player1",
    2,
    stopped.p1CurrentInputs.openedAt + 4000,
  ).match;
  const snap2 = viewerRoundScoreSnapshot({
    inputs: stopped2.p1CurrentInputs,
    symbols: FRUIT_SYMBOLS,
  });
  assert.equal(snap2.totalScore, 150);
  assert.deepEqual(
    snap2.accuracyByReel.map((a) => a.accuracy),
    ["perfect", "good"],
  );
});

test("viewerRoundScoreSnapshot: no reels (round not opened / finished) → null", () => {
  assert.equal(
    viewerRoundScoreSnapshot({ inputs: null, symbols: FRUIT_SYMBOLS }),
    null,
  );
  assert.equal(
    viewerRoundScoreSnapshot({ inputs: {}, symbols: FRUIT_SYMBOLS }),
    null,
  );
  const m = makeSpinMatch();
  assert.equal(
    viewerRoundScoreSnapshot({
      inputs: { ...m.p1CurrentInputs, reels: undefined },
      symbols: FRUIT_SYMBOLS,
    }),
    null,
  );
});

// ════════════════════════════════════════════════════════════════════
// Round winner + match result + payout
// ════════════════════════════════════════════════════════════════════

test("decideRoundWinner: higher total score wins, ties are draws", () => {
  assert.equal(decideRoundWinner(750, 100), RESULT.PLAYER1);
  assert.equal(decideRoundWinner(100, 750), RESULT.PLAYER2);
  assert.equal(decideRoundWinner(750, 750), RESULT.DRAW);
  assert.equal(decideRoundWinner(0, 0), RESULT.DRAW);
});

test("decideMatchResult: rounds won decides; aggregate points break ties", () => {
  // Clear rounds-won lead.
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 3, roundsWonPlayer2: 2, p1Score: 100, p2Score: 900 }),
    RESULT.PLAYER1,
  );
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 1, roundsWonPlayer2: 3, p1Score: 900, p2Score: 100 }),
    RESULT.PLAYER2,
  );
  // Rounds-won tie → aggregate points decide.
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 700, p2Score: 500 }),
    RESULT.PLAYER1,
  );
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 500, p2Score: 700 }),
    RESULT.PLAYER2,
  );
  // Everything tied → draw.
  assert.equal(
    decideMatchResult({ roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 500, p2Score: 500 }),
    RESULT.DRAW,
  );
  // Missing inputs default to 0 (draw).
  assert.equal(decideMatchResult({}), RESULT.DRAW);
});

test("a forced best-of-5 forfeit tally resolves to the opponent (disconnect forfeit)", () => {
  // The disconnect forfeit forces the OPPONENT's rounds-won to
  // ROUNDS_TO_WIN and routes through the SAME decideMatchResult +
  // computePayout as a natural settlement — the winner is picked by
  // the shared decision rule, never by the client.
  assert.equal(
    decideMatchResult({
      roundsWonPlayer1: 0,
      roundsWonPlayer2: ROUNDS_TO_WIN,
      p1Score: 0,
      p2Score: 0,
    }),
    RESULT.PLAYER2,
  );
  assert.equal(
    decideMatchResult({
      roundsWonPlayer1: ROUNDS_TO_WIN,
      roundsWonPlayer2: 0,
      p1Score: 0,
      p2Score: 0,
    }),
    RESULT.PLAYER1,
  );
  // The opponent's forfeit win pays the standard 90/10 split.
  const payout = computePayout({ stakeAmount: 100, result: RESULT.PLAYER2 });
  assert.equal(payout.winnerNet, 190);
  assert.equal(payout.houseFee, 10);
  assert.equal(payout.prizePaid, 190);
});

test("computePayout: winner gets stake + 90% of loser's stake", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(payout.winnerNet, 190); // 100 + 90
  assert.equal(payout.loserNet, -100);
  assert.equal(payout.houseFee, 10); // 10% of loser's stake
  assert.equal(payout.prizePaid, 190);
});

test("computePayout: draw refunds both, no fee", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.DRAW });
  assert.equal(payout.winnerNet, null);
  assert.equal(payout.loserNet, null);
  assert.equal(payout.houseFee, 0);
  assert.equal(payout.prizePaid, 0);
  assert.equal(payout.stake, 100);
});

test("computePayout validates inputs", () => {
  assert.throws(() => computePayout({ stakeAmount: -1, result: RESULT.PLAYER1 }), RangeError);
  assert.throws(() => computePayout({ stakeAmount: 100, result: "bogus" }), RangeError);
});

// ════════════════════════════════════════════════════════════════════
// Round state machine (pure transitions)
// ════════════════════════════════════════════════════════════════════

function makeSpinMatch(overrides = {}) {
  const deadline = new Date(Date.now() + ROUND_DEADLINE_MS);
  const open = openSpinState({
    matchId: 7,
    spinNumber: 1,
    symbols: FRUIT_SYMBOLS,
    deadline,
  });
  return {
    id: 7,
    player1Id: "u1",
    player2Id: "u2",
    stakeAmount: "100.00",
    theme: "fruit",
    status: MATCH_STATUS.SPIN_1,
    currentSpin: 1,
    roundDeadline: deadline,
    ...open,
    ...overrides,
  };
}

test("openSpinState gives both players hidden 3x3 reels + precomputed score", () => {
  const m = makeSpinMatch();
  assert.equal(m.p1CurrentInputs.reels.length, 3);
  assert.equal(m.p2CurrentInputs.reels.length, 3);
  assert.deepEqual(m.p1CurrentInputs.reelsStopped, []);
  assert.equal(m.p1CurrentInputs.boardLocked, false);
  assert.notDeepEqual(m.p1CurrentInputs.reels, m.p2CurrentInputs.reels);
  // Board score is precomputed at open (server-authoritative).
  assert.equal(typeof m.p1CurrentInputs.symbolScore, "number");
  assert.equal(typeof m.p1CurrentInputs.lineCount, "number");
  // The stamped deadline is the full 10s window measured from stamp time
  // (a sub-100ms skew is just test-runner scheduling latency).
  const skew = m.roundDeadline.getTime() - Date.now();
  assert.ok(skew <= ROUND_DEADLINE_MS && skew > ROUND_DEADLINE_MS - 100, `deadline skew: ${skew}ms`);
});

test("applyReelStop validates participant / status / index / deadline", () => {
  const m = makeSpinMatch();
  assert.deepEqual(applyReelStop(m, "spectator", 0), {
    ok: false,
    error: "Caller is not a participant",
    status: 403,
  });
  assert.equal(applyReelStop(m, "player1", -1).ok, false);
  assert.equal(applyReelStop(m, "player1", 3).ok, false);
  assert.equal(applyReelStop(m, "player1", "x").ok, false);
  const ready = { ...m, status: MATCH_STATUS.READY };
  assert.equal(applyReelStop(ready, "player1", 0).status, 400);
  const expired = { ...m, roundDeadline: new Date(Date.now() - 1) };
  assert.deepEqual(applyReelStop(expired, "player1", 0), {
    ok: false,
    error: "Round time has expired",
    status: 400,
  });
});

test("applyReelStop records server-side stop offsets (accuracy timing)", () => {
  const m = makeSpinMatch();
  const openedAt = m.p1CurrentInputs.openedAt;
  const r = applyReelStop(m, "player1", 1, openedAt + 500);
  assert.equal(r.ok, true);
  assert.equal(r.match.p1CurrentInputs.stopOffsets[1], 500);
});

test("applyReelStop rejects stale stops that echo a previous round", () => {
  const m = makeSpinMatch();
  assert.equal(applyReelStop(m, "player1", 0, Date.now(), 1).ok, true);
  assert.deepEqual(applyReelStop(m, "player1", 1, Date.now(), 2), {
    ok: false,
    error: "Round has already advanced",
    status: 409,
  });
  assert.equal(applyReelStop(m, "player1", 1).ok, true);
});

test("a stopped reel can never be stopped again", () => {
  let m = makeSpinMatch();
  const first = applyReelStop(m, "player1", 1);
  assert.equal(first.ok, true);
  m = first.match;
  assert.deepEqual(m.p1CurrentInputs.reelsStopped, [1]);
  const second = applyReelStop(m, "player1", 1);
  assert.deepEqual(second, {
    ok: false,
    error: "Reel 2 is already stopped",
    status: 409,
  });
});

test("the board locks exactly on the 3rd stop and rejects further stops", () => {
  let m = makeSpinMatch();
  for (const idx of [0, 2, 1]) {
    const r = applyReelStop(m, "player1", idx);
    assert.equal(r.ok, true);
    m = r.match;
  }
  assert.deepEqual(m.p1CurrentInputs.reelsStopped, [0, 1, 2]);
  assert.equal(m.p1CurrentInputs.boardLocked, true);
  assert.deepEqual(applyReelStop(m, "player1", 0), {
    ok: false,
    error: "Board is already locked",
    status: 409,
  });
});

test("autoStopReels fills remaining reels and marks autoStopped", () => {
  let m = makeSpinMatch();
  m = applyReelStop(m, "player2", 2).match;
  m = autoStopReels(m, "player2");
  assert.deepEqual(m.p2CurrentInputs.reelsStopped, [0, 1, 2]);
  assert.equal(m.p2CurrentInputs.autoStopped, true);
  assert.equal(m.p2CurrentInputs.boardLocked, true);
  assert.equal(m.p1CurrentInputs.boardLocked, false);
});

test("canResolveRound requires BOTH boards locked", () => {
  let m = makeSpinMatch();
  assert.equal(canResolveRound(m), false);
  m = autoStopReels(m, "player1");
  assert.equal(canResolveRound(m), false);
  m = autoStopReels(m, "player2");
  assert.equal(canResolveRound(m), true);
});

test("buildRoundResult maps the round to its history payload (scored)", () => {
  let m = makeSpinMatch();
  m = applyReelStop(m, "player1", 0).match;
  m = applyReelStop(m, "player1", 1).match;
  m = applyReelStop(m, "player1", 2).match;
  m = autoStopReels(m, "player2");
  const row = buildRoundResult(m, FRUIT_SYMBOLS);
  assert.equal(row.matchId, 7);
  assert.equal(row.spinNumber, 1);
  assert.deepEqual(row.player1Inputs, { reelsStopped: [0, 1, 2], autoStopped: false });
  assert.deepEqual(row.player2Inputs, { reelsStopped: [0, 1, 2], autoStopped: true });
  assert.equal(row.player1AutoSpun, false);
  assert.equal(row.player2AutoSpun, true);
  assert.deepEqual(row.player1Result.reels, m.p1CurrentInputs.reels);
  assert.equal(row.player1Result.symbolScore, m.p1CurrentInputs.symbolScore);
  assert.equal(typeof row.player1Result.totalScore, "number");
  assert.equal(typeof row.player2Result.totalScore, "number");
  assert.equal(row.spinPointsPlayer1, row.player1Result.totalScore);
  assert.equal(row.spinPointsPlayer2, row.player2Result.totalScore);
  // Round winner = higher total score (or draw).
  assert.ok([RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(row.roundWinner));
  if (row.player1Result.totalScore > row.player2Result.totalScore) {
    assert.equal(row.roundWinner, RESULT.PLAYER1);
  }
  if (row.player1Result.totalScore === row.player2Result.totalScore) {
    assert.equal(row.roundWinner, RESULT.DRAW);
  }
});

test("planAdvanceAfterResolve opens the next spin with a fresh 10s window", () => {
  let m = makeSpinMatch();
  m = autoStopReels(m, "player1");
  m = autoStopReels(m, "player2");
  const plan = planAdvanceAfterResolve({
    match: m,
    symbols: FRUIT_SYMBOLS,
    now: Date.now(),
  });
  assert.equal(plan.finished, false);
  assert.equal(plan.status, MATCH_STATUS.SPIN_2);
  assert.equal(plan.currentSpin, 2);
  const skew = plan.roundDeadline.getTime() - Date.now();
  assert.ok(skew <= ROUND_DEADLINE_MS && skew > ROUND_DEADLINE_MS - 100, `skew: ${skew}ms`);
  assert.equal(plan.p1CurrentInputs.boardLocked, false);
  assert.deepEqual(plan.p1CurrentInputs.reelsStopped, []);
});

test("planAdvanceAfterResolve finishes after round 5", () => {
  const m = { ...makeSpinMatch({ status: MATCH_STATUS.SPIN_5, currentSpin: 5 }) };
  const plan = planAdvanceAfterResolve({
    match: m,
    symbols: FRUIT_SYMBOLS,
    now: Date.now(),
  });
  assert.equal(plan.finished, true);
  assert.equal(plan.status, MATCH_STATUS.FINISHED);
  assert.ok(plan.endedAt instanceof Date);
});

test("planAdvanceAfterResolve finishes IMMEDIATELY when a player reaches ROUNDS_TO_WIN", () => {
  const base = makeSpinMatch();
  const now = Date.now();

  // 3-0 after spin 3 → first to 3 → finished, even though spin 4/5
  // were never played.
  const m3 = { ...base, status: MATCH_STATUS.SPIN_3, currentSpin: 3 };
  const plan3 = planAdvanceAfterResolve({
    match: m3,
    symbols: FRUIT_SYMBOLS,
    tallies: { roundsWonPlayer1: 3, roundsWonPlayer2: 0, p1Score: 1, p2Score: 0 },
    now,
  });
  assert.equal(plan3.finished, true);
  assert.equal(plan3.status, MATCH_STATUS.FINISHED);
  assert.equal(plan3.endedAt.getTime(), now);

  // 3-1 after spin 4 → the 3rd win seals it immediately too.
  const m4 = { ...base, status: MATCH_STATUS.SPIN_4, currentSpin: 4 };
  const plan4 = planAdvanceAfterResolve({
    match: m4,
    symbols: FRUIT_SYMBOLS,
    tallies: { roundsWonPlayer1: 3, roundsWonPlayer2: 1, p1Score: 1, p2Score: 1 },
    now,
  });
  assert.equal(plan4.finished, true);
  assert.equal(plan4.status, MATCH_STATUS.FINISHED);

  // 0-3 after spin 3 → player2 reached 3 first → finished.
  const m3p2 = { ...base, status: MATCH_STATUS.SPIN_3, currentSpin: 3 };
  const planP2 = planAdvanceAfterResolve({
    match: m3p2,
    symbols: FRUIT_SYMBOLS,
    tallies: { roundsWonPlayer1: 0, roundsWonPlayer2: 3, p1Score: 0, p2Score: 1 },
    now,
  });
  assert.equal(planP2.finished, true);
  assert.equal(planP2.status, MATCH_STATUS.FINISHED);
});

test("planAdvanceAfterResolve does NOT finish on a 2-1 (or lower) lead", () => {
  const base = makeSpinMatch();
  const now = Date.now();
  const m = { ...base, status: MATCH_STATUS.SPIN_3, currentSpin: 3 };
  const plan = planAdvanceAfterResolve({
    match: m,
    symbols: FRUIT_SYMBOLS,
    tallies: { roundsWonPlayer1: 2, roundsWonPlayer2: 1, p1Score: 1, p2Score: 1 },
    now,
  });
  assert.equal(plan.finished, false);
  assert.equal(plan.status, MATCH_STATUS.SPIN_4);
  assert.equal(plan.currentSpin, 4);
  // A fresh round-4 board is opened with a fresh 10s window.
  assert.equal(plan.p1CurrentInputs.boardLocked, false);
  assert.equal(plan.roundDeadline.getTime() - now, ROUND_DEADLINE_MS);
});

test("planAdvanceAfterResolve: the MAX_ROUNDS cap still finishes a 2-2 tie", () => {
  const base = makeSpinMatch();
  const m = { ...base, status: MATCH_STATUS.SPIN_5, currentSpin: 5 };
  const plan = planAdvanceAfterResolve({
    match: m,
    symbols: FRUIT_SYMBOLS,
    tallies: { roundsWonPlayer1: 2, roundsWonPlayer2: 2, p1Score: 1, p2Score: 1 },
    now: Date.now(),
  });
  assert.equal(plan.finished, true);
  assert.equal(plan.status, MATCH_STATUS.FINISHED);
});

// ════════════════════════════════════════════════════════════════════
// Misc helpers
// ════════════════════════════════════════════════════════════════════

test("round2 / pickPositiveInt behave like the other PvP games", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2("12.345"), 12.35);
  assert.equal(round2(null), 0);
  assert.equal(pickPositiveInt(null, 10), 10);
  assert.equal(pickPositiveInt(0, 10), 10);
  assert.equal(pickPositiveInt("20", 10), 20);
  assert.equal(pickPositiveInt(15.9, 10), 15);
  assert.equal(READY_WINDOW_MS, 3000);
  assert.equal(BETWEEN_ROUNDS_MS, 3000);
  assert.equal(FINISHED_GRACE_MS, 5000);
});

console.log("\n? All PvP Slots engine tests passed!\n");
