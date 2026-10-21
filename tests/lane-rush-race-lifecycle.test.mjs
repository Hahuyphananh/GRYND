/**
 * Lane Rush — authoritative racing lifecycle tests.
 *
 * Two layers, matching how the repo tests other DB-backed PvP games:
 *
 *   1. PURE simulation of the exact rules the store drives — staggered
 *      lock-ins, both locking early, deadline expiry (the documented
 *      auto-finalize policy), round advancement and the 1,000-point finish.
 *   2. CONTRACT assertions over the real source: row locking, idempotency,
 *      stale-round/version rejection, the two-step exactly-once resolution,
 *      server-only randomness, opponent-plan privacy, bot planning, legacy
 *      dispatch, and the single shared settlement path.
 *
 * No Postgres is available in this test run, so the SQL-level assertions are
 * structural (the same approach the repo uses for its other PvP suites).
 *
 * Run:  node --import tsx --test tests/lane-rush-race-lifecycle.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyAction,
  canUseWorkshop,
  createInitialState,
  isReadyToResolve,
  lockIn,
  readState,
  resolveRound,
  validateState,
} from "../src/lib/lane-rush/engine.ts";
import { planBotTurn } from "../src/lib/lane-rush/bot.ts";
import {
  ACTION_POINTS_PER_ROUND,
  PLANNING_MS,
  WIN_SCORE,
} from "../src/lib/lane-rush/rules.ts";
import {
  RESULT,
  computePayout,
} from "../src/lib/lane-rush-duel/constants.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const store = read("src/lib/lane-rush/raceStore.ts");
const engine = read("src/lib/lane-rush/engine.ts");
const bot = read("src/lib/lane-rush/bot.ts");
const actRoute = read("src/app/api/lane-rush-duel/match/[matchId]/act/route.js");
const matchRoute = read("src/app/api/lane-rush-duel/match/[matchId]/route.js");
const aiRoute = read("src/app/api/lane-rush-duel/match/[matchId]/ai-turn/route.js");
const resignRoute = read("src/app/api/lane-rush-duel/match/[matchId]/resign/route.js");
const legacyStore = read("src/lib/lane-rush-duel/serverStore.js");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const LATER = NOW + PLANNING_MS;

const fresh = () => createInitialState({ now: NOW });

function must(result, label = "action") {
  assert.equal(result.ok, true, `${label}: ${result.error}`);
  return result.state;
}

function deploy(state, seat, carId, route, now = NOW) {
  return must(
    applyAction(state, seat, { type: "deploy", carId, route }, { now }),
    `deploy ${carId}`,
  );
}

function lock(state, seat, now = NOW) {
  return must(lockIn(state, seat, { now }), `lock ${seat}`);
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

/** Drive the engine exactly the way the store does: one validated plan. */
function resolve(state, values, now = NOW) {
  const result = resolveRound({ state, randomValues: values, now });
  assert.equal(result.ok, true, result.error);
  return result;
}

// ════════════════════════════════════════════════════════════════════
// 1. Staggered lock-ins
// ════════════════════════════════════════════════════════════════════

test("players lock at different times: the early seat is frozen, the other keeps planning", () => {
  let state = fresh();
  state = deploy(state, "player1", "p1-c1", "safe");
  state = deploy(state, "player2", "p2-c1", "safe");

  const early = lock(state, "player1");
  assert.equal(early.seats.player1.locked, true);
  assert.equal(early.seats.player2.locked, false);
  assert.equal(isReadyToResolve(early, NOW), false, "one lock does not resolve");

  // The early seat cannot act any more…
  const frozen = applyAction(
    early,
    "player1",
    { type: "buy" },
    { now: NOW },
  );
  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "locked");

  // …while the other seat can still change its plan right up to its own lock.
  const changed = must(
    applyAction(
      early,
      "player2",
      { type: "setRoute", carId: "p2-c1", route: "risk" },
      { now: NOW },
    ),
    "late seat route change",
  );
  assert.equal(changed.seats.player2.cars[0].route, "risk");

  const both = lock(changed, "player2");
  assert.equal(isReadyToResolve(both, NOW), true);

  const resolved = resolve(both, [0.9, 0.9]);
  assert.equal(resolved.round.round, 1);
  assert.deepEqual(resolved.round.points, { player1: 12, player2: 26 });
  assert.equal(resolved.state.round, 2);
  assert.equal(resolved.state.seats.player1.locked, false, "next phase is open");
  assert.equal(resolved.state.seats.player2.locked, false);
  assert.equal(
    resolved.state.seats.player1.actionPoints,
    ACTION_POINTS_PER_ROUND,
    "both seats get a fresh 2 AP",
  );
  assert.equal(validateState(resolved.state), null);
});

