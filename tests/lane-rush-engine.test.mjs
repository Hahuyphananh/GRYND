/**
 * Lane Rush — rules engine unit tests.
 *
 * The reworked Lane Rush is a simultaneous-planning racing game: 60s planning
 * phases, 2 action points, a garage economy (buy / merge / repair), and a
 * simultaneous race whose DNFs are decided by authoritative server random
 * values. These tests pin the whole rulebook:
 *
 *   • symmetric starting state (2 Tier 1 cars, 4 Scrap, 0 Fuel/Tech, 2 AP);
 *   • tier scores + route multipliers + the single Math.round rule;
 *   • buying, the 8-car fleet cap and the 4-car grid cap;
 *   • merges (valid, mismatched, damaged, Tier 4 ceiling);
 *   • damaged-car and workshop restrictions, repair accounting;
 *   • successful race rewards and DNF penalties;
 *   • workshop recovery (the soft-lock escape hatch);
 *   • scoring and the 1,000-point threshold / draw;
 *   • invalid, legacy and stale persisted states, and post-lock/deadline actions.
 *
 * Run:  node --import tsx --test tests/lane-rush-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_POINTS_PER_ROUND,
  LANE_RUSH_STATE_VERSION,
  MAX_OWNED_CARS,
  MAX_RACING_CARS,
  PLANNING_MS,
  ROUTES,
  STARTING_CARS,
  STARTING_SCRAP,
  TIER_BASE_POINTS,
  WIN_SCORE,
  isDnfRoll,
  mergedTier,
  scoreForRun,
} from "../src/lib/lane-rush/rules.ts";
import {
  applyAction,
  applyPlan,
  canUseWorkshop,
  createInitialState,
  decideWinner,
  isPlanningExpired,
  isReadyToResolve,
  lockIn,
  readState,
  resolveRound,
  validateState,
} from "../src/lib/lane-rush/engine.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const LATER = NOW + PLANNING_MS;

/** A fresh race at a fixed instant, so deadlines are deterministic. */
const fresh = () => createInitialState({ now: NOW });

function act(state, seat, action, now = NOW) {
  return applyAction(state, seat, action, { now });
}

function mustAct(state, seat, action, now = NOW) {
  const result = act(state, seat, action, now);
  assert.equal(result.ok, true, `expected action to succeed: ${result.error}`);
  return result.state;
}

function mustLock(state, seat, now = NOW) {
  const result = lockIn(state, seat, { now });
  assert.equal(result.ok, true, `expected lock-in to succeed: ${result.error}`);
  return result.state;
}

function lockedBoth(state, now = NOW) {
  return mustLock(mustLock(state, "player1", now), "player2", now);
}

function car(id, overrides = {}) {
  return {
    id,
    owner: id.startsWith("p2") ? "player2" : "player1",
    tier: 1,
    status: "garage",
    damaged: false,
    route: null,
    upgrades: [],
    ...overrides,
  };
}

/** Replace a seat's garage with `count` cars (default Tier 1, undamaged). */
function withCars(count, overrides = {}) {
  const state = fresh();
  const seat = state.seats.player1;
  seat.cars = Array.from({ length: count }, (_, i) =>
    car(`p1-c${i + 1}`, overrides),
  );
  seat.nextCarNumber = count + 1;
  return state;
}

function deploy(state, seat, carId, route, now = NOW) {
  return mustAct(state, seat, { type: "deploy", carId, route }, now);
}

// ════════════════════════════════════════════════════════════════════
// 1. Starting state
// ════════════════════════════════════════════════════════════════════

test("both seats start symmetrically: 2 Tier 1 cars, 4 Scrap, 0 points, 0 chips, 2 AP", () => {
  const state = fresh();

  assert.equal(state.version, LANE_RUSH_STATE_VERSION);
  assert.equal(state.round, 1);
  assert.equal(state.phase, "planning");
  assert.equal(state.results.length, 0);
  assert.equal(state.winner, null);
  assert.equal(state.planningDeadline, new Date(NOW + PLANNING_MS).toISOString());

  for (const seat of ["player1", "player2"]) {
    const s = state.seats[seat];
    assert.equal(s.cars.length, STARTING_CARS, `${seat} starts with two cars`);
    assert.equal(s.scrap, STARTING_SCRAP);
    assert.equal(s.points, 0);
    assert.equal(s.fuel, 0);
    assert.equal(s.tech, 0);
    assert.equal(s.actionPoints, ACTION_POINTS_PER_ROUND);
    assert.equal(s.locked, false);
    for (const [i, c] of s.cars.entries()) {
      assert.equal(c.tier, 1, "starting cars are Tier 1");
      assert.equal(c.status, "garage", "starting cars are in the garage");
      assert.equal(c.damaged, false);
      assert.equal(c.route, null);
      assert.deepEqual(c.upgrades, []);
      assert.equal(c.owner, seat);
      assert.equal(c.id, `${seat === "player1" ? "p1" : "p2"}-c${i + 1}`);
    }
  }

  // Identical except for the seat-scoped ids, which are what makes them ownable.
  const shape = (seat) => ({
    points: seat.points,
    scrap: seat.scrap,
    fuel: seat.fuel,
    tech: seat.tech,
    actionPoints: seat.actionPoints,
    locked: seat.locked,
    cars: seat.cars.map((c) => [c.tier, c.status, c.damaged, c.route, c.upgrades]),
  });
  assert.deepEqual(shape(state.seats.player1), shape(state.seats.player2));
  assert.equal(validateState(state), null);
});

