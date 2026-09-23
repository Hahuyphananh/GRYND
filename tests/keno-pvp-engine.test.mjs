/**
 * PvP Keno ("Keno Survival Duel") — engine + constants unit tests.
 *
 * Pure-function tests for `src/lib/keno-pvp/constants.js` and
 * `src/lib/keno-pvp/engine.js`. The survival rules (3 lives, one live
 * tile both players may claim with a life lost ONLY for your own miss,
 * and the 3s → 0.5s shrinking window behind a 5s get-ready countdown)
 * are the contract the store, both API routes and the client all depend
 * on, so they are tested exhaustively (valid + invalid inputs,
 * boundaries, determinism).
 *
 * Run:  node --import tsx --test tests/keno-pvp-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_STATES,
  DB_STATUS_VALUES,
  HOUSE_FEE_PCT,
  HOUSE_RATIO,
  KENO_AI_PLAYER_ID,
  KENO_POOL_SIZE,
  KENO_PVP_LOCK_NAMESPACE,
  LIVE_STATES,
  MATCH_STATUS,
  MAX_STAKE,
  MIN_STAKE,
  MIN_WINDOW_MS,
  OVERTIME_DRAW_FEE_PCT,
  READY_WINDOW_MS,
  RESULT,
  ROUND_STATES,
  STAKE_PRESETS,
  STARTING_LIVES,
  START_WINDOW_MS,
  TAP_GRACE_MS,
  TERMINAL_STATES,
  WINNER_RATIO,
  WINDOW_STEP_MS,
  computePayout,
  isFreeAiMatch,
  pickNonNegativeInt,
  pickPositiveInt,
  round2,
} from "../src/lib/keno-pvp/constants.js";

import {
  applyBothMissToLives,
  applyMissesToLives,
  capTileLog,
  decideSurvivalResult,
  isClaimInWindow,
  pickLiveTile,
  remainingTiles,
  tileLogEntry,
  tileWindowMs,
  usedTileSet,
  windowRemainingMs,
} from "../src/lib/keno-pvp/engine.js";

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

test("every MATCH_STATUS value is a valid keno_pvp_status enum value", () => {
  const db = new Set(DB_STATUS_VALUES);
  for (const value of Object.values(MATCH_STATUS)) {
    assert.ok(db.has(value), `${value} is not in DB_STATUS_VALUES`);
  }
  assert.equal(DB_STATUS_VALUES.length, 21);
});

test("the live run reuses the round_1 enum slot (no new enum value needed)", () => {
  assert.equal(MATCH_STATUS.LIVE, "round_1");
  assert.equal(MATCH_STATUS.LIVE, MATCH_STATUS.ROUND_1);
  assert.ok(DB_STATUS_VALUES.includes(MATCH_STATUS.LIVE));
});

test("state sets model waiting → ready → live → finished", () => {
  assert.equal(TERMINAL_STATES.size, 2);
  assert.ok(TERMINAL_STATES.has(MATCH_STATUS.FINISHED));
  assert.ok(TERMINAL_STATES.has(MATCH_STATUS.CANCELLED));
  assert.ok(!ACTIVE_STATES.has(MATCH_STATUS.FINISHED));
  assert.ok(!ACTIVE_STATES.has(MATCH_STATUS.WAITING));
  assert.ok(ACTIVE_STATES.has(MATCH_STATUS.READY));
  assert.ok(ACTIVE_STATES.has(MATCH_STATUS.LIVE));
  // The survival run is the only "catch round" state.
  assert.equal(LIVE_STATES.size, 1);
  assert.ok(LIVE_STATES.has(MATCH_STATUS.LIVE));
  assert.ok(!LIVE_STATES.has(MATCH_STATUS.READY));
  assert.equal(ROUND_STATES, LIVE_STATES);
  for (const state of LIVE_STATES) assert.ok(ACTIVE_STATES.has(state));
});

test("survival rulebook constants: 3 lives, 3s → 0.5s window, 100ms per claim", () => {
  assert.equal(STARTING_LIVES, 3);
  assert.equal(START_WINDOW_MS, 3000);
  assert.equal(WINDOW_STEP_MS, 100);
  assert.equal(MIN_WINDOW_MS, 500);
  assert.equal(TAP_GRACE_MS, 120);
  assert.equal(KENO_POOL_SIZE, 40);
  assert.ok(START_WINDOW_MS > MIN_WINDOW_MS);
  // The opening window is deliberately slower than the retired 0.8s glow.
  assert.ok(START_WINDOW_MS > 800);
});

test("stake + identity constants are unchanged by the rework", () => {
  assert.deepEqual(STAKE_PRESETS, [10, 25, 50, 100, 250, 500]);
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 100000);
  assert.equal(HOUSE_FEE_PCT, 0.10);
  assert.equal(WINNER_RATIO, 0.90);
  assert.equal(HOUSE_RATIO, 0.10);
  assert.equal(OVERTIME_DRAW_FEE_PCT, 0.05); // legacy rows only
  // The get-ready countdown before the first tile lights.
  assert.equal(READY_WINDOW_MS, 5000);
  assert.ok(READY_WINDOW_MS > 0);
  assert.equal(KENO_AI_PLAYER_ID, "keno_ai_bot");
  assert.equal(KENO_PVP_LOCK_NAMESPACE, 0x4b505650 & 0x7fffffff);
  assert.equal(isFreeAiMatch({ isAi: true }), true);
  assert.equal(isFreeAiMatch({}), false);
  assert.equal(isFreeAiMatch(null), false);
});

test("computePayout: winner takes 1.9x net, draw refunds in full", () => {
  const win = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(win.winnerNet, 190);
  assert.equal(win.loserNet, -100);
  assert.equal(win.houseFee, 10);
  assert.equal(win.prizePaid, 190);

  const draw = computePayout({ stakeAmount: 100, result: RESULT.DRAW });
  assert.equal(draw.refundEach, 100);
  assert.equal(draw.houseFee, 0);

  const legacyTie = computePayout({
    stakeAmount: 100,
    result: RESULT.DRAW,
    drawFeePct: 0.05,
  });
  assert.equal(legacyTie.refundEach, 95);
  assert.equal(legacyTie.houseFee, 10);

  assert.throws(() => computePayout({ stakeAmount: -1, result: RESULT.DRAW }));
  assert.throws(() => computePayout({ stakeAmount: 10, result: "nobody" }));
});

test("format helpers round + clamp the way the store expects", () => {
  assert.equal(round2(1.005), 1);
  assert.equal(round2("2.345"), 2.35);
  assert.equal(round2(NaN), 0);
  assert.equal(pickPositiveInt(0, 7), 7);
  assert.equal(pickPositiveInt("3", 7), 3);
  assert.equal(pickPositiveInt(undefined, 7), 7);
  assert.equal(pickNonNegativeInt(0, 9), 0);
  assert.equal(pickNonNegativeInt(-4, 9), 9);
});

// ════════════════════════════════════════════════════════════════════
// The shrinking window
// ════════════════════════════════════════════════════════════════════

test("tileWindowMs: 3s start, −100ms per claimed tile, 0.5s floor", () => {
  assert.equal(tileWindowMs(0), 3000);
  assert.equal(tileWindowMs(1), 2900);
  assert.equal(tileWindowMs(5), 2500);
  assert.equal(tileWindowMs(24), 600);
  assert.equal(tileWindowMs(25), 500);
  assert.equal(tileWindowMs(26), 500); // floor holds
  assert.equal(tileWindowMs(40), 500);
});

test("tileWindowMs is defensive about junk input", () => {
  assert.equal(tileWindowMs(-3), 3000);
  assert.equal(tileWindowMs(NaN), 3000);
  assert.equal(tileWindowMs(undefined), 3000);
  assert.equal(tileWindowMs("4"), 2600);
  assert.equal(tileWindowMs(2.9), 2800); // truncated, not rounded up
});

test("windowRemainingMs never goes negative", () => {
  assert.equal(windowRemainingMs({ deadlineMs: 5000, atMs: 4000 }), 1000);
  assert.equal(windowRemainingMs({ deadlineMs: 5000, atMs: 5000 }), 0);
  assert.equal(windowRemainingMs({ deadlineMs: 5000, atMs: 6000 }), 0);
  assert.equal(windowRemainingMs({ deadlineMs: NaN, atMs: 1 }), 0);
});

// ════════════════════════════════════════════════════════════════════
// Tile draw
// ════════════════════════════════════════════════════════════════════

test("usedTileSet + remainingTiles ignore junk and keep the board order", () => {
  const used = [3, 3, "7", 0, 41, null, 12.5, 40];
  assert.deepEqual([...usedTileSet(used)].sort((a, b) => a - b), [3, 7, 40]);
  const remaining = remainingTiles(used);
  assert.equal(remaining.length, KENO_POOL_SIZE - 3);
  assert.equal(remaining[0], 1);
  assert.equal(remaining[remaining.length - 1], 39);
  assert.ok(!remaining.includes(3));
  assert.ok(!remaining.includes(40));
  assert.equal(remainingTiles(null).length, KENO_POOL_SIZE);
});

test("pickLiveTile is deterministic per (seed, index) and never repeats", () => {
  const seed = "keno-pvp:17";
  const first = pickLiveTile({ seed, index: 0, used: [] });
  assert.ok(first >= 1 && first <= KENO_POOL_SIZE);
  // Same inputs → same tile (a retry can never move the live tile).
  assert.equal(pickLiveTile({ seed, index: 0, used: [] }), first);
  // A different seed picks a different stream.
  assert.notEqual(pickLiveTile({ seed: "keno-pvp:18", index: 0, used: [] }), first);

  // Walk the whole board: every pick is fresh, and the used list grows.
  const used = [];
  const picked = new Set();
  for (let i = 0; i < KENO_POOL_SIZE; i += 1) {
    const tile = pickLiveTile({ seed, index: i, used });
    assert.ok(Number.isInteger(tile), `index ${i} produced no tile`);
    assert.ok(!picked.has(tile), `tile ${tile} was drawn twice`);
    picked.add(tile);
    used.push(tile);
  }
  assert.equal(picked.size, KENO_POOL_SIZE);
});

test("pickLiveTile returns null once the board is exhausted", () => {
  const used = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1);
  assert.equal(pickLiveTile({ seed: "keno-pvp:1", index: 40, used }), null);
  assert.deepEqual(remainingTiles(used), []);
});

// ════════════════════════════════════════════════════════════════════
// Claim grading
// ════════════════════════════════════════════════════════════════════

test("isClaimInWindow: the window plus the hidden grace, nothing else", () => {
  const window = {
    startedMs: 1000,
    deadlineMs: 2600, // 1.6s window
  };
  // Before the tile lights up (it raced the previous resolution).
  assert.equal(isClaimInWindow({ ...window, atMs: 999 }), false);
  // Exactly at the start and at the deadline — both count.
  assert.equal(isClaimInWindow({ ...window, atMs: 1000 }), true);
  assert.equal(isClaimInWindow({ ...window, atMs: 2600 }), true);
  // Inside the grace tail: still a claim (the tap was made while lit).
  assert.equal(isClaimInWindow({ ...window, atMs: 2720 }), true);
  // Past the grace: too slow.
  assert.equal(isClaimInWindow({ ...window, atMs: 2721 }), false);
});

test("isClaimInWindow: a custom grace + malformed input never accept a claim", () => {
  const window = { startedMs: 0, deadlineMs: 1000 };
  assert.equal(isClaimInWindow({ ...window, atMs: 1100, graceMs: 0 }), false);
  assert.equal(isClaimInWindow({ ...window, atMs: 1000, graceMs: 0 }), true);
  assert.equal(isClaimInWindow({ ...window, atMs: NaN }), false);
  assert.equal(isClaimInWindow({ startedMs: NaN, deadlineMs: 1, atMs: 1 }), false);
  assert.equal(isClaimInWindow({ startedMs: 0, deadlineMs: NaN, atMs: 1 }), false);
  assert.equal(isClaimInWindow({}), false);
});

// ════════════════════════════════════════════════════════════════════
// Lives
// ════════════════════════════════════════════════════════════════════

test("applyMissesToLives: a life is lost only for YOUR OWN miss", () => {
  // Only player2 missed → only player2 loses a life. Player1 claimed it,
  // by definition faster or slower, and is untouched.
  assert.deepEqual(
    applyMissesToLives({ p1Lives: 3, p2Lives: 3, p1Missed: false, p2Missed: true }),
    { p1Lives: 3, p2Lives: 2 },
  );
  // And the mirror image.
  assert.deepEqual(
    applyMissesToLives({ p1Lives: 3, p2Lives: 3, p1Missed: true, p2Missed: false }),
    { p1Lives: 2, p2Lives: 3 },
  );
  // BOTH tapped → claiming a tile never costs the opponent a life, even
  // though only one of them is credited the tile.
  assert.deepEqual(
    applyMissesToLives({ p1Lives: 2, p2Lives: 2, p1Missed: false, p2Missed: false }),
    { p1Lives: 2, p2Lives: 2 },
  );
  // Neither tapped → both lose one.
  assert.deepEqual(
    applyMissesToLives({ p1Lives: 2, p2Lives: 2, p1Missed: true, p2Missed: true }),
    { p1Lives: 1, p2Lives: 1 },
  );
  // Lives never go below zero.
  assert.deepEqual(
    applyMissesToLives({ p1Lives: 3, p2Lives: 1, p1Missed: false, p2Missed: true }),
    { p1Lives: 3, p2Lives: 0 },
  );
  // Malformed input falls back to a full bar (never "already eliminated").
  assert.deepEqual(applyMissesToLives({}), {
    p1Lives: STARTING_LIVES,
    p2Lives: STARTING_LIVES,
  });
});

test("applyBothMissToLives: every player loses one, floored at zero", () => {
  assert.deepEqual(applyBothMissToLives({ p1Lives: 3, p2Lives: 3 }), {
    p1Lives: 2,
    p2Lives: 2,
  });
  assert.deepEqual(applyBothMissToLives({ p1Lives: 1, p2Lives: 2 }), {
    p1Lives: 0,
    p2Lives: 1,
  });
  assert.deepEqual(applyBothMissToLives({ p1Lives: 0, p2Lives: 0 }), {
    p1Lives: 0,
    p2Lives: 0,
  });
  // Malformed input falls back to a full bar (never "already eliminated").
  assert.deepEqual(applyBothMissToLives({}), {
    p1Lives: STARTING_LIVES - 1,
    p2Lives: STARTING_LIVES - 1,
  });
});

// ════════════════════════════════════════════════════════════════════
// Result decision
// ════════════════════════════════════════════════════════════════════

test("decideSurvivalResult: null while both players still have lives", () => {
  assert.equal(decideSurvivalResult({ p1Lives: 3, p2Lives: 3 }), null);
  assert.equal(decideSurvivalResult({ p1Lives: 1, p2Lives: 1 }), null);
  assert.equal(decideSurvivalResult({}), null);
});

test("decideSurvivalResult: a player at zero lives is eliminated", () => {
  assert.equal(decideSurvivalResult({ p1Lives: 0, p2Lives: 2 }), RESULT.PLAYER2);
  assert.equal(decideSurvivalResult({ p1Lives: 2, p2Lives: 0 }), RESULT.PLAYER1);
  assert.equal(decideSurvivalResult({ p1Lives: -1, p2Lives: 1 }), RESULT.PLAYER2);
});

test("decideSurvivalResult: a both-miss that eliminates BOTH ends as a draw", () => {
  assert.equal(decideSurvivalResult({ p1Lives: 0, p2Lives: 0 }), RESULT.DRAW);
  assert.equal(
    decideSurvivalResult({ p1Lives: 0, p2Lives: 0, exhausted: true }),
    RESULT.DRAW,
  );
});

test("decideSurvivalResult: an exhausted board settles on lives, then tiles", () => {
  // More lives wins.
  assert.equal(
    decideSurvivalResult({ p1Lives: 2, p2Lives: 1, p1Tiles: 0, p2Tiles: 0, exhausted: true }),
    RESULT.PLAYER1,
  );
  assert.equal(
    decideSurvivalResult({ p1Lives: 1, p2Lives: 2, exhausted: true }),
    RESULT.PLAYER2,
  );
  // Equal lives → more tiles wins.
  assert.equal(
    decideSurvivalResult({ p1Lives: 1, p2Lives: 1, p1Tiles: 4, p2Tiles: 3, exhausted: true }),
    RESULT.PLAYER1,
  );
  // Everything equal → draw (full refund).
  assert.equal(
    decideSurvivalResult({ p1Lives: 1, p2Lives: 1, p1Tiles: 3, p2Tiles: 3, exhausted: true }),
    RESULT.DRAW,
  );
  // Lives alone never end a match that is not exhausted.
  assert.equal(
    decideSurvivalResult({ p1Lives: 2, p2Lives: 1, exhausted: false }),
    null,
  );
});

// ════════════════════════════════════════════════════════════════════
// The public tile log
// ════════════════════════════════════════════════════════════════════

test("tileLogEntry records the tile, the outcome, survivors and timing", () => {
  const at = Date.UTC(2026, 0, 1, 0, 0, 5);
  const entry = tileLogEntry({
    tile: 17,
    index: 3,
    outcome: "player2",
    at,
    p1Lives: 2,
    p2Lives: 3,
    windowMs: 1300,
    reactionMs: 412.9,
  });
  assert.deepEqual(entry, {
    tile: 17,
    index: 3,
    outcome: "player2",
    at: new Date(at).toISOString(),
    p1Lives: 2,
    p2Lives: 3,
    windowMs: 1300,
    reactionMs: 412,
    // Per-player flags derived from the legacy outcome: only player2 tapped.
    p1Claimed: false,
    p2Claimed: true,
    p1ReactionMs: null,
    p2ReactionMs: null,
  });
  // A both-miss carries no reaction time.
  const miss = tileLogEntry({
    tile: 4,
    index: 0,
    outcome: "both_miss",
    at,
    p1Lives: 2,
    p2Lives: 2,
    windowMs: 3000,
  });
  assert.equal(miss.reactionMs, null);
  assert.equal(miss.p1Claimed, false);
  assert.equal(miss.p2Claimed, false);
});

test("tileLogEntry: a both-claim marks BOTH seats as tapped", () => {
  const entry = tileLogEntry({
    tile: 9,
    index: 4,
    outcome: "both_claim",
    at: Date.UTC(2026, 0, 1),
    p1Lives: 3,
    p2Lives: 3,
    windowMs: 2000,
    reactionMs: 240,
    p1Claimed: true,
    p2Claimed: true,
    p1ReactionMs: 240,
    p2ReactionMs: 380,
  });
  assert.equal(entry.outcome, "both_claim");
  assert.equal(entry.p1Claimed, true);
  assert.equal(entry.p2Claimed, true);
  assert.equal(entry.reactionMs, 240);
  assert.equal(entry.p2ReactionMs, 380);
  // Neither player's lives moved — claiming costs the opponent nothing.
  assert.equal(entry.p1Lives, 3);
  assert.equal(entry.p2Lives, 3);
});

test("capTileLog keeps the newest entries and drops junk", () => {
  const log = Array.from({ length: 5 }, (_, i) => ({ tile: i + 1, index: i }));
  assert.equal(capTileLog(log, 3).length, 3);
  assert.deepEqual(
    capTileLog(log, 3).map((e) => e.tile),
    [3, 4, 5],
  );
  assert.deepEqual(capTileLog([null, { index: 1 }, { tile: 9, index: 2 }], 5), [
    { tile: 9, index: 2 },
  ]);
  assert.deepEqual(capTileLog(null, 5), []);
});