test("both players locking early resolves immediately, without waiting for the clock", () => {
  let state = deploy(fresh(), "player1", "p1-c1", "safe");
  state = deploy(state, "player2", "p2-c1", "sprint");
  state = lock(lock(state, "player1"), "player2");

  assert.equal(isReadyToResolve(state, NOW), true);
  assert.equal(isReadyToResolve(state, LATER - 1), true, "always ready once both locked");

  const resolved = resolve(state, [0.9, 0.9], NOW);
  assert.equal(resolved.state.results.length, 1);
  assert.equal(resolved.state.seats.player2.points, 18);
});

// ════════════════════════════════════════════════════════════════════
// 2. Deadline expiry policy
// ════════════════════════════════════════════════════════════════════

test("at the deadline the remaining plan is auto-finalized exactly as deployed", () => {
  // Documented policy: a seat that never locked in races the grid it had
  // deployed; unsubmitted actions were never persisted, so nothing else can
  // be invented for it.
  let state = fresh();
  state = deploy(state, "player1", "p1-c1", "safe");
  state = deploy(state, "player1", "p1-c2", "sprint");
  state = deploy(state, "player2", "p2-c1", "risk");
  state = lock(state, "player1");

  assert.equal(isReadyToResolve(state, LATER - 1), false, "not ready before the bell");
  assert.equal(isReadyToResolve(state, LATER), true, "the server deadline is authoritative");

  const resolved = resolve(state, [0.9, 0.9, 0.9], LATER);
  assert.equal(resolved.round.cars.length, 3, "both grids raced");
  assert.deepEqual(resolved.round.points, { player1: 30, player2: 26 });
  assert.equal(resolved.state.round, 2);
  assert.equal(resolved.state.seats.player2.locked, false, "new phase, unlocked");
});

test("a late plan is refused: the engine deadline, not the client clock, decides", () => {
  const late = applyAction(fresh(), "player1", { type: "buy" }, { now: LATER });
  assert.equal(late.ok, false);
  assert.equal(late.code, "expired");

  // The store also re-checks before applying, and the resolver re-checks again.
  assert.ok(store.includes("isPlanningExpired(state, at)"));
  assert.ok(store.includes("isReadyToResolve(syncPlanningDeadline(decoded.state, row), Date.now())"));
});

// ════════════════════════════════════════════════════════════════════
// 3. Stale rounds / duplicate actions
// ════════════════════════════════════════════════════════════════════

test("a plan for an old round no longer matches the state the engine advanced to", () => {
  let state = deploy(fresh(), "player1", "p1-c1", "safe");
  state = deploy(state, "player2", "p2-c1", "safe");
  const resolved = resolve(lock(lock(state, "player1"), "player2"), [0.9, 0.9]);

  const next = resolved.state;
  assert.equal(next.round, 2);
  // A client that still thinks it is round 1 is rejected by the store's
  // expectedRound guard (asserted structurally below).
  assert.ok(store.includes("expectedRound != null && Number(expectedRound) !== state.round"));
  assert.ok(store.includes('"stale_round"'));
  assert.ok(store.includes("expectedStateVersion != null"));
  assert.ok(store.includes('"stale_state"'));
});