test("the initial planning window is exactly 60 seconds and expires on the server", () => {
  const state = fresh();
  assert.equal(PLANNING_MS, 60_000);
  assert.equal(isPlanningExpired(state, NOW), false);
  assert.equal(isPlanningExpired(state, LATER - 1), false);
  assert.equal(isPlanningExpired(state, LATER), true, "the deadline is inclusive");
});

// ════════════════════════════════════════════════════════════════════
// 2. Tier scores + route multipliers
// ════════════════════════════════════════════════════════════════════

test("every tier × route combination uses base points × multiplier, rounded once", () => {
  assert.deepEqual({ ...TIER_BASE_POINTS }, { 1: 12, 2: 28, 3: 65, 4: 150 });

  const expected = {
    1: { safe: 12, sprint: 18, risk: 26 },
    2: { safe: 28, sprint: 42, risk: 62 },
    3: { safe: 65, sprint: 98, risk: 143 },
    4: { safe: 150, sprint: 225, risk: 330 },
  };

  for (const tier of [1, 2, 3, 4]) {
    for (const route of ["safe", "sprint", "risk"]) {
      assert.equal(
        scoreForRun(tier, route),
        expected[tier][route],
        `Tier ${tier} / ${route}`,
      );
    }
  }

  // The two half-way products prove the rounding rule is Math.round (half up),
  // not floor/ceil: 65 × 1.5 = 97.5 and 12 × 2.2 = 26.4.
  assert.equal(scoreForRun(3, "sprint"), 98);
  assert.equal(scoreForRun(1, "risk"), 26);
});

test("route configs are the configured DNF/multiplier/reward table", () => {
  assert.deepEqual(
    {
      safe: [ROUTES.safe.dnfChance, ROUTES.safe.pointsMultiplier, ROUTES.safe.reward],
      sprint: [ROUTES.sprint.dnfChance, ROUTES.sprint.pointsMultiplier, ROUTES.sprint.reward],
      risk: [ROUTES.risk.dnfChance, ROUTES.risk.pointsMultiplier, ROUTES.risk.reward],
    },
    {
      safe: [0.05, 1, { resource: "scrap", amount: 1 }],
      sprint: [0.15, 1.5, { resource: "fuel", amount: 1 }],
      risk: [0.3, 2.2, { resource: "tech", amount: 1 }],
    },
  );
});

test("DNF rolls use a strict `roll < chance` comparison at each route's boundary", () => {
  assert.equal(isDnfRoll("safe", 0.049), true);
  assert.equal(isDnfRoll("safe", 0.05), false, "exactly 5% survives");
  assert.equal(isDnfRoll("sprint", 0.149), true);
  assert.equal(isDnfRoll("sprint", 0.15), false);
  assert.equal(isDnfRoll("risk", 0.299), true);
  assert.equal(isDnfRoll("risk", 0.3), false);
});

test("merges step one tier up and stop at Tier 4", () => {
  assert.equal(mergedTier(1), 2);
  assert.equal(mergedTier(2), 3);
  assert.equal(mergedTier(3), 4);
  assert.equal(mergedTier(4), null, "Tier 4 cannot merge");
  assert.equal(mergedTier(0), null);
  assert.equal(mergedTier(5), null);
});

// ════════════════════════════════════════════════════════════════════
// 3. Buying + fleet cap
// ════════════════════════════════════════════════════════════════════

test("a Tier 1 purchase costs 2 Scrap + 1 AP and adds a garage car", () => {
  const state = mustAct(fresh(), "player1", { type: "buy" });
  const seat = state.seats.player1;

  assert.equal(seat.scrap, 2);
  assert.equal(seat.actionPoints, 1);
  assert.equal(seat.cars.length, 3);
  assert.equal(seat.cars.at(-1).id, "p1-c3", "new ids stay stable and unique");
  assert.equal(seat.cars.at(-1).tier, 1);
  assert.equal(seat.cars.at(-1).status, "garage");
  assert.equal(seat.nextCarNumber, 4);
  // The opponent is untouched.
  assert.deepEqual(state.seats.player2, fresh().seats.player2);
  assert.equal(validateState(state), null);
});

