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
  scoreFromActions,
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

test("scoreFromActions sums only the seat's safe picks", () => {
  const actions = [
    { action: "pick", safe: true, seat: "player1", points: 10 },
    { action: "pick", safe: true, seat: "player1", points: 16 },
    { action: "pick", safe: false, seat: "player1", points: 0 },
    { action: "pick", safe: true, seat: "player2", points: 80 },
    { action: "hold", seat: "player1" },
  ];
  assert.equal(scoreFromActions(actions, "player1"), 26);
  assert.equal(scoreFromActions(actions, "player2"), 80);
  assert.equal(scoreFromActions(null, "player1"), 0);
  assert.equal(scoreFromActions([], "player1"), 0);
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

test("memory rule: a path's bad tile never repeats the previous lane", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const tower = buildPlayerTower({
      serverSeed: "mem-seed",
      clientSeed: "mem-client",
      nonce: 3,
      difficulty,
    });
    for (const pathKey of RISK_PATH_KEYS) {
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
  return {
    currentTurnUserId: BOT_USER_ID,
    difficulty: "easy",
    p1Lane: 0,
    p1Held: false,
    p2Lane: 0,
    p2Held: false,
    actions: [
      ...actionsForScore("player1", p1Points),
      ...actionsForScore("player2", p2Points),
    ],
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

test("decideBotAction: null when the bot is already done", () => {
  assert.equal(decideBotAction(botMatch({ p2Lane: 3, p2Held: true })), null);
  assert.equal(decideBotAction(botMatch({ p2Lane: MAX_LANES })), null);
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