test("duplicate protection is checked before anything else and scoped to the seat", () => {
  const duplicateAt = store.indexOf("const existing = hasActionId(log, id);");
  const statusAt = store.indexOf("if (match.status === MATCH_STATUS.FINISHED");
  const applyAt = store.indexOf("const action = normaliseAction(raw);");
  assert.ok(duplicateAt > 0 && statusAt > duplicateAt, "duplicate check precedes state checks");
  assert.ok(duplicateAt < applyAt, "duplicate check precedes any action");
  assert.ok(store.includes("existing.seat !== seat"));
  assert.ok(store.includes('"action_id_conflict"'));
  assert.ok(store.includes("return { duplicate: true, match };"));
  // A duplicate is a success no-op: the route does not broadcast anything.
  assert.ok(actRoute.includes("if (!plan.duplicate)"));
});

test("a whole plan is all-or-nothing: the engine is applied to a clone and persisted once", () => {
  // The store holds the state locally, applies each action with the engine,
  // and writes ONE row update at the end. There is no intermediate write.
  const submitBody = store.slice(
    store.indexOf("export async function submitRacePlan("),
    store.indexOf("// ── Practice bot"),
  );
  assert.equal(
    (submitBody.match(/\.update\(laneRushDuelMatches\)/g) || []).length,
    1,
    "one persisting update per plan",
  );
  assert.ok(submitBody.includes("for (const raw of actions)"));
  assert.ok(submitBody.includes('return fail(result.error, codeStatus(result.code), result.code);'));
  assert.ok(submitBody.includes("actions: [...log, entry]"));
});

// ════════════════════════════════════════════════════════════════════
// 4. Simultaneous requests + exactly-once resolution
// ════════════════════════════════════════════════════════════════════

test("every mutation takes the row lock before reading, and resolution consumes a marker", () => {
  assert.ok(store.includes('.for("update")'), "rows are locked FOR UPDATE");
  assert.equal(
    (store.match(/await fetchForUpdate\(tx, matchId\)/g) || []).length >= 5,
    true,
    "every mutation path locks the row",
  );

  const resolver = store.slice(
    store.indexOf("export async function resolveRaceRound("),
    store.indexOf("export async function resolveRaceIfReady("),
  );
  assert.ok(
    resolver.includes("if (match.status !== MATCH_STATUS.RESOLVING)"),
    "the marker is consumed exactly once",
  );
  assert.ok(resolver.includes("return { resolved: false, already: true };"));
  assert.ok(resolver.includes("eq(laneRushDuelMatches.status, MATCH_STATUS.RESOLVING)"));
  assert.ok(resolver.includes("status: MATCH_STATUS.ACTIVE,"));
  // The marker is set by a conditional update from `active` only.
  const marker = store.slice(
    store.indexOf("async function markResolving("),
    store.indexOf("export async function resolveRaceRound("),
  );
  assert.ok(marker.includes("if (!isReadyToResolve(syncPlanningDeadline(decoded.state, match), Date.now())) {"));
  assert.ok(marker.includes("eq(laneRushDuelMatches.status, MATCH_STATUS.ACTIVE)"));
});

