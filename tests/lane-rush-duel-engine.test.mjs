/**
 * Lane Rush Duel — engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers
 * in `src/lib/lane-rush-duel/constants.js`: points scoring, risk paths,
 * provably-fair tower generation (with the bad-tile memory rule),
 * outcome/payout contract, turn helpers, bot strategy, and the
 * score-based zugzwang pressure math.
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_USER_ID,
  DIFFICULTIES,
  DIFFICULTY_POINT_MULT,
  MAX_LANES,
  LANE_POINTS,
  RISK_PATHS,
  RISK_PATH_KEYS,
  isValidPath,
  pointsForSafePick,
  pickPointsForSeat,
  scoreFromActions,
  banksUsedBySeat,
  hasBanked,
  peeksUsedBySeat,
  MAX_PEEKS,
  WIN_BANKED_SCORE,
  bankedWinnerOf,
  bankRate,
  bankRateForSeat,
  bankedScoreOf,
  hasBusted,
  climbEnded,
  bothEnded,
  finalScoreOf,
  isBotUser,
  isBotMatch,
  decideBotAction,
  laneMultiplier,
  safePicksToReachScore,
  averagePointsPerPick,
  survivalOdds,
  MATCH_STATUS,
  ACTIVE_STATES,
  PICKABLE_STATES,
  TERMINAL_STATES,
  READY_WINDOW_MS,
  FINISHED_GRACE_MS,
  ROUND_TIMER_SECONDS,
  ROUND_PICK_DEADLINE_MS,
  STAKE_PRESETS,
  MIN_STAKE,
  MAX_STAKE,
  HOUSE_FEE_PCT,
  WINNER_RATIO,
  HOUSE_RATIO,
  RESULT,
  LANE_RUSH_DUEL_LOCK_NAMESPACE,
  buildPlayerTower,
  computeDeductions,
  decideOutcome,
  computePayout,
  round2,
  isPlayerDone,
  bothDone,
  seatForUserId,
  opponentOf,
} from "../src/lib/lane-rush-duel/constants.js";

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

test("difficulty table exposes easy/medium/hard with increasing risk", () => {
  assert.ok(DIFFICULTIES.easy);
  assert.ok(DIFFICULTIES.medium);
  assert.ok(DIFFICULTIES.hard);
  assert.ok(DIFFICULTIES.easy.width > DIFFICULTIES.hard.width);
  assert.ok(DIFFICULTIES.hard.endMultiplier > DIFFICULTIES.easy.endMultiplier);
});

test("MAX_LANES is 8 (the tower height)", () => {
  assert.equal(MAX_LANES, 8);
});

test("turn window is 20s", () => {
  assert.equal(ROUND_TIMER_SECONDS, 20);
  assert.equal(ROUND_PICK_DEADLINE_MS, 20 * 1000);
});

test("stake bounds match the other PvP games", () => {
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 1000000);
  assert.ok(STAKE_PRESETS.length > 0);
});

test("state machine constants are consistent", () => {
  assert.equal(MATCH_STATUS.WAITING, "waiting");
  assert.equal(MATCH_STATUS.READY, "ready");
  assert.equal(MATCH_STATUS.P1_TURN, "p1_turn");
  assert.equal(MATCH_STATUS.P2_TURN, "p2_turn");
  assert.equal(MATCH_STATUS.FINISHED, "finished");
  assert.equal(MATCH_STATUS.CANCELLED, "cancelled");
  assert.ok(ACTIVE_STATES.has(MATCH_STATUS.P1_TURN));
  assert.ok(PICKABLE_STATES.has(MATCH_STATUS.P1_TURN));
  assert.ok(!PICKABLE_STATES.has(MATCH_STATUS.READY));
  assert.ok(TERMINAL_STATES.has(MATCH_STATUS.FINISHED));
  assert.ok(TERMINAL_STATES.has(MATCH_STATUS.CANCELLED));
});

test("ready/finished grace windows are sane", () => {
  assert.equal(READY_WINDOW_MS, 3000);
  assert.equal(FINISHED_GRACE_MS, 5000);
});

test("house split is 90/10 on the loser's stake", () => {
  assert.equal(HOUSE_FEE_PCT, 0.1);
  assert.equal(WINNER_RATIO, 0.9);
  assert.equal(HOUSE_RATIO, 0.1);
});

test("advisory-lock namespace is a positive 32-bit int", () => {
  assert.ok(Number.isInteger(LANE_RUSH_DUEL_LOCK_NAMESPACE));
  assert.ok(LANE_RUSH_DUEL_LOCK_NAMESPACE > 0);
  assert.ok(LANE_RUSH_DUEL_LOCK_NAMESPACE <= 0x7fffffff);
});

// ════════════════════════════════════════════════════════════════════
// Points scoring
// ════════════════════════════════════════════════════════════════════

test("LANE_POINTS grows geometrically with height", () => {
  assert.equal(LANE_POINTS.length, MAX_LANES);
  for (let i = 1; i < LANE_POINTS.length; i += 1) {
    assert.ok(LANE_POINTS[i] > LANE_POINTS[i - 1], "points must grow per lane");
  }
  assert.equal(LANE_POINTS[0], 10);
});

test("pointsForSafePick: base points × path factor × difficulty mult", () => {
  // Lane 0 (10 pts): safe ×1 ×1 = 10; balanced ×1.6 = 16; risky ×2.5 = 25.
  assert.equal(pointsForSafePick(0, "safe", "easy"), 10);
  assert.equal(pointsForSafePick(0, "balanced", "easy"), 16);
  assert.equal(pointsForSafePick(0, "risky", "easy"), 25);
  // Difficulty multiplies on top: hard = ×2.
  assert.equal(pointsForSafePick(0, "safe", "hard"), 20);
  assert.equal(pointsForSafePick(0, "risky", "medium"), 38); // 25 × 1.5
  // The higher you climb, the more each safe pick pays.
  assert.ok(pointsForSafePick(7, "safe", "easy") > pointsForSafePick(3, "safe", "easy"));
});

test("pointsForSafePick: invalid inputs return 0", () => {
  assert.equal(pointsForSafePick(-1, "safe"), 0);
  assert.equal(pointsForSafePick(99, "safe"), 0);
  assert.equal(pointsForSafePick(0, "nope"), 10); // falls back to safe path
  assert.equal(pointsForSafePick(NaN, "safe"), 0);
});

test("scoreFromActions tracks each seat's current unbanked run", () => {
  const actions = [
    { action: "pick", safe: true, seat: "player1", points: 10 },
    { action: "pick", safe: true, seat: "player1", points: 16 },
    { action: "pick", safe: false, seat: "player1", points: 0 },
    { action: "pick", safe: true, seat: "player1", points: 8 },
    { action: "pick", safe: true, seat: "player2", points: 80 },
    { action: "hold", seat: "player1" },
  ];
  assert.equal(scoreFromActions(actions, "player1"), 8);
  assert.equal(scoreFromActions(actions, "player2"), 80);
  assert.equal(scoreFromActions(null, "player1"), 0);
  assert.equal(scoreFromActions([], "player1"), 0);
});

// ════════════════════════════════════════════════════════════════════
// Soft bank helpers (banked totals, rate decay, climb status)
// ════════════════════════════════════════════════════════════════════

test("banksUsedBySeat / hasBanked: count hold actions per seat", () => {
  const match = {
    actions: [
      { action: "hold", seat: "player1", bankedTotal: 30 },
      { action: "hold", seat: "player1", bankedTotal: 70 },
      { action: "hold", seat: "player2", bankedTotal: 40 },
    ],
  };
  assert.equal(banksUsedBySeat(match, "player1"), 2);
  assert.equal(banksUsedBySeat(match, "player2"), 1);
  assert.equal(hasBanked(match, "player1"), true);
  assert.equal(hasBanked(match, "player2"), true);
  assert.equal(hasBanked({ actions: [] }, "player1"), false);
  assert.equal(hasBanked(null, "player1"), false);
});

test("peeksUsedBySeat: count peek actions per seat (budget MAX_PEEKS)", () => {
  const match = {
    actions: [
      { action: "peek", seat: "player1" },
      { action: "peek", seat: "player1" },
      { action: "peek", seat: "player2" },
    ],
  };
  assert.equal(MAX_PEEKS, 2);
  assert.equal(peeksUsedBySeat(match, "player1"), 2);
  assert.equal(peeksUsedBySeat(match, "player2"), 1);
  assert.equal(peeksUsedBySeat({ actions: [] }, "player1"), 0);
  assert.equal(peeksUsedBySeat(null, "player1"), 0);
});

test("bankRate: 1, 0.5, 0.25 per bank", () => {
  assert.equal(bankRate(0), 1);
  assert.equal(bankRate(1), 0.5);
  assert.equal(bankRate(2), 0.25);
  assert.equal(
    bankRateForSeat(
      {
        actions: [
          { action: "hold", seat: "player2", bankedTotal: 10 },
          { action: "hold", seat: "player2", bankedTotal: 20 },
        ],
      },
      "player2",
    ),
    0.25,
  );
});

test("WIN_BANKED_SCORE is 1000 (the race target)", () => {
  assert.equal(WIN_BANKED_SCORE, 1000);
});

test("bankedWinnerOf: the first hold to lock ≥ 1000 wins the race", () => {
  // No one banked → null.
  assert.equal(
    bankedWinnerOf({
      actions: [{ action: "pick", safe: true, seat: "player1", points: 1500 }],
    }),
    null,
  );
  // P2's hold crossed the target → player2.
  assert.equal(
    bankedWinnerOf({
      actions: [
        { action: "pick", safe: true, seat: "player1", points: 800 },
        { action: "hold", seat: "player2", bankedTotal: 1050 },
      ],
    }),
    "player2",
  );
  // Both banked ≥ 1000 on the same row → the EARLIER action wins.
  assert.equal(
    bankedWinnerOf({
      actions: [
        { action: "hold", seat: "player1", bankedTotal: 1000 },
        { action: "hold", seat: "player2", bankedTotal: 1200 },
      ],
    }),
    "player1",
  );
  // Below the target → null.
  assert.equal(
    bankedWinnerOf({
      actions: [{ action: "hold", seat: "player1", bankedTotal: 999 }],
    }),
    null,
  );
  assert.equal(bankedWinnerOf({ actions: [] }), null);
  assert.equal(bankedWinnerOf(null), null);
});

test("bankedScoreOf: the most recent hold's locked total", () => {
  const match = {
    actions: [
      { action: "pick", safe: true, seat: "player1", points: 16 },
      { action: "hold", seat: "player1", bankedTotal: 16 },
      { action: "pick", safe: true, seat: "player1", points: 10 },
      { action: "hold", seat: "player1", bankedTotal: 26 },
    ],
  };
  assert.equal(bankedScoreOf(match, "player1"), 26);
  assert.equal(bankedScoreOf({ actions: [] }, "player1"), 0);
  assert.equal(bankedScoreOf(null, "player1"), 0);
});

test("pickPointsForSeat: applies the bank-rate decay to a pick", () => {
  const match = {
    difficulty: "easy",
    actions: [{ action: "hold", seat: "player1", bankedTotal: 16 }],
  };
  // Lane 1 balanced = 32 pts; one bank → 16.
  assert.equal(
    pickPointsForSeat(match, "player1", 1, "balanced", "easy"),
    16,
  );
  // No banks → full rate.
  assert.equal(
    pickPointsForSeat({ actions: [] }, "player1", 1, "balanced", "easy"),
    32,
  );
});

test("hasBusted records history but a bust never ends the climb", () => {
  const match = {
    p1Lane: 3,
    p2Lane: 3,
    actions: [{ action: "pick", safe: false, seat: "player1", points: 0 }],
  };
  assert.equal(hasBusted(match, "player1"), true);
  assert.equal(hasBusted(match, "player2"), false);
  assert.equal(climbEnded(match, "player1"), false);
  assert.equal(climbEnded(match, "player2"), false);
  // Completed tower ends the climb too.
  assert.equal(climbEnded({ p1Lane: MAX_LANES, actions: [] }, "player1"), false);
  // A banked-but-active player is NOT ended.
  const banked = {
    p1Lane: 2,
    actions: [
      { action: "pick", safe: true, seat: "player1", points: 16 },
      { action: "hold", seat: "player1", bankedTotal: 16 },
    ],
  };
  assert.equal(climbEnded(banked, "player1"), false);
});

test("bothEnded is always false in simultaneous play", () => {
  const p1Busted = { p1Lane: 1, p2Lane: 1, actions: [{ action: "pick", safe: false, seat: "player1" }] };
  assert.equal(bothEnded(p1Busted), false);
  const bothBusted = {
    p1Lane: 1,
    p2Lane: 1,
    actions: [
      { action: "pick", safe: false, seat: "player1" },
      { action: "pick", safe: false, seat: "player2" },
    ],
  };
  assert.equal(bothEnded(bothBusted), false);
});

test("finalScoreOf reports the current run after bust reset", () => {
  // Busted WITH a bank → keeps the banked total.
  const busted = {
    actions: [
      { action: "pick", safe: true, seat: "player1", points: 16 },
      { action: "hold", seat: "player1", bankedTotal: 16 },
      { action: "pick", safe: false, seat: "player1", points: 0 },
    ],
  };
  assert.equal(finalScoreOf(busted, "player1"), 16);
  // Busted without a bank → 0.
  assert.equal(
    finalScoreOf({ actions: [{ action: "pick", safe: false, seat: "player1" }] }, "player1"),
    0,
  );
  // Completed (not busted) → accumulated.
  assert.equal(
    finalScoreOf(
      { p1Lane: MAX_LANES, actions: [{ action: "pick", safe: true, seat: "player1", points: 2400 }] },
      "player1",
    ),
    2400,
  );
  // Active WITH a bank → banked total (unbanked doesn't count).
  assert.equal(
    finalScoreOf(
      {
        actions: [
          { action: "pick", safe: true, seat: "player1", points: 16 },
          { action: "hold", seat: "player1", bankedTotal: 16 },
          { action: "pick", safe: true, seat: "player1", points: 60 },
        ],
      },
      "player1",
    ),
    76,
  );
  // Active without a bank when the opponent busts → accumulated.
  assert.equal(
    finalScoreOf(
      { actions: [{ action: "pick", safe: true, seat: "player1", points: 76 }] },
      "player1",
    ),
    76,
  );
});

test("difficulty point multipliers escalate hard play", () => {
  assert.equal(DIFFICULTY_POINT_MULT.easy, 1);
  assert.equal(DIFFICULTY_POINT_MULT.medium, 1.5);
  assert.equal(DIFFICULTY_POINT_MULT.hard, 2);
});

// ════════════════════════════════════════════════════════════════════
// Risk paths (the choose-your-odds mechanic)
// ════════════════════════════════════════════════════════════════════

test("three risk paths: wider = safer = fewer points", () => {
  assert.deepEqual(RISK_PATH_KEYS, ["safe", "balanced", "risky"]);
  assert.ok(RISK_PATHS.safe.tiles > RISK_PATHS.balanced.tiles);
  assert.ok(RISK_PATHS.balanced.tiles > RISK_PATHS.risky.tiles);
  assert.ok(RISK_PATHS.safe.pointFactor < RISK_PATHS.balanced.pointFactor);
  assert.ok(RISK_PATHS.balanced.pointFactor < RISK_PATHS.risky.pointFactor);
});

test("isValidPath rejects unknown paths", () => {
  assert.equal(isValidPath("safe"), true);
  assert.equal(isValidPath("risky"), true);
  assert.equal(isValidPath("insane"), false);
  assert.equal(isValidPath(null), false);
});

// ════════════════════════════════════════════════════════════════════
// Provably-fair tower generation (paths + memory rule)
// ════════════════════════════════════════════════════════════════════

test("buildPlayerTower is deterministic for identical seeds", () => {
  const a = buildPlayerTower({
    serverSeed: "seed-a",
    clientSeed: "client-a",
    nonce: 7,
    difficulty: "medium",
  });
  const b = buildPlayerTower({
    serverSeed: "seed-a",
    clientSeed: "client-a",
    nonce: 7,
    difficulty: "medium",
  });
  assert.deepEqual(a, b);
});

test("buildPlayerTower: one bad tile per path per lane, in path range", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const tower = buildPlayerTower({
      serverSeed: "test-seed",
      clientSeed: "test-client",
      nonce: 1,
      difficulty,
    });
    assert.equal(tower.length, MAX_LANES);
    for (const lane of tower) {
      for (const pathKey of RISK_PATH_KEYS) {
        const bad = lane[pathKey];
        const width = RISK_PATHS[pathKey].tiles;
        assert.ok(
          Number.isInteger(bad) && bad >= 0 && bad < width,
          `${pathKey} bad tile ${bad} must be in [0, ${width})`,
        );
      }
    }
  }
});

test("memory rule: safe/balanced bad tiles never repeat the previous lane", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const tower = buildPlayerTower({
      serverSeed: "mem-seed",
      clientSeed: "mem-client",
      nonce: 3,
      difficulty,
    });
    for (const pathKey of RISK_PATH_KEYS) {
      if (RISK_PATHS[pathKey].tiles <= 2) continue; // risky has no same-path rule
      for (let lane = 1; lane < tower.length; lane += 1) {
        assert.notEqual(
          tower[lane][pathKey],
          tower[lane - 1][pathKey],
          `${pathKey} lane ${lane} repeats lane ${lane - 1}'s bad tile`,
        );
      }
    }
  }
});

test("cross-path constraint: risky never repeats the previous lane's safe position", () => {
  for (let seed = 0; seed < 40; seed += 1) {
    const tower = buildPlayerTower({
      serverSeed: `xp-${seed}`,
      clientSeed: "xp-client",
      nonce: seed,
      difficulty: "easy",
    });
    for (let lane = 1; lane < tower.length; lane += 1) {
      const safePrev = tower[lane - 1].safe;
      if (safePrev < 2) {
        assert.notEqual(
          tower[lane].risky,
          safePrev,
          `lane ${lane} risky repeats lane ${lane - 1}'s safe tile ${safePrev}`,
        );
      }
    }
  }
});

test("risky path is NOT forced to alternate (no same-path memory rule)", () => {
  let sawRepeat = false;
  for (let seed = 0; seed < 40 && !sawRepeat; seed += 1) {
    const tower = buildPlayerTower({
      serverSeed: `noalt-${seed}`,
      clientSeed: "noalt-client",
      nonce: seed,
      difficulty: "easy",
    });
    for (let lane = 1; lane < tower.length; lane += 1) {
      if (tower[lane].risky === tower[lane - 1].risky) {
        sawRepeat = true;
        break;
      }
    }
  }
  // 40 towers × 7 lane-pairs ≈ 280 coin flips — a strict alternation
  // would never repeat; with a ~50% repeat chance per pair, seeing
  // zero repeats would be astronomically unlikely.
  assert.ok(sawRepeat, "risky should repeat its own previous position in at least one tower");
});

test("different client seeds produce different towers (fairness separation)", () => {
  const a = buildPlayerTower({
    serverSeed: "shared",
    clientSeed: "player-a",
    nonce: 5,
    difficulty: "easy",
  });
  const b = buildPlayerTower({
    serverSeed: "shared",
    clientSeed: "player-b",
    nonce: 5,
    difficulty: "easy",
  });
  const badA = a.map((l) => l.safe).join(",");
  const badB = b.map((l) => l.safe).join(",");
  // With 4 tiles/path the chance of identical full towers is (1/4)^8 —
  // effectively impossible; assert we differ somewhere.
  assert.notEqual(badA, badB);
});

// ════════════════════════════════════════════════════════════════════
// Outcome resolver
// ════════════════════════════════════════════════════════════════════

test("decideOutcome maps loser to winner", () => {
  assert.equal(
    decideOutcome({ loserId: "p1", player1Id: "p1", player2Id: "p2" }),
    RESULT.PLAYER2,
  );
  assert.equal(
    decideOutcome({ loserId: "p2", player1Id: "p1", player2Id: "p2" }),
    RESULT.PLAYER1,
  );
});

test("decideOutcome throws on unknown loser", () => {
  assert.throws(() =>
    decideOutcome({ loserId: "ghost", player1Id: "p1", player2Id: "p2" }),
  );
});

// ════════════════════════════════════════════════════════════════════
// Payout
// ════════════════════════════════════════════════════════════════════

test("computePayout: win pays 1.9x stake, house keeps 0.1x", () => {
  const p = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(p.winnerNet, 190);
  assert.equal(p.loserNet, -100);
  assert.equal(p.houseFee, 10);
  assert.equal(p.prizePaid, 190);
  assert.equal(p.stake, 100);
});

test("computePayout: draw refunds both, no fees", () => {
  const p = computePayout({ stakeAmount: 50, result: RESULT.DRAW });
  assert.equal(p.winnerNet, null);
  assert.equal(p.loserNet, null);
  assert.equal(p.houseFee, 0);
  assert.equal(p.prizePaid, 0);
});

test("computePayout rounds to 2dp", () => {
  const p = computePayout({ stakeAmount: 33.33, result: RESULT.PLAYER2 });
  // 33.33 * 0.9 = 29.997 → 30.00; winner net = 33.33 + 30.00 = 63.33
  assert.equal(p.winnerNet, 63.33);
  assert.equal(p.houseFee, 3.33);
});

test("computePayout rejects invalid inputs", () => {
  assert.throws(() => computePayout({ stakeAmount: -5, result: RESULT.PLAYER1 }));
  assert.throws(() => computePayout({ stakeAmount: 10, result: "nonsense" }));
});

test("round2 handles non-finite inputs", () => {
  assert.equal(round2(NaN), 0);
  assert.equal(round2(Infinity), 0);
  assert.equal(round2(1.005), 1);
});

// ════════════════════════════════════════════════════════════════════
// Turn/done helpers
// ════════════════════════════════════════════════════════════════════

test("isPlayerDone: held or at top is done, otherwise climbing", () => {
  assert.equal(isPlayerDone(3, true), true);
  assert.equal(isPlayerDone(MAX_LANES, false), true); // completed tower
  assert.equal(isPlayerDone(0, false), false);
  assert.equal(isPlayerDone(4, false), false);
});

test("bothDone requires BOTH players done", () => {
  assert.equal(
    bothDone({ p1Lane: 3, p1Held: true, p2Lane: 5, p2Held: true }),
    true,
  );
  assert.equal(
    bothDone({ p1Lane: MAX_LANES, p1Held: false, p2Lane: 2, p2Held: true }),
    true,
  );
  assert.equal(
    bothDone({ p1Lane: 3, p1Held: true, p2Lane: 4, p2Held: false }),
    false,
  );
  assert.equal(
    bothDone({ p1Lane: 2, p1Held: false, p2Lane: 2, p2Held: false }),
    false,
  );
});

test("seatForUserId / opponentOf resolve seats correctly", () => {
  const match = { player1Id: "p1", player2Id: "p2" };
  assert.equal(seatForUserId(match, "p1"), "player1");
  assert.equal(seatForUserId(match, "p2"), "player2");
  assert.equal(seatForUserId(match, "ghost"), null);
  assert.equal(opponentOf(match, "p1"), "p2");
  assert.equal(opponentOf(match, "p2"), "p1");
  assert.equal(opponentOf(match, "ghost"), null);
});

// ════════════════════════════════════════════════════════════════════
// Bot identity + strategy (score-based)
// ════════════════════════════════════════════════════════════════════

test("bot identity helpers", () => {
  assert.equal(BOT_USER_ID, "AI_BOT");
  assert.equal(isBotUser("AI_BOT"), true);
  assert.equal(isBotUser("p1"), false);
  assert.equal(isBotMatch({ player2Id: "AI_BOT" }), true);
  assert.equal(isBotMatch({ player2Id: "p2" }), false);
  assert.equal(isBotMatch(null), false);
});

// A tiny deterministic PRNG so bot decisions are reproducible in tests.
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Build a match fixture whose `actions` give the given seat a score of
// `points` from consecutive safe balanced-path picks on easy.
function actionsForScore(seat, points) {
  const actions = [];
  let accrued = 0;
  let lane = 0;
  while (accrued < points && lane < MAX_LANES) {
    const pts = pointsForSafePick(lane, "balanced", "easy");
    actions.push({ action: "pick", safe: true, seat, points: pts });
    accrued += pts;
    lane += 1;
  }
  return actions;
}

function botMatch(overrides = {}) {
  const p1Points = overrides.p1Points ?? 0;
  const p2Points = overrides.p2Points ?? 0;
  const actions = [
    ...actionsForScore("player1", p1Points),
    ...actionsForScore("player2", p2Points),
  ];
  // p1Held/p2Held map to real hold actions (with a banked total), so
  // the soft-bank helpers see the same state the server would.
  if (overrides.p1Held) {
    actions.push({
      action: "hold",
      seat: "player1",
      safe: null,
      points: 0,
      bankedTotal: p1Points,
    });
  }
  if (overrides.p2Held) {
    actions.push({
      action: "hold",
      seat: "player2",
      safe: null,
      points: 0,
      bankedTotal: p2Points,
    });
  }
  if (overrides.p1Busted) {
    actions.push({ action: "pick", seat: "player1", safe: false, points: 0 });
  }
  if (overrides.p2Busted) {
    actions.push({ action: "pick", seat: "player2", safe: false, points: 0 });
  }
  return {
    currentTurnUserId: BOT_USER_ID,
    difficulty: "easy",
    p1Lane: 0,
    p1Held: false,
    p2Lane: 0,
    p2Held: false,
    actions,
    ...overrides,
  };
}

test("decideBotAction: null when it is not the bot's turn", () => {
  assert.equal(
    decideBotAction(botMatch({ currentTurnUserId: "human" })),
    null,
  );
  assert.equal(decideBotAction(null), null);
});

test("decideBotAction remains available after a bot bust or lane cycle", () => {
  assert.notEqual(decideBotAction(botMatch({ p2Busted: true })), null);
  assert.notEqual(decideBotAction(botMatch({ p2Lane: MAX_LANES })), null);
  assert.notEqual(decideBotAction(botMatch({ p2Held: true, p2Points: 200 })), null);
});

test("decideBotAction: bot past the player's banked score → hold", () => {
  const decision = decideBotAction(
    botMatch({ p1Held: true, p1Points: 50, p2Points: 200 }),
  );
  assert.deepEqual(decision, { action: "hold" });
});

test("decideBotAction: player banked, bot behind → keep climbing", () => {
  const decision = decideBotAction(
    botMatch({ p1Held: true, p1Points: 600, p2Points: 100 }),
    { random: seededRandom(1) },
  );
  assert.equal(decision.action, "pick");
  assert.ok(["safe", "balanced", "risky"].includes(decision.path));
  assert.ok(decision.tileIndex >= 0 && decision.tileIndex < 3);
});

test("decideBotAction: player climbing, bot ahead at target → hold", () => {
  // Easy target ~350; give the bot a clear lead above it.
  const decision = decideBotAction(
    botMatch({ p1Points: 60, p2Points: 400 }),
    { random: seededRandom(2) },
  );
  assert.deepEqual(decision, { action: "hold" });
});

test("decideBotAction: a player bust does not stop the bot from playing", () => {
  const decision = decideBotAction(
    botMatch({ p1Busted: true, p1Points: 0, p2Points: 80 }),
  );
  assert.equal(decision.action, "pick");
});

test("decideBotAction: already banked and materially ahead of its floor → re-bank", () => {
  const match = botMatch({ p2Held: true, p2Points: 900 });
  // Simulate post-bank picks: banked at 600, now accumulated to 900.
  match.actions = match.actions.map((a) =>
    a && a.action === "hold" && a.seat === "player2"
      ? { ...a, bankedTotal: 600 }
      : a,
  );
  const decision = decideBotAction(match, { random: seededRandom(2) });
  assert.deepEqual(decision, { action: "hold" });
});

test("decideBotAction: player climbing, bot behind → pick riskier", () => {
  const decision = decideBotAction(
    botMatch({ p1Points: 400, p2Points: 80 }),
    { random: seededRandom(3) },
  );
  assert.equal(decision.action, "pick");
  assert.equal(decision.path, "risky");
});

test("decideBotAction: even scores below target → pick balanced", () => {
  const decision = decideBotAction(botMatch({ p1Points: 40, p2Points: 40 }), {
    random: seededRandom(4),
  });
  assert.equal(decision.action, "pick");
  assert.equal(decision.path, "balanced");
});

test("decideBotAction: bot ahead, below target → pick safe", () => {
  const decision = decideBotAction(botMatch({ p1Points: 20, p2Points: 60 }), {
    random: seededRandom(5),
  });
  assert.equal(decision.action, "pick");
  assert.equal(decision.path, "safe");
});

test("decideBotAction: deterministic with a seeded random", () => {
  const a = decideBotAction(
    botMatch({ p1Points: 300, p2Points: 120 }),
    { random: seededRandom(42) },
  );
  const b = decideBotAction(
    botMatch({ p1Points: 300, p2Points: 120 }),
    { random: seededRandom(42) },
  );
  assert.deepEqual(a, b);
});

// ════════════════════════════════════════════════════════════════════
// Zugzwang pressure math (score-based)
// ════════════════════════════════════════════════════════════════════

test("safePicksToReachScore: already at/above target → 0", () => {
  assert.equal(safePicksToReachScore(100, 100, "balanced"), 0);
  assert.equal(safePicksToReachScore(50, 200, "balanced"), 0);
});

test("safePicksToReachScore: converts a point deficit into picks", () => {
  // Easy balanced path averages LANE_POINTS×1.6 / 8 per pick.
  const avg = averagePointsPerPick("balanced", "easy");
  assert.ok(avg > 0);
  const deficit = Math.ceil(avg * 3);
  assert.equal(safePicksToReachScore(deficit, 0, "balanced", "easy"), 3);
});

test("averagePointsPerPick: risky > balanced > safe", () => {
  const easy = averagePointsPerPick("safe", "easy");
  const balanced = averagePointsPerPick("balanced", "easy");
  const risky = averagePointsPerPick("risky", "easy");
  assert.ok(easy < balanced);
  assert.ok(balanced < risky);
});

test("averagePointsPerPick: hard pays double easy", () => {
  assert.equal(
    averagePointsPerPick("safe", "hard"),
    averagePointsPerPick("safe", "easy") * 2,
  );
});

test("survivalOdds: (w-1)/w raised to the number of picks", () => {
  // 4 tiles: 3/4 per safe pick.
  assert.equal(survivalOdds(1, 4), 0.75);
  assert.equal(survivalOdds(2, 4), 0.5625);
  // 2 tiles: 1/2 per safe pick.
  assert.equal(survivalOdds(2, 2), 0.25);
  // 0 picks = already safe.
  assert.equal(survivalOdds(0, 4), 1);
  // Negative picks (already past) = safe.
  assert.equal(survivalOdds(-1, 4), 1);
  // Degenerate inputs don't throw.
  assert.equal(survivalOdds(NaN, 4), 1);
  assert.equal(survivalOdds(2, 1), 0);
});

// ════════════════════════════════════════════════════════════════════
// Live deduction tracker (candidate counts per lane + path)
// ════════════════════════════════════════════════════════════════════

test("computeDeductions: no actions → base candidate counts per path", () => {
  const ded = computeDeductions([]);
  assert.equal(Object.keys(ded).length, MAX_LANES);
  for (let row = 0; row < MAX_LANES; row += 1) {
    assert.equal(ded[row].safe.candidates, 4);
    assert.equal(ded[row].balanced.candidates, 3);
    assert.equal(ded[row].risky.candidates, 2);
    assert.equal(ded[row].safe.solved, false);
    assert.equal(ded[row].safe.badTile, null);
  }
});

test("computeDeductions: a safe pick eliminates that tile (either player — shared tower)", () => {
  // P1 survived tile 1 on (row 0, balanced).
  const ded = computeDeductions([
    { action: "pick", safe: true, seat: "player1", path: "balanced", tile: 1, round: 0 },
  ]);
  assert.equal(ded[0].balanced.candidates, 2);
  assert.equal(ded[0].balanced.solved, false);
  // The opponent's pick counts the same way on the shared tower.
  const ded2 = computeDeductions([
    { action: "pick", safe: true, seat: "player2", path: "balanced", tile: 1, round: 0 },
  ]);
  assert.equal(ded2[0].balanced.candidates, 2);
});

test("computeDeductions: solved row 0 propagates via the memory rule to row 1", () => {
  // Row 0 balanced: both other tiles survived → the bad tile is tile 0.
  const ded = computeDeductions([
    { action: "pick", safe: true, seat: "player1", path: "balanced", tile: 1, round: 0 },
    { action: "pick", safe: true, seat: "player2", path: "balanced", tile: 2, round: 0 },
  ]);
  assert.equal(ded[0].balanced.solved, true);
  assert.equal(ded[0].balanced.badTile, 0);
  // Row 1 balanced (no picks): tile 0 is impossible (memory rule).
  assert.equal(ded[1].balanced.candidates, 2);
  assert.equal(ded[1].balanced.solved, false);
});

test("computeDeductions: correct flag reveals the bad tile (no risky cascade)", () => {
  const ded = computeDeductions([
    { action: "flag", safe: true, seat: "player1", path: "risky", tile: 1, round: 0 },
  ]);
  assert.equal(ded[0].risky.solved, true);
  assert.equal(ded[0].risky.badTile, 1);
  // No same-path memory rule on risky: the next risky row is a fresh 50/50
  // unless the SAFE path constrains it (see the cross-path tests below).
  assert.equal(ded[1].risky.candidates, 2);
  assert.equal(ded[1].risky.solved, false);
});

test("computeDeductions: wrong flags, busts, and holds contribute nothing", () => {
  const ded = computeDeductions([
    { action: "flag", safe: false, seat: "player1", path: "balanced", tile: 0, round: 0 },
    { action: "pick", safe: false, seat: "player2", path: "balanced", tile: 1, round: 0 },
    { action: "hold", seat: "player1", round: 1 },
  ]);
  assert.equal(ded[0].balanced.candidates, 3);
  assert.equal(ded[0].balanced.solved, false);
});

test("computeDeductions: solving the safe path constrains the risky path (cross-path)", () => {
  // A correct flag on row 0 safe (bad tile 1) pins the safe path…
  const ded = computeDeductions([
    { action: "flag", safe: true, seat: "player1", path: "safe", tile: 1, round: 0 },
  ]);
  assert.equal(ded[0].safe.solved, true);
  assert.equal(ded[0].safe.badTile, 1);
  // …and the cross-path constraint solves row 1 risky: it can't be 1.
  assert.equal(ded[1].risky.solved, true);
  assert.equal(ded[1].risky.badTile, 0);
  // The solved safe row also narrows the safe path itself (same-path rule).
  assert.equal(ded[1].safe.candidates, 3);
  assert.equal(ded[1].safe.solved, false);
});

test("computeDeductions: safe bad tiles outside risky range don't constrain risky", () => {
  const ded = computeDeductions([
    { action: "flag", safe: true, seat: "player1", path: "safe", tile: 3, round: 0 },
  ]);
  assert.equal(ded[0].safe.solved, true);
  assert.equal(ded[0].safe.badTile, 3);
  // Position 3 is out of risky's 2-tile range → no cross-path constraint.
  assert.equal(ded[1].risky.candidates, 2);
  assert.equal(ded[1].risky.solved, false);
});

test("computeDeductions: legacy matches without `round` fall back to `lane`", () => {
  const ded = computeDeductions([
    { action: "pick", safe: true, seat: "player1", path: "safe", tile: 2, lane: 1 },
  ]);
  assert.equal(ded[1].safe.candidates, 3);
  assert.equal(ded[0].safe.candidates, 4);
});

// ════════════════════════════════════════════════════════════════════
// Legacy multiplier math (kept for the fair-reveal copy)
// ════════════════════════════════════════════════════════════════════

test("laneMultiplier starts at startMultiplier and grows to endMultiplier", () => {
  for (const [key, config] of Object.entries(DIFFICULTIES)) {
    const first = laneMultiplier(1, key);
    const last = laneMultiplier(MAX_LANES, key);
    assert.equal(first, config.startMultiplier);
    assert.equal(last, config.endMultiplier);
    for (let lane = 1; lane < MAX_LANES; lane += 1) {
      assert.ok(
        laneMultiplier(lane + 1, key) > laneMultiplier(lane, key),
        `${key} should grow between lane ${lane} and ${lane + 1}`,
      );
    }
  }
});

test("laneMultiplier(0) is 1 (pre-pick state)", () => {
  assert.equal(laneMultiplier(0, "easy"), 1);
});