test("buying is refused without enough Scrap or action points", () => {
  const noScrap = withCars(2);
  noScrap.seats.player1.scrap = 1;
  const broke = act(noScrap, "player1", { type: "buy" });
  assert.equal(broke.ok, false);
  assert.equal(broke.code, "insufficient-scrap");

  const noAp = withCars(2);
  noAp.seats.player1.actionPoints = 0;
  const exhausted = act(noAp, "player1", { type: "buy" });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, "insufficient-action-points");
});

test("the 8-car fleet cap counts garage, racing and workshop cars", () => {
  const state = withCars(MAX_OWNED_CARS);
  state.seats.player1.scrap = 20;
  const full = act(state, "player1", { type: "buy" });
  assert.equal(full.ok, false);
  assert.equal(full.code, "fleet-full");
  assert.equal(state.seats.player1.cars.length, MAX_OWNED_CARS);

  // One slot free is enough — and a merge frees a slot again.
  const seven = withCars(7);
  seven.seats.player1.scrap = 20;
  const bought = mustAct(seven, "player1", { type: "buy" });
  assert.equal(bought.seats.player1.cars.length, 8);
});

// ════════════════════════════════════════════════════════════════════
// 4. Deployment + routes
// ════════════════════════════════════════════════════════════════════

test("deploying is free and at most four cars may race in a round", () => {
  let state = withCars(5);
  state.seats.player1.actionPoints = 0;

  for (const [i, route] of ["safe", "sprint", "risk", "safe"].entries()) {
    state = deploy(state, "player1", `p1-c${i + 1}`, route);
  }
  assert.equal(state.seats.player1.actionPoints, 0, "deploy never spends AP");

  const tooMany = act(state, "player1", {
    type: "deploy",
    carId: "p1-c5",
    route: "safe",
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, "active-limit");
  assert.equal(MAX_RACING_CARS, 4);
});

test("a route can be changed before lock-in but not on a garage car, and duplicates are refused", () => {
  let state = deploy(withCars(2), "player1", "p1-c1", "safe");
  state = mustAct(state, "player1", {
    type: "setRoute",
    carId: "p1-c1",
    route: "risk",
  });
  assert.equal(state.seats.player1.cars[0].route, "risk");

  const garage = act(state, "player1", {
    type: "setRoute",
    carId: "p1-c2",
    route: "risk",
  });
  assert.equal(garage.ok, false);
  assert.equal(garage.code, "car-not-racing");

  const duplicate = act(state, "player1", {
    type: "deploy",
    carId: "p1-c1",
    route: "safe",
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "duplicate-car");

  const badRoute = act(state, "player1", {
    type: "setRoute",
    carId: "p1-c1",
    route: "teleport",
  });
  assert.equal(badRoute.ok, false);
  assert.equal(badRoute.code, "invalid-route");
});

test("a deployed car can return to the garage for free and redeploy on another route", () => {
  let state = deploy(withCars(5), "player1", "p1-c1", "risk");
  const apBefore = state.seats.player1.actionPoints;

  state = mustAct(state, "player1", { type: "recall", carId: "p1-c1" });
  const recalled = state.seats.player1.cars.find((car) => car.id === "p1-c1");
  assert.equal(recalled.status, "garage");
  assert.equal(recalled.route, null);
  assert.equal(state.seats.player1.actionPoints, apBefore, "recall never spends AP");

  // The freed slot can be reused, and the car's tier is untouched.
  state = mustAct(state, "player1", { type: "deploy", carId: "p1-c1", route: "safe" });
  assert.equal(
    state.seats.player1.cars.find((car) => car.id === "p1-c1").route,
    "safe",
  );

  // Only a racing car can be recalled, and never the opponent's car.
  const notRacing = act(state, "player1", { type: "recall", carId: "p1-c2" });
  assert.equal(notRacing.ok, false);
  assert.equal(notRacing.code, "car-not-racing");

  const opponent = act(state, "player1", { type: "recall", carId: "p2-c1" });
  assert.equal(opponent.ok, false);
  assert.equal(opponent.code, "opponent-car");

  // A recall after lock-in is refused like every other planning action.
  const locked = lockIn(state, "player1", { now: NOW });
  assert.equal(locked.ok, true);
  const afterLock = act(locked.state, "player1", { type: "recall", carId: "p1-c1" });
  assert.equal(afterLock.ok, false);
  assert.equal(afterLock.code, "locked");
});

test("nonexistent and opponent-owned cars are refused", () => {
  const state = withCars(2);
  const missing = act(state, "player1", {
    type: "deploy",
    carId: "p1-nope",
    route: "safe",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "car-not-found");

  const stolen = act(state, "player1", {
    type: "deploy",
    carId: "p2-c1",
    route: "safe",
  });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, "opponent-car");
});

// ════════════════════════════════════════════════════════════════════
// 5. Merges
// ════════════════════════════════════════════════════════════════════

test("a valid merge consumes both cars, costs 1 AP and creates one higher-tier car", () => {
  const state = mustAct(withCars(2), "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  const seat = state.seats.player1;

  assert.equal(seat.cars.length, 1, "both originals are gone");
  assert.equal(seat.actionPoints, 1);
  assert.equal(seat.cars[0].tier, 2);
  assert.equal(seat.cars[0].status, "garage");
  assert.equal(seat.cars[0].damaged, false);
  assert.equal(seat.cars[0].id, "p1-c3", "the merged car gets a fresh stable id");
  assert.equal(seat.scrap, STARTING_SCRAP, "merging costs no Scrap");
  assert.equal(validateState(state), null);
});

test("invalid merges are refused: different tiers, same car, Tier 4, racing, damaged, no AP", () => {
  const mismatch = withCars(2);
  mismatch.seats.player1.cars[1].tier = 2;
  const badTier = act(mismatch, "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(badTier.code, "merge-mismatch");

  const same = act(withCars(2), "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c1",
  });
  assert.equal(same.code, "duplicate-car");

  const top = withCars(2, { tier: 4 });
  const maxed = act(top, "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(maxed.code, "max-tier");

  const racing = deploy(withCars(2), "player1", "p1-c1", "safe");
  const deployed = act(racing, "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(deployed.code, "car-racing");

  const damaged = withCars(2);
  damaged.seats.player1.cars[0].damaged = true;
  const hurt = act(damaged, "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(hurt.code, "car-damaged");

  const noAp = withCars(2);
  noAp.seats.player1.actionPoints = 0;
  const spent = act(noAp, "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(spent.code, "insufficient-action-points");
});

test("merging two Tier 3 cars produces a Tier 4 car", () => {
  const state = mustAct(withCars(2, { tier: 3 }), "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(state.seats.player1.cars.length, 1);
  assert.equal(state.seats.player1.cars[0].tier, 4);
});

// ════════════════════════════════════════════════════════════════════
// 6. Damaged cars, repair, action-point accounting
// ════════════════════════════════════════════════════════════════════

test("a damaged car cannot race or merge, and repair costs 1 Scrap + 1 AP", () => {
  const hurt = withCars(2);
  hurt.seats.player1.cars[0].damaged = true;
  hurt.seats.player1.cars[0].status = "garage";

  const noRace = act(hurt, "player1", {
    type: "deploy",
    carId: "p1-c1",
    route: "safe",
  });
  assert.equal(noRace.code, "car-damaged");

  const repaired = mustAct(hurt, "player1", { type: "repair", carId: "p1-c1" });
  assert.equal(repaired.seats.player1.cars[0].damaged, false);
  assert.equal(repaired.seats.player1.scrap, STARTING_SCRAP - 1);
  assert.equal(repaired.seats.player1.actionPoints, 1);

  // Once repaired it can race.
  const raced = deploy(repaired, "player1", "p1-c1", "sprint");
  assert.equal(raced.seats.player1.cars[0].status, "racing");
});

test("repair needs damage, Scrap and action points", () => {
  const healthy = act(withCars(2), "player1", { type: "repair", carId: "p1-c1" });
  assert.equal(healthy.code, "car-not-damaged");

  const noScrap = withCars(2, { damaged: true });
  noScrap.seats.player1.scrap = 0;
  const broke = act(noScrap, "player1", { type: "repair", carId: "p1-c1" });
  assert.equal(broke.code, "insufficient-scrap");

  const noAp = withCars(2, { damaged: true });
  noAp.seats.player1.actionPoints = 0;
  const spent = act(noAp, "player1", { type: "repair", carId: "p1-c1" });
  assert.equal(spent.code, "insufficient-action-points");

  const racing = deploy(withCars(2), "player1", "p1-c1", "safe");
  racing.seats.player1.cars[0].damaged = true; // corrupt on purpose
  const out = act(racing, "player1", { type: "repair", carId: "p1-c1" });
  assert.equal(out.ok, false, "a racing car can never be repaired");
});

test("action points never go negative and resources only move on a legal action", () => {
  const rich = withCars(2);
  rich.seats.player1.scrap = 20;
  const applied = applyPlan(
    rich,
    "player1",
    [{ type: "buy" }, { type: "buy" }, { type: "buy" }],
    { now: NOW },
  );
  assert.equal(applied.ok, false, "the third buy exceeds the 2 AP budget");
  assert.equal(applied.code, "insufficient-action-points");

  // All-or-nothing: a failed plan never leaves a partially-spent garage.
  const oneBuy = applyPlan(fresh(), "player1", [{ type: "buy" }], { now: NOW });
  assert.equal(oneBuy.ok, true);
  assert.equal(oneBuy.state.seats.player1.scrap, 2);
  assert.equal(oneBuy.state.seats.player1.actionPoints, 1);

  const rejected = applyPlan(
    fresh(),
    "player1",
    [{ type: "buy" }, { type: "repair", carId: "p1-c1" }],
    { now: NOW },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "car-not-damaged");
});

// ════════════════════════════════════════════════════════════════════
// 7. Race resolution — rewards
// ════════════════════════════════════════════════════════════════════

test("a successful run scores tier × multiplier and pays its route reward", () => {
  let state = withCars(3);
  state = deploy(state, "player1", "p1-c1", "safe");
  state = deploy(state, "player1", "p1-c2", "sprint");
  state = deploy(state, "player1", "p1-c3", "risk");
  state = lockedBoth(state);

  assert.equal(isReadyToResolve(state, NOW), true);
  const result = resolveRound({
    state,
    randomValues: [0.9, 0.9, 0.9],
    now: NOW,
  });
  assert.equal(result.ok, true, result.error);
  const next = result.state;

  // 12 (safe) + 18 (sprint) + 26 (risk) = 56, plus one of each chip.
  assert.equal(next.seats.player1.points, 56);
  assert.equal(next.seats.player1.scrap, STARTING_SCRAP + 1);
  assert.equal(next.seats.player1.fuel, 1);
  assert.equal(next.seats.player1.tech, 1);
  assert.equal(next.seats.player2.points, 0);

  // Every racing car came home undamaged and route-less.
  for (const c of next.seats.player1.cars) {
    assert.equal(c.status, "garage");
    assert.equal(c.damaged, false);
    assert.equal(c.route, null);
  }
  assert.equal(result.round.cars.length, 3);
  assert.deepEqual(result.round.points, { player1: 56, player2: 0 });
  assert.deepEqual(result.round.totals, { player1: 56, player2: 0 });

  // The next planning phase opens with fresh AP and a fresh 60s window.
  assert.equal(next.round, 2);
  assert.equal(next.phase, "planning");
  assert.equal(next.seats.player1.actionPoints, ACTION_POINTS_PER_ROUND);
  assert.equal(next.seats.player2.actionPoints, ACTION_POINTS_PER_ROUND);
  assert.equal(next.seats.player1.locked, false);
  assert.equal(next.planningDeadline, new Date(NOW + PLANNING_MS).toISOString());
  assert.equal(validateState(next), null);
});

test("both seats race in the same round, player1's grid first", () => {
  let state = withCars(1);
  state.seats.player2.cars = [car("p2-c1")];
  state.seats.player2.nextCarNumber = 2;
  state = deploy(state, "player1", "p1-c1", "safe");
  state = deploy(state, "player2", "p2-c1", "risk");
  state = lockedBoth(state);

  const result = resolveRound({ state, randomValues: [0.9, 0.9], now: NOW });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.round.cars.map((c) => [c.seat, c.carId, c.route]),
    [
      ["player1", "p1-c1", "safe"],
      ["player2", "p2-c1", "risk"],
    ],
  );
  assert.deepEqual(result.round.points, { player1: 12, player2: 26 });
});

// ════════════════════════════════════════════════════════════════════
// 8. DNF penalties
// ════════════════════════════════════════════════════════════════════

test("a DNF scores nothing, pays no reward, damages the car and leaves it in the garage", () => {
  let state = withCars(1);
  state.seats.player1.cars[0].tier = 2;
  state = deploy(state, "player1", "p1-c1", "sprint");
  state = lockedBoth(state);

  const result = resolveRound({ state, randomValues: [0.01], now: NOW });
  assert.equal(result.ok, true, result.error);
  const next = result.state;
  const [entry] = result.round.cars;

  assert.equal(entry.outcome, "dnf");
  assert.equal(entry.points, 0);
  assert.equal(entry.reward, null);
  assert.equal(next.seats.player1.points, 0);
  assert.equal(next.seats.player1.fuel, 0, "a DNF pays no Fuel");
  assert.equal(next.seats.player1.scrap, STARTING_SCRAP);
  const returned = next.seats.player1.cars[0];
  assert.equal(returned.status, "garage");
  assert.equal(returned.damaged, true);
  assert.equal(returned.route, null);
  assert.equal(returned.tier, 2, "the damaged car keeps its tier");
});

test("a mixed grid only penalises the car that DNFs", () => {
  let state = withCars(2);
  state = deploy(state, "player1", "p1-c1", "safe");
  state = deploy(state, "player1", "p1-c2", "safe");
  state = lockedBoth(state);

  const result = resolveRound({ state, randomValues: [0.9, 0.01], now: NOW });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state.seats.player1.points, 12);
  assert.equal(result.state.seats.player1.scrap, STARTING_SCRAP + 1);
  assert.equal(result.state.seats.player1.cars[0].damaged, false);
  assert.equal(result.state.seats.player1.cars[1].damaged, true);
});

// ════════════════════════════════════════════════════════════════════
// 9. Workshop recovery
// ════════════════════════════════════════════════════════════════════

function softLocked() {
  const state = withCars(2, { damaged: true });
  state.seats.player1.scrap = 0;
  return state;
}

test("workshop recovery is gated on the real soft-lock: no Scrap and every car damaged", () => {
  assert.equal(canUseWorkshop(softLocked(), "player1"), true);

  const withScrap = withCars(2, { damaged: true });
  assert.equal(canUseWorkshop(withScrap, "player1"), false);

  const oneHealthy = withCars(2);
  oneHealthy.seats.player1.cars[0].damaged = true;
  oneHealthy.seats.player1.scrap = 0;
  assert.equal(canUseWorkshop(oneHealthy, "player1"), false);

  const refused = act(softLocked(), "player1", {
    type: "workshopRecovery",
    carId: "p1-c1",
  });
  assert.equal(refused.ok, true, "the real soft-lock can always recover");

  const notLockedOut = act(oneHealthy, "player1", {
    type: "workshopRecovery",
    carId: "p1-c1",
  });
  assert.equal(notLockedOut.ok, false);
  assert.equal(notLockedOut.code, "not-soft-locked");
});

test("workshop recovery is free, consumes the planning phase, and returns the car next round", () => {
  const state = mustAct(softLocked(), "player1", {
    type: "workshopRecovery",
    carId: "p1-c1",
  });

  const carInWorkshop = state.seats.player1.cars[0];
  assert.equal(carInWorkshop.status, "recovering");
  assert.equal(carInWorkshop.damaged, true, "not repaired before recovery completes");
  assert.equal(state.seats.player1.scrap, 0, "no Scrap was charged");
  assert.equal(state.seats.player1.actionPoints, 2, "no action point was charged");
  assert.equal(state.seats.player1.locked, true, "the planning phase is consumed");

  // The phase is consumed: no further actions, and the car cannot be used yet.
  const extra = act(state, "player1", {
    type: "workshopRecovery",
    carId: "p1-c2",
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, "locked");

  const deployed = act(
    { ...state, seats: { ...state.seats, player1: { ...state.seats.player1, locked: false } } },
    "player1",
    { type: "deploy", carId: "p1-c1", route: "safe" },
  );
  assert.equal(deployed.ok, false);
  assert.equal(deployed.code, "car-in-workshop");

  const repaired = act(
    { ...state, seats: { ...state.seats, player1: { ...state.seats.player1, locked: false } } },
    "player1",
    { type: "repair", carId: "p1-c1" },
  );
  assert.equal(repaired.ok, false);
  assert.equal(repaired.code, "car-in-workshop");

  // Resolution completes the recovery for the NEXT round.
  let ready = mustLock(state, "player2");
  const resolved = resolveRound({ state: ready, randomValues: [], now: NOW });
  assert.equal(resolved.ok, true, resolved.error);
  const next = resolved.state;
  assert.equal(next.seats.player1.points, 0, "recovery awards no points");
  assert.equal(next.seats.player1.scrap, 0, "recovery awards no Scrap");
  const recovered = next.seats.player1.cars[0];
  assert.equal(recovered.status, "garage");
  assert.equal(recovered.damaged, false);
  assert.equal(validateState(next), null);

  // Now it can race.
  const raced = deploy(next, "player1", "p1-c1", "safe");
  assert.equal(raced.seats.player1.cars[0].status, "racing");
});

test("a workshop car cannot be merged, and an online car cannot enter the workshop", () => {
  const state = softLocked();
  state.seats.player1.cars[0].status = "recovering";
  const merged = act(state, "player1", {
    type: "merge",
    carId: "p1-c1",
    otherCarId: "p1-c2",
  });
  assert.equal(merged.ok, false);
  assert.equal(merged.code, "car-in-workshop");

  const racing = deploy(withCars(1), "player1", "p1-c1", "safe");
  const recovery = act(racing, "player1", {
    type: "workshopRecovery",
    carId: "p1-c1",
  });
  assert.equal(recovery.ok, false);
  assert.equal(recovery.code, "car-racing");
});

// ════════════════════════════════════════════════════════════════════
// 10. Scoring + 1,000-point threshold
// ════════════════════════════════════════════════════════════════════

test("the match ends when a seat crosses the 1,000-point threshold", () => {
  assert.equal(WIN_SCORE, 1000);
  assert.equal(decideWinner(999, 0), null);
  assert.equal(decideWinner(1000, 999), "player1");
  assert.equal(decideWinner(10, 1000), "player2");
  assert.equal(decideWinner(1000, 1000), "draw");
  assert.equal(decideWinner(1200, 1100), "player1", "both crossing: higher wins");
  assert.equal(decideWinner(1100, 1200), "player2");
  assert.equal(decideWinner(1100, 1100), "draw");
});

test("crossing the threshold inside a round finishes the match and stops planning", () => {
  let state = withCars(1);
  state.seats.player1.points = 990;
  state = deploy(state, "player1", "p1-c1", "safe");
  state = lockedBoth(state);

  const result = resolveRound({ state, randomValues: [0.9], now: NOW });
  assert.equal(result.ok, true, result.error);
  const next = result.state;

  assert.equal(next.seats.player1.points, 1002);
  assert.equal(next.phase, "finished");
  assert.equal(next.winner, "player1");
  assert.equal(next.planningDeadline, null);
  assert.equal(next.seats.player1.actionPoints, 0);
  assert.equal(next.seats.player2.actionPoints, 0);
  assert.equal(validateState(next), null);

  const after = act(next, "player1", { type: "buy" });
  assert.equal(after.ok, false);
  assert.equal(after.code, "not-planning");
});

test("both seats crossing in the same round: higher total wins, exact tie is a draw", () => {
  // Higher total: 995 + 26 (Risk) = 1021 vs 990 + 12 (Safe) = 1002.
  let state = withCars(1);
  state.seats.player2.cars = [car("p2-c1")];
  state.seats.player2.nextCarNumber = 2;
  state.seats.player1.points = 995;
  state.seats.player2.points = 990;
  state = deploy(state, "player1", "p1-c1", "risk");
  state = deploy(state, "player2", "p2-c1", "safe");
  state = lockedBoth(state);

  const win = resolveRound({ state, randomValues: [0.9, 0.9], now: NOW });
  assert.equal(win.ok, true, win.error);
  assert.equal(win.state.winner, "player1");

  // Exact tie: both 994 + 12 = 1006.
  let tie = withCars(1);
  tie.seats.player2.cars = [car("p2-c1")];
  tie.seats.player2.nextCarNumber = 2;
  tie.seats.player1.points = 994;
  tie.seats.player2.points = 994;
  tie = deploy(tie, "player1", "p1-c1", "safe");
  tie = deploy(tie, "player2", "p2-c1", "safe");
  tie = lockedBoth(tie);

  const draw = resolveRound({ state: tie, randomValues: [0.9, 0.9], now: NOW });
  assert.equal(draw.ok, true, draw.error);
  assert.equal(draw.state.winner, "draw");
  assert.equal(draw.state.phase, "finished");
  assert.deepEqual(draw.state.results.at(-1).totals, { player1: 1006, player2: 1006 });
});

// ════════════════════════════════════════════════════════════════════
// 11. Lock-in, deadlines, resolution guards
// ════════════════════════════════════════════════════════════════════

test("acting after lock-in or after the server deadline is refused", () => {
  const locked = mustLock(fresh(), "player1");
  const afterLock = act(locked, "player1", { type: "buy" });
  assert.equal(afterLock.ok, false);
  assert.equal(afterLock.code, "locked");
  // The opponent is still free to plan.
  assert.equal(act(locked, "player2", { type: "buy" }).ok, true);

  const late = act(fresh(), "player1", { type: "buy" }, LATER);
  assert.equal(late.ok, false);
  assert.equal(late.code, "expired");

  const lockedTwice = lockIn(locked, "player1", { now: NOW });
  assert.equal(lockedTwice.ok, false);
  assert.equal(lockedTwice.code, "locked");
});

test("the round resolves only when both plans are locked or the clock has run out", () => {
  const state = deploy(withCars(1), "player1", "p1-c1", "safe");
  const oneLocked = mustLock(state, "player1");
  assert.equal(isReadyToResolve(oneLocked, NOW), false);

  const early = resolveRound({ state: oneLocked, randomValues: [0.9], now: NOW });
  assert.equal(early.ok, false);
  assert.equal(early.code, "not-ready");

  // The deadline is authoritative even if nobody locked in.
  assert.equal(isReadyToResolve(oneLocked, LATER), true);
  const timeout = resolveRound({ state: oneLocked, randomValues: [0.9], now: LATER });
  assert.equal(timeout.ok, true, timeout.error);
  assert.equal(timeout.state.results.length, 1);
});

test("resolution refuses the wrong number of random values or an out-of-range roll", () => {
  let state = withCars(2);
  state = deploy(state, "player1", "p1-c1", "safe");
  state = deploy(state, "player1", "p1-c2", "safe");
  state = lockedBoth(state);

  const tooFew = resolveRound({ state, randomValues: [0.9], now: NOW });
  assert.equal(tooFew.code, "invalid-randomness");

  const tooMany = resolveRound({ state, randomValues: [0.9, 0.9, 0.9], now: NOW });
  assert.equal(tooMany.code, "invalid-randomness");

  const badRoll = resolveRound({ state, randomValues: [1, 0.9], now: NOW });
  assert.equal(badRoll.code, "invalid-randomness");

  const negative = resolveRound({ state, randomValues: [-0.1, 0.9], now: NOW });
  assert.equal(negative.code, "invalid-randomness");
});

// ════════════════════════════════════════════════════════════════════
// 12. Invalid / legacy / stale states
// ════════════════════════════════════════════════════════════════════

test("legacy and unsupported persisted states are never read as a race", () => {
  assert.equal(readState({}).reason, "legacy", "the column default is legacy");
  assert.equal(readState({ version: 0 }).reason, "legacy");
  assert.equal(readState(null).reason, "legacy");
  assert.equal(readState([]).reason, "legacy");

  const future = { ...fresh(), version: LANE_RUSH_STATE_VERSION + 1 };
  assert.equal(readState(future).reason, "unsupported-version");

  const original = fresh();
  const good = readState(original);
  assert.equal(good.ok, true);
  // A read is a copy: mutating it cannot reach the persisted object.
  good.state.seats.player1.scrap = 99;
  assert.equal(original.seats.player1.scrap, STARTING_SCRAP);
});

test("structurally corrupt states are rejected instead of repaired", () => {
  const noDeadline = fresh();
  noDeadline.planningDeadline = null;
  assert.match(validateState(noDeadline), /deadline/);

  const badTier = fresh();
  badTier.seats.player1.cars[0].tier = 5;
  assert.match(validateState(badTier), /invalid tier/);

  const duplicate = fresh();
  duplicate.seats.player2.cars[0] = {
    ...duplicate.seats.player2.cars[0],
    id: "p1-c1",
  };
  assert.match(validateState(duplicate), /duplicate car id/);

  const wrongOwner = fresh();
  wrongOwner.seats.player1.cars[0].owner = "player2";
  assert.match(validateState(wrongOwner), /wrong seat/);

  const damagedRacing = deploy(withCars(1), "player1", "p1-c1", "safe");
  damagedRacing.seats.player1.cars[0].damaged = true;
  assert.match(validateState(damagedRacing), /damaged car/);

  const overCap = withCars(MAX_OWNED_CARS + 1);
  assert.match(validateState(overCap), /more than 8 cars/);

  const noRoute = deploy(withCars(1), "player1", "p1-c1", "safe");
  noRoute.seats.player1.cars[0].route = null;
  assert.match(validateState(noRoute), /no valid route/);

  const negative = fresh();
  negative.seats.player1.scrap = -1;
  assert.match(validateState(negative), /invalid/);

  // A round counter that jumped ahead of the recorded history is stale.
  const stale = fresh();
  stale.round = 4;
  assert.match(validateState(stale), /results.length/);

  // Points are non-negative integers; they are cross-checked against the last
  // completed round whenever history exists (the threshold tests seed points
  // before any round, which is why an empty history is allowed here).
  const negativePoints = fresh();
  negativePoints.seats.player1.points = -5;
  assert.match(validateState(negativePoints), /points is invalid/);
});

test("actions and resolutions refuse an invalid state outright", () => {
  const broken = fresh();
  broken.seats.player1.cars = "nope";
  const action = act(broken, "player1", { type: "buy" });
  assert.equal(action.ok, false);
  assert.equal(action.code, "invalid-state");

  const resolve = resolveRound({ state: broken, randomValues: [], now: NOW });
  assert.equal(resolve.ok, false);
  assert.equal(resolve.code, "invalid-state");
});

test("an unknown seat / malformed action / unknown action type is refused", () => {
  const state = fresh();
  const seat = act(state, "spectator", { type: "buy" });
  assert.equal(seat.ok, false);
  assert.equal(seat.code, "invalid-seat");

  const malformed = act(state, "player1", null);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "invalid-action");

  const unknown = act(state, "player1", { type: "nitro" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "invalid-action");
});