test("the complete result is persisted in the same transaction that settles a finished match", () => {
  const resolver = store.slice(
    store.indexOf("export async function resolveRaceRound("),
    store.indexOf("export async function resolveRaceIfReady("),
  );
  assert.ok(resolver.includes("const result = resolveRound({"));
  assert.ok(resolver.includes("const next = result.state;"));
  assert.ok(resolver.includes("gameState: next"));
  assert.ok(resolver.includes("p1Points: next.seats.player1.points"));
  assert.ok(resolver.includes("p2Points: next.seats.player2.points"));
  assert.ok(resolver.includes("await settleLaneRushMatch("));
  // Exactly one settlement call in the resolver, inside the same transaction.
  assert.equal((resolver.match(/settleLaneRushMatch\(/g) || []).length, 1);
  // Settlement only on the finish branch.
  const finishAt = resolver.indexOf('if (next.phase === "finished")');
  const settleAt = resolver.indexOf("settleLaneRushMatch(");
  const nextRoundAt = resolver.indexOf("status: MATCH_STATUS.ACTIVE,");
  assert.ok(finishAt > 0 && settleAt > finishAt);
  assert.ok(nextRoundAt > settleAt, "the active-path write comes after the finished branch");
});

test("a resolver retry would advance another round if the marker were not consumed", () => {
  // Why the store needs the resolving marker: the engine is deliberately NOT
  // idempotent — applying the same locked state twice produces round 2, then
  // round 3. Only the persisted marker makes the operation exactly-once.
  let state = deploy(fresh(), "player1", "p1-c1", "safe");
  state = lock(state, "player1");
  state = lock(state, "player2");

  const first = resolve(state, [0.9]);
  const replay = resolveRound({
    state: first.state,
    randomValues: [],
    // Round 2's own deadline; nothing is deployed, so it resolves empty.
    now: NOW + PLANNING_MS,
  });
  // The replayed call cannot re-resolve the ALREADY-resolved round: it settles
  // the next one, i.e. it is a new round.
  assert.equal(replay.ok, true);
  assert.equal(replay.round.round, 2);
  assert.notEqual(replay.round.round, first.round.round);

  assert.ok(store.includes('if (match.status !== MATCH_STATUS.RESOLVING)'));
  assert.ok(store.includes("return { resolved: false, already: true };"));
});

test("simultaneous locks cannot double-advance or double-award", () => {
  // Both players lock in the same instant: the store's idempotency key is the
  // action id, and the resolver's is the resolving marker, both inside a
  // FOR UPDATE transaction.
  assert.ok(store.includes("const match = await fetchForUpdate(tx, matchId);"));
  assert.ok(store.includes("eq(laneRushDuelMatches.status, MATCH_STATUS.ACTIVE),"));
  assert.ok(store.includes('if (!updated) return fail("Match changed — refresh", 409, "stale_match");'));
  // A status read can resume a crashed resolver, but only while resolving.
  assert.ok(store.includes('if (row.status === MATCH_STATUS.RESOLVING)'));
});

// ════════════════════════════════════════════════════════════════════
// 5. Reconnect payload / privacy
// ════════════════════════════════════════════════════════════════════

test("the status view recovers the whole race and hides the opponent's plan", () => {
  const view = store.slice(
    store.indexOf("export function raceMatchView("),
    store.indexOf("// ── Ready → planning"),
  );
  for (const field of [
    "phase",
    "round",
    "planningDeadline",
    "serverNow",
    "locked",
    "oppLocked",
    "actionPoints",
    "myPoints",
    "oppPoints",
    "myResources",
    "myCars",
    "oppCars",
    "lifecycle",
    "stateAvailable",
  ]) {
    assert.ok(view.includes(`${field}:`), `view exposes ${field}`);
  }
  // Shorthand properties still expose the resolved round history.
  assert.ok(view.includes("    results,"));
  assert.ok(view.includes("    lastResult,"));
  assert.ok(view.includes("const hideRoute ="));
  // `publicCar` is defined just above the view but is the single redaction point.
  assert.ok(store.includes("route: hideRoute ? null : car.route"));
  assert.ok(view.includes("publicCar(car, hideRoute)"));
  // The opponent's economy is never sent; only the viewer's resources.
  assert.ok(!view.includes("theirResources"));
  assert.ok(!view.includes("oppResources"));
  // No socket or in-memory state is needed: the view is built from the row.
  assert.ok(matchRoute.includes("fetchRaceMatchWithAutoResolve(userId, matchId)"));
});

test("the view is rebuilt from the database on every read (no in-memory match state)", () => {
  const fetchBody = store.slice(
    store.indexOf("export async function fetchRaceMatchWithAutoResolve("),
    store.indexOf("// ── Planning actions"),
  );
  assert.ok(fetchBody.includes("const row = await loadMatch(matchId);"));
  assert.ok(fetchBody.includes("const fresh = (await loadMatch(matchId)) || row;"));
  assert.ok(fetchBody.includes("raceMatchView(fresh, userId, decodeState(fresh.gameState))"));
  assert.ok(!fetchBody.includes("new Map("));
  assert.ok(!fetchBody.includes("globalThis"));
});

// ════════════════════════════════════════════════════════════════════
// 6. Threshold finish + tie-break
// ════════════════════════════════════════════════════════════════════

test("reaching 1,000 points finishes the race once; both crossing uses the deterministic tie-break", () => {
  // Higher total wins when both cross in the same round.
  let state = fresh();
  state.seats.player2.cars = [car("p2-c1")];
  state.seats.player2.nextCarNumber = 2;
  state.seats.player1.points = 995;
  state.seats.player2.points = 990;
  state = deploy(state, "player1", "p1-c1", "risk");
  state = deploy(state, "player2", "p2-c1", "safe");
  const won = resolve(lock(lock(state, "player1"), "player2"), [0.9, 0.9]);

  assert.equal(won.state.seats.player1.points, 1021);
  assert.equal(won.state.seats.player2.points, 1002);
  assert.equal(won.state.phase, "finished");
  assert.equal(won.state.winner, "player1");
  assert.equal(won.state.planningDeadline, null);
  assert.equal(won.state.seats.player1.actionPoints, 0);
  assert.equal(validateState(won.state), null);

  // Exact tie → draw.
  let tie = fresh();
  tie.seats.player2.cars = [car("p2-c1")];
  tie.seats.player2.nextCarNumber = 2;
  tie.seats.player1.points = WIN_SCORE - 6;
  tie.seats.player2.points = WIN_SCORE - 6;
  const safe = deploy(deploy(tie, "player1", "p1-c1", "safe"), "player2", "p2-c1", "safe");
  const drawn = resolve(lock(lock(safe, "player1"), "player2"), [0.9, 0.9]);
  assert.equal(drawn.state.winner, "draw");
  assert.equal(drawn.state.phase, "finished");
});

test("reconnecting during results recovers the resolved round and the reopened planning phase", () => {
  let state = deploy(fresh(), "player1", "p1-c1", "safe");
  state = deploy(state, "player2", "p2-c1", "sprint");
  const resolved = resolve(lock(lock(state, "player1"), "player2"), [0.9, 0.9]);

  // The API hands the client a JSON copy; reading it back must be lossless.
  const roundTrip = JSON.parse(JSON.stringify(resolved.state));
  const decoded = readState(roundTrip);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.state.round, 2, "the next planning phase is already open");
  assert.equal(decoded.state.results.length, 1);
  assert.deepEqual(decoded.state.results[0].totals, { player1: 12, player2: 18 });
  assert.equal(decoded.state.results[0].cars.length, 2);
  assert.equal(decoded.state.planningDeadline, new Date(NOW + PLANNING_MS).toISOString());
});

// ════════════════════════════════════════════════════════════════════
// 7. Bot practice
// ════════════════════════════════════════════════════════════════════

test("the practice bot submits only legal engine actions and locks in", () => {
  const state = fresh();
  const plan = planBotTurn({
    state,
    seat: "player2",
    difficulty: "hard",
    now: NOW,
    random: () => 0.5,
  });

  assert.equal(plan.locked, true);
  assert.equal(validateState(plan.state), null);
  const racing = plan.state.seats.player2.cars.filter((c) => c.status === "racing");
  assert.ok(racing.length <= 4);
  assert.ok(plan.state.seats.player2.actionPoints >= 0);

  // Replaying the actions through the engine reproduces the same state.
  let cursor = state;
  for (const action of plan.actions) {
    cursor = must(applyAction(cursor, "player2", action, { now: NOW }), action.type);
  }
  cursor = must(lockIn(cursor, "player2", { now: NOW }), "lock");
  assert.deepEqual(cursor, plan.state);
});

test("the bot uses the free workshop instead of soft-locking, and never plans late", () => {
  const stuck = fresh();
  stuck.seats.player2.scrap = 0;
  stuck.seats.player2.cars = [car("p2-c1", { damaged: true }), car("p2-c2", { damaged: true })];
  assert.equal(canUseWorkshop(stuck, "player2"), true);

  const plan = planBotTurn({ state: stuck, seat: "player2", now: NOW, random: () => 0.5 });
  assert.equal(plan.actions[0].type, "workshopRecovery");
  assert.equal(plan.locked, true);
  assert.equal(plan.state.seats.player2.cars[0].status, "recovering");

  const late = planBotTurn({
    state: fresh(),
    seat: "player2",
    now: LATER,
    random: () => 0.5,
  });
  assert.deepEqual(late.actions, []);
  assert.equal(late.locked, false);
});

test("a draw refunds both seats through the shared payout helper", () => {
  const draw = computePayout({ stakeAmount: 25, result: RESULT.DRAW });
  assert.equal(draw.refundEach, 25, "settleEscrow refunds this exact field");
  assert.equal(draw.houseFee, 0);
  assert.equal(draw.prizePaid, 0);

  const win = computePayout({ stakeAmount: 25, result: RESULT.PLAYER1 });
  assert.equal(win.winnerNet, 45, "1.8× a 25-coin stake");
  assert.equal(win.refundEach, null);
});

test("the one shared settlement moves escrow, stats, Elo, trophies and leaderboards exactly once", () => {
  const settleBody = legacyStore.slice(
    legacyStore.indexOf("async function settle(tx, match,"),
    legacyStore.indexOf("// Best-effort stat side-effect"),
  );
  for (const call of [
    "mirrorQueueTransition(",
    "await settleEscrow(tx, finalRow, escrow);",
    "recordPvPResult(",
    "markDailyRewardWin(",
  ]) {
    assert.ok(settleBody.includes(call), `settlement runs ${call}`);
  }
  assert.ok(legacyStore.includes("await applyRatingResult("));
  assert.ok(legacyStore.includes("await applyTrophyResult("));
  assert.ok(legacyStore.includes("applyLeaderboardCounters("));
  assert.ok(legacyStore.includes("export async function settleLaneRushMatch("));
  assert.ok(store.includes("await settleLaneRushMatch("));
  // Only the finish branch settles, and settlement is inside the resolver's
  // row-locked transaction (so a retry sees `finished` and pays nothing).
  assert.ok(store.indexOf("await settleLaneRushMatch(") > store.indexOf('if (next.phase === "finished")'));
});

test("practice settlement stays on the zero-stake, unrated path", () => {
  // The bot match is marked by the reserved bot id; the shared settlement
  // helper excludes it from escrow, stats, Elo and trophies.
  assert.ok(legacyStore.includes("function escrowFor(match, result, winnerId)"));
  assert.ok(legacyStore.includes("if (stake <= 0 || isBotMatch(match))"));
  assert.ok(legacyStore.includes("if (result !== RESULT.DRAW && !isBotMatch(finalRow))"));
  assert.ok(legacyStore.includes("export async function settleLaneRushMatch("));
  assert.ok(store.includes("await settleLaneRushMatch("));
  assert.ok(store.includes("planBotTurn({"));
  assert.ok(!store.includes("decideBridgeBotAction"));
});

// ════════════════════════════════════════════════════════════════════
// 8. Resignation / cancellation / legacy dispatch
// ════════════════════════════════════════════════════════════════════

test("resignation settles through the same path and marks the race finished", () => {
  assert.ok(resignRoute.includes("isRaceMatch(existingRow)"));
  assert.ok(resignRoute.includes("resignRaceMatch({ userId, matchId })"));
  assert.ok(store.includes("export async function resignRaceMatch("));
  assert.ok(store.includes("next.phase = \"finished\""));
  assert.ok(store.includes("await settleLaneRushMatch("));
  assert.ok(store.includes('reason: "resigned"'));
  assert.ok(store.includes("if (match.status === MATCH_STATUS.WAITING)"));
});

test("cancellation remains the waiting-only legacy path", () => {
  const cancelRoute = read("src/app/api/lane-rush-duel/match/[matchId]/cancel/route.js");
  assert.ok(cancelRoute.includes("cancelMatch({ userId, matchId })"));
  assert.ok(legacyStore.includes("match.status !== MATCH_STATUS.WAITING"));
  assert.ok(legacyStore.includes("Only the creator can cancel"));
});

test("legacy bridge rows still dispatch to the old transitions", () => {
  // Version dispatch on every gameplay route.
  assert.ok(store.includes("return Number(match?.gameStateVersion) === LANE_RUSH_STATE_VERSION;"));
  assert.ok(actRoute.includes("if (isRaceMatch(existingRow))"));
  assert.ok(actRoute.includes("const result = await act({ userId, matchId, action, row, tile, actionId });"));
  assert.ok(aiRoute.includes("if (isRaceMatch(existingRow))"));
  assert.ok(aiRoute.includes("botAct({ matchId, requesterId: userId, actionId })"));
  assert.ok(matchRoute.includes("if (existingRow && isRaceMatch(existingRow))"));
  assert.ok(matchRoute.includes("fetchMatchWithAutoResolve(userId, matchId)"));
  // New matches are stamped as races; legacy rows keep version 0.
  assert.ok(legacyStore.includes("gameStateVersion: LANE_RUSH_STATE_VERSION"));
  assert.ok(legacyStore.includes("const gameState = createInitialState({ now: Date.now() });"));
});

// ════════════════════════════════════════════════════════════════════
// 9. Server-only authority
// ════════════════════════════════════════════════════════════════════

test("race randomness is server-only and clients can never submit an outcome", () => {
  assert.ok(store.includes("crypto.randomBytes(4).readUInt32BE(0)"));
  assert.ok(store.includes("randomValues: serverRolls(plannedCarCount(state))"));
  assert.ok(!store.includes("Math.random"));
  for (const forbidden of ["body.roll", "body.score", "body.winner", "body.dnf", "body.random"]) {
    assert.ok(!actRoute.includes(forbidden), `the route never trusts ${forbidden}`);
    assert.ok(!store.includes(forbidden), `the store never trusts ${forbidden}`);
  }
  assert.ok(store.includes("function normaliseAction("));
  assert.ok(store.includes('case "buy":'));
  assert.ok(store.includes('case "workshopRecovery":'));
  assert.ok(!store.includes("decideOutcome("), "the race never derives a winner from a loser");
});

test("the planning clock is server-owned and restamped when the ready banner closes", () => {
  assert.ok(store.includes("export async function advanceRaceToPlanning("));
  assert.ok(store.includes("beginPlanning(decoded.state, { now: Date.now() })"));
  // The persisted roundDeadline column remains the clock the existing
  // practice-pause service shifts; every deadline decision re-syncs from it.
  assert.ok(store.includes("function syncPlanningDeadline("));
  assert.ok(store.includes("roundDeadline: state.planningDeadline ? new Date(state.planningDeadline) : null"));
  assert.ok(store.includes("status: MATCH_STATUS.ACTIVE,"));
  assert.ok(store.includes("roundDeadline: new Date(begun.state.planningDeadline as string)"));
  // The view gives the client the server's clock for display only.
  assert.ok(store.includes("serverNow: new Date().toISOString()"));
  assert.ok(store.includes("deadlinePassed: state ? isPlanningExpired(state, Date.now()) : false"));
});

test("the engine and bot contain no lifecycle shortcuts around the validation", () => {
  assert.ok(engine.includes("export function isReadyToResolve("));
  assert.ok(engine.includes("const bothLocked = SEATS.every"));
  assert.ok(engine.includes("return bothLocked || isPlanningExpired(state, now);"));
  assert.ok(bot.includes("const result = applyAction(current, seat, action, { now: at });"));
  assert.ok(bot.includes("if (!result.ok) return false;"));
  assert.ok(bot.includes("lockIn(current, seat, { now: at })"));
});
