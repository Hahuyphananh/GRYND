// src/lib/lane-rush/engine.ts
//
// Pure, server-authoritative engine for Lane Rush — simultaneous-planning
// strategic racing.
//
// NOTHING in this module touches the database, React, `Math.random` or a
// clock it was not handed. Every mutation is a pure `state in → state out`
// transition, and every race outcome comes from authoritative random values
// the server supplies. That is what makes the rules unit-testable and stops a
// client from deciding its own DNFs.
//
// The lifecycle of one round:
//
//   planning (60s, 2 AP)          race resolution              next round
//   ─────────────────────         ─────────────────            ──────────
//   buy / deploy / recall /       resolveRound(randomValues) → buy / deploy …
//   setRoute
//   merge / repair / recovery     (both locked or deadline)     AP reset to 2
//   lockIn                        DNF → damaged, garage
//                                 success → points + reward
//                                 workshop cars return
//
// Everything is additive: the legacy glass-bridge duel in
// `src/lib/lane-rush-duel/` keeps working untouched, and persisted race state
// is versioned so a legacy row can never be mistaken for a race.

import {
  ACTION_POINTS_PER_ROUND,
  BUY_COST,
  LANE_RUSH_STATE_VERSION,
  MAX_OWNED_CARS,
  MAX_RACING_CARS,
  MERGE_COST,
  PLANNING_MS,
  REPAIR_COST,
  RESOURCES,
  SEATS,
  STARTING_CARS,
  STARTING_FUEL,
  STARTING_SCRAP,
  STARTING_TECH,
  WIN_SCORE,
  isDnfRoll,
  isRouteId,
  isSeat,
  isTier,
  mergedTier,
  otherSeat,
  routeConfig,
  scoreForRun,
} from "./rules";
import type {
  CarStatus,
  LaneRushCar,
  LaneRushRound,
  LaneRushSeat,
  LaneRushState,
  MatchWinner,
  RaceCarResult,
  RouteId,
  RouteReward,
  Seat,
} from "./rules";

// ── Public types ─────────────────────────────────────────────────────

export type LaneRushAction =
  | { type: "buy" }
  | { type: "deploy"; carId: string; route: RouteId }
  | { type: "recall"; carId: string }
  | { type: "setRoute"; carId: string; route: RouteId }
  | { type: "merge"; carId: string; otherCarId: string }
  | { type: "repair"; carId: string }
  | { type: "workshopRecovery"; carId: string };

export type ActionErrorCode =
  | "invalid-seat"
  | "invalid-action"
  | "invalid-state"
  | "invalid-route"
  | "invalid-randomness"
  | "not-planning"
  | "expired"
  | "locked"
  | "not-ready"
  | "car-not-found"
  | "opponent-car"
  | "car-damaged"
  | "car-racing"
  | "car-in-workshop"
  | "car-not-racing"
  | "car-not-damaged"
  | "duplicate-car"
  | "fleet-full"
  | "active-limit"
  | "insufficient-scrap"
  | "insufficient-action-points"
  | "merge-mismatch"
  | "max-tier"
  | "not-soft-locked";

export interface ActionFailure {
  ok: false;
  code: ActionErrorCode;
  error: string;
}

export interface ActionSuccess {
  ok: true;
  state: LaneRushState;
}

export type ActionResult = ActionSuccess | ActionFailure;

export interface ResolveSuccess {
  ok: true;
  state: LaneRushState;
  round: LaneRushRound;
}

export type ResolveResult = ResolveSuccess | ActionFailure;

export type StateReadFailureReason = "legacy" | "unsupported-version" | "invalid";

export type StateReadResult =
  | { ok: true; state: LaneRushState }
  | { ok: false; reason: StateReadFailureReason; error: string };

// ── Small helpers ────────────────────────────────────────────────────

function fail(code: ActionErrorCode, error: string): ActionFailure {
  return { ok: false, code, error };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function carPrefix(seat: Seat): string {
  return seat === "player1" ? "p1" : "p2";
}

function clockOf(now?: unknown): number {
  return isFiniteNumber(now) ? (now as number) : Date.now();
}

/** Deep copy through JSON — the state is JSON-safe by construction. */
export function cloneState(state: LaneRushState): LaneRushState {
  return JSON.parse(JSON.stringify(state)) as LaneRushState;
}

function emptySeat(seat: Seat): LaneRushSeat {
  const cars: LaneRushCar[] = [];
  for (let i = 1; i <= STARTING_CARS; i += 1) {
    cars.push({
      id: `${carPrefix(seat)}-c${i}`,
      owner: seat,
      tier: 1,
      status: "garage",
      damaged: false,
      route: null,
      upgrades: [],
    });
  }
  return {
    points: 0,
    scrap: STARTING_SCRAP,
    fuel: STARTING_FUEL,
    tech: STARTING_TECH,
    actionPoints: ACTION_POINTS_PER_ROUND,
    locked: false,
    nextCarNumber: STARTING_CARS + 1,
    cars,
  };
}

/**
 * Symmetric starting position: 2 Tier 1 cars, 4 Scrap, 0 points, 0 Fuel and
 * 0 Tech, 2 action points, round 1 with a full 60s planning window.
 */
export function createInitialState({ now }: { now?: number } = {}): LaneRushState {
  const at = clockOf(now);
  return {
    version: LANE_RUSH_STATE_VERSION,
    round: 1,
    phase: "planning",
    planningDeadline: new Date(at + PLANNING_MS).toISOString(),
    seats: {
      player1: emptySeat("player1"),
      player2: emptySeat("player2"),
    },
    results: [],
    winner: null,
  };
}

/** Absolute planning deadline in ms, or `null` when there is none. */
export function planningDeadlineMs(state: LaneRushState): number | null {
  const raw = state?.planningDeadline;
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/**
 * Whether the server's planning window has closed. An unparseable deadline
 * fails CLOSED (treated as expired) so corrupt state can never grant extra
 * time; `validateState` rejects it as invalid anyway.
 */
export function isPlanningExpired(state: LaneRushState, now?: number): boolean {
  const deadline = planningDeadlineMs(state);
  if (deadline === null) return typeof state?.planningDeadline === "string";
  return deadline <= clockOf(now);
}

/** Racing cars on a seat's grid. */
export function racingCars(seatState: LaneRushSeat): LaneRushCar[] {
  return Array.isArray(seatState?.cars)
    ? seatState.cars.filter((car) => car.status === "racing")
    : [];
}

/**
 * How many authoritative random values a round needs: one per racing car,
 * player 1's grid first, then player 2's (the engine's fixed order).
 */
export function plannedCarCount(state: LaneRushState): number {
  return SEATS.reduce(
    (total, seat) => total + racingCars(state.seats[seat]).length,
    0,
  );
}

/** Owned cars: garage + racing + workshop (all count toward the 8-car cap). */
export function ownedCarCount(seatState: LaneRushSeat): number {
  return Array.isArray(seatState?.cars) ? seatState.cars.length : 0;
}

/** Exactly the soft-lock condition the free workshop exists for. */
export function canUseWorkshop(state: LaneRushState, seat: Seat): boolean {
  const seatState = state?.seats?.[seat];
  if (!seatState) return false;
  if (!isFiniteNumber(seatState.scrap) || seatState.scrap > 0) return false;
  if (!Array.isArray(seatState.cars) || seatState.cars.length === 0) return false;
  return seatState.cars.every((car) => car.damaged === true);
}

// ── State validation ─────────────────────────────────────────────────

/**
 * Structural + invariant validation. Returns a human-readable error string,
 * or null when the state is safe to act on. Never mutates and never "repairs"
 * silently: a corrupt or stale row must be refused, not guessed at.
 */
export function validateState(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "State must be an object";
  if (raw.version !== LANE_RUSH_STATE_VERSION) {
    return `Unsupported state version ${String(raw.version)}`;
  }
  if (!Number.isInteger(raw.round) || raw.round < 1) return "round must be a positive integer";
  if (raw.phase !== "planning" && raw.phase !== "finished") {
    return "phase must be planning or finished";
  }
  if (!Array.isArray(raw.results)) return "results must be an array";
  if (raw.round !== raw.results.length + 1) {
    return "round must be results.length + 1";
  }
  if (raw.phase === "planning") {
    if (typeof raw.planningDeadline !== "string") {
      return "a planning phase needs a deadline";
    }
    if (!Number.isFinite(Date.parse(raw.planningDeadline))) {
      return "planningDeadline must be an ISO timestamp";
    }
    if (raw.winner !== null) return "an open race cannot have a winner";
  } else {
    if (raw.planningDeadline !== null) return "a finished race has no planning deadline";
    if (raw.winner !== "player1" && raw.winner !== "player2" && raw.winner !== "draw") {
      return "a finished race needs a winner";
    }
  }

  if (!isPlainObject(raw.seats)) return "seats must be an object";

  const seenCarIds = new Set<string>();
  for (const seat of SEATS) {
    const seatState = raw.seats[seat];
    if (!isPlainObject(seatState)) return `seats.${seat} is missing`;
    if (!isNonNegativeInt(seatState.points)) return `seats.${seat}.points is invalid`;
    for (const field of ["scrap", "fuel", "tech"] as const) {
      if (!isNonNegativeInt(seatState[field])) {
        return `seats.${seat}.${field} is invalid`;
      }
    }
    if (
      !isNonNegativeInt(seatState.actionPoints) ||
      seatState.actionPoints > ACTION_POINTS_PER_ROUND
    ) {
      return `seats.${seat}.actionPoints is out of range`;
    }
    if (typeof seatState.locked !== "boolean") return `seats.${seat}.locked is invalid`;
    if (!Number.isInteger(seatState.nextCarNumber) || seatState.nextCarNumber < 1) {
      return `seats.${seat}.nextCarNumber is invalid`;
    }
    if (!Array.isArray(seatState.cars)) return `seats.${seat}.cars must be an array`;
    if (seatState.cars.length > MAX_OWNED_CARS) {
      return `seats.${seat} owns more than ${MAX_OWNED_CARS} cars`;
    }

    let racing = 0;
    for (const car of seatState.cars) {
      if (!isPlainObject(car)) return `seats.${seat} has a malformed car`;
      if (typeof car.id !== "string" || car.id.length === 0) {
        return `seats.${seat} has a car without an id`;
      }
      if (seenCarIds.has(car.id)) return `duplicate car id ${car.id}`;
      seenCarIds.add(car.id);
      if (car.owner !== seat) return `car ${car.id} is owned by the wrong seat`;
      if (!isTier(car.tier)) return `car ${car.id} has an invalid tier`;
      const statuses: CarStatus[] = ["garage", "racing", "recovering"];
      if (!statuses.includes(car.status)) return `car ${car.id} has an invalid status`;
      if (typeof car.damaged !== "boolean") return `car ${car.id} damaged must be boolean`;
      if (car.status === "racing") {
        racing += 1;
        if (car.damaged) return `damaged car ${car.id} cannot be racing`;
        if (!isRouteId(car.route)) return `racing car ${car.id} has no valid route`;
      } else if (car.route !== null) {
        return `car ${car.id} has a route but is not racing`;
      }
      if (car.status === "recovering" && car.damaged !== true) {
        return `car ${car.id} is recovering but not damaged`;
      }
      if (!Array.isArray(car.upgrades) || car.upgrades.some((u: unknown) => typeof u !== "string")) {
        return `car ${car.id} upgrades must be strings`;
      }
    }
    if (racing > MAX_RACING_CARS) {
      return `seats.${seat} has more than ${MAX_RACING_CARS} cars racing`;
    }
  }

  // Every recorded round is append-only and numbered 1..n.
  for (let i = 0; i < raw.results.length; i += 1) {
    const round = raw.results[i];
    if (!isPlainObject(round)) return `results[${i}] is malformed`;
    if (round.round !== i + 1) return `results[${i}].round is out of order`;
    if (typeof round.resolvedAt !== "string") return `results[${i}].resolvedAt is invalid`;
    if (!Array.isArray(round.cars)) return `results[${i}].cars must be an array`;
    for (const car of round.cars) {
      if (!isPlainObject(car)) return `results[${i}] has a malformed car`;
      if (!isSeat(car.seat)) return `results[${i}] has an invalid seat`;
      if (!isTier(car.tier)) return `results[${i}] has an invalid tier`;
      if (!isRouteId(car.route)) return `results[${i}] has an invalid route`;
      if (!isFiniteNumber(car.roll) || car.roll < 0 || car.roll >= 1) {
        return `results[${i}] has an invalid roll`;
      }
      if (car.outcome !== "finished" && car.outcome !== "dnf") {
        return `results[${i}] has an invalid outcome`;
      }
      if (!isNonNegativeInt(car.points)) return `results[${i}] has invalid points`;
      if (car.outcome === "dnf" && (car.points !== 0 || car.reward !== null)) {
        return `results[${i}] scores a DNF`;
      }
      if (car.reward !== null) {
        if (
          !isPlainObject(car.reward) ||
          !(RESOURCES as readonly string[]).includes(car.reward.resource) ||
          !isNonNegativeInt(car.reward.amount) ||
          car.reward.amount <= 0
        ) {
          return `results[${i}] has an invalid reward`;
        }
      }
    }
    for (const seat of SEATS) {
      if (!isNonNegativeInt(round.points?.[seat])) {
        return `results[${i}].points.${seat} is invalid`;
      }
      if (!isNonNegativeInt(round.totals?.[seat])) {
        return `results[${i}].totals.${seat} is invalid`;
      }
    }
  }

  if (raw.results.length > 0) {
    const last = raw.results[raw.results.length - 1];
    for (const seat of SEATS) {
      if (last.totals[seat] !== raw.seats[seat].points) {
        return `seats.${seat}.points disagrees with the last round`;
      }
    }
  }

  return null;
}

/**
 * The ONLY way a persisted value becomes a game state. Legacy rows (the
 * unchanged `'{}'::jsonb` default / `version: 0`) come back as `legacy` so a
 * half-finished glass-bridge match is never read as a race; corrupt or
 * future-versioned states are refused explicitly.
 */
export function readState(raw: unknown): StateReadResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "legacy", error: "No Lane Rush race state" };
  }
  if (raw.version === undefined || raw.version === null || raw.version === 0) {
    return { ok: false, reason: "legacy", error: "Legacy match — not a Lane Rush race" };
  }
  if (raw.version !== LANE_RUSH_STATE_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      error: `Unsupported Lane Rush state version ${String(raw.version)}`,
    };
  }
  const error = validateState(raw);
  if (error) return { ok: false, reason: "invalid", error };
  return { ok: true, state: cloneState(raw as LaneRushState) };
}

// ── Planning guards ──────────────────────────────────────────────────

function guardPlanning(
  state: LaneRushState,
  seat: Seat,
  now: number,
): ActionFailure | null {
  if (!isSeat(seat)) return fail("invalid-seat", "Unknown seat");
  if (state.phase !== "planning") {
    return fail("not-planning", "The race is already over");
  }
  if (isPlanningExpired(state, now)) {
    return fail("expired", "Planning time is over");
  }
  if (state.seats[seat].locked) {
    return fail("locked", "Your plan is already locked in");
  }
  return null;
}

function locateCar(
  state: LaneRushState,
  seat: Seat,
  carId: unknown,
):
  | { seatState: LaneRushSeat; index: number; car: LaneRushCar }
  | { failure: ActionFailure } {
  const seatState = state.seats[seat];
  const id = carId == null ? "" : String(carId);
  const index = id ? seatState.cars.findIndex((car) => car.id === id) : -1;
  if (index >= 0) return { seatState, index, car: seatState.cars[index] };
  if (id && state.seats[otherSeat(seat)].cars.some((car) => car.id === id)) {
    return { failure: fail("opponent-car", "That car belongs to your opponent") };
  }
  return { failure: fail("car-not-found", "Car not found") };
}

function nextCarId(seatState: LaneRushSeat, seat: Seat): string {
  let n = seatState.nextCarNumber;
  while (seatState.cars.some((car) => car.id === `${carPrefix(seat)}-c${n}`)) n += 1;
  seatState.nextCarNumber = n + 1;
  return `${carPrefix(seat)}-c${n}`;
}

// ── Actions ──────────────────────────────────────────────────────────

function runAction(
  state: LaneRushState,
  seat: Seat,
  action: LaneRushAction,
  now: number,
): ActionFailure | null {
  const seatState = state.seats[seat];

  switch (action.type) {
    case "buy": {
      if (ownedCarCount(seatState) >= MAX_OWNED_CARS) {
        return fail("fleet-full", `Your garage is full (${MAX_OWNED_CARS} cars)`);
      }
      if (seatState.scrap < BUY_COST.scrap) {
        return fail("insufficient-scrap", `Buying a car costs ${BUY_COST.scrap} Scrap`);
      }
      if (seatState.actionPoints < BUY_COST.actionPoints) {
        return fail("insufficient-action-points", "Not enough action points");
      }
      seatState.scrap -= BUY_COST.scrap;
      seatState.actionPoints -= BUY_COST.actionPoints;
      seatState.cars.push({
        id: nextCarId(seatState, seat),
        owner: seat,
        tier: BUY_COST.tier,
        status: "garage",
        damaged: false,
        route: null,
        upgrades: [],
      });
      return null;
    }

    case "deploy": {
      const found = locateCar(state, seat, action.carId);
      if ("failure" in found) return found.failure;
      const { seatState: own, car } = found;
      if (car.status === "racing") {
        return fail("duplicate-car", "That car is already racing");
      }
      if (car.status === "recovering") {
        return fail("car-in-workshop", "That car is in the workshop until next round");
      }
      if (car.damaged) {
        return fail("car-damaged", "A damaged car cannot race — repair it first");
      }
      if (!isRouteId(action.route)) return fail("invalid-route", "Pick a valid route");
      if (racingCars(own).length >= MAX_RACING_CARS) {
        return fail("active-limit", `At most ${MAX_RACING_CARS} cars can race in a round`);
      }
      car.status = "racing";
      car.route = action.route;
      // Deploying is free: the 4-car grid cap limits a round, not the AP budget.
      return null;
    }

    case "recall": {
      const found = locateCar(state, seat, action.carId);
      if ("failure" in found) return found.failure;
      const { car } = found;
      if (car.status !== "racing") {
        return fail("car-not-racing", "Only a deployed car can return to the garage");
      }
      // Recalling is free and refunds the whole deploy: the car leaves the
      // grid, keeps its tier, and can be redeployed on another route.
      car.status = "garage";
      car.route = null;
      return null;
    }

    case "setRoute": {
      const found = locateCar(state, seat, action.carId);
      if ("failure" in found) return found.failure;
      const { car } = found;
      if (car.status !== "racing") {
        return fail("car-not-racing", "Only a deployed car can change route");
      }
      if (!isRouteId(action.route)) return fail("invalid-route", "Pick a valid route");
      car.route = action.route;
      return null;
    }

    case "merge": {
      const idA = action.carId == null ? "" : String(action.carId);
      const idB = action.otherCarId == null ? "" : String(action.otherCarId);
      if (!idA || !idB) return fail("invalid-action", "Pick two cars to merge");
      if (idA === idB) return fail("duplicate-car", "Pick two different cars");
      const a = locateCar(state, seat, idA);
      if ("failure" in a) return a.failure;
      const b = locateCar(state, seat, idB);
      if ("failure" in b) return b.failure;
      for (const { car } of [a, b]) {
        if (car.status === "racing") return fail("car-racing", "A racing car cannot be merged");
        if (car.status === "recovering") {
          return fail("car-in-workshop", "A car in the workshop cannot be merged");
        }
        if (car.damaged) return fail("car-damaged", "A damaged car cannot be merged");
      }
      if (a.car.tier !== b.car.tier) {
        return fail("merge-mismatch", "Merges need two cars of the same tier");
      }
      const nextTier = mergedTier(a.car.tier);
      if (nextTier === null) return fail("max-tier", "Tier 4 is the maximum");
      if (seatState.actionPoints < MERGE_COST.actionPoints) {
        return fail("insufficient-action-points", "Not enough action points");
      }

      const remove = new Set([a.car.id, b.car.id]);
      seatState.cars = seatState.cars.filter((car) => !remove.has(car.id));
      seatState.cars.push({
        id: nextCarId(seatState, seat),
        owner: seat,
        tier: nextTier,
        status: "garage",
        damaged: false,
        route: null,
        upgrades: [],
      });
      seatState.actionPoints -= MERGE_COST.actionPoints;
      return null;
    }

    case "repair": {
      const found = locateCar(state, seat, action.carId);
      if ("failure" in found) return found.failure;
      const { seatState: own, car } = found;
      if (car.status === "racing") {
        return fail("car-racing", "A racing car cannot be repaired");
      }
      if (car.status === "recovering") {
        return fail("car-in-workshop", "That car is already in the workshop");
      }
      if (!car.damaged) return fail("car-not-damaged", "That car is not damaged");
      if (own.scrap < REPAIR_COST.scrap) {
        return fail("insufficient-scrap", `Repairing costs ${REPAIR_COST.scrap} Scrap`);
      }
      if (own.actionPoints < REPAIR_COST.actionPoints) {
        return fail("insufficient-action-points", "Not enough action points");
      }
      own.scrap -= REPAIR_COST.scrap;
      own.actionPoints -= REPAIR_COST.actionPoints;
      car.damaged = false;
      return null;
    }

    case "workshopRecovery": {
      const found = locateCar(state, seat, action.carId);
      if ("failure" in found) return found.failure;
      const { seatState: own, car } = found;
      if (car.status === "racing") {
        return fail("car-racing", "A racing car cannot enter the workshop");
      }
      if (car.status === "recovering") {
        return fail("car-in-workshop", "That car is already in the workshop");
      }
      if (!car.damaged) return fail("car-not-damaged", "That car is not damaged");
      if (!canUseWorkshop(state, seat)) {
        return fail(
          "not-soft-locked",
          "Workshop recovery is only for a garage with no Scrap and every car damaged",
        );
      }
      // Free, but it consumes the whole planning phase: no further actions,
      // and the car only returns (undamaged) in the next round.
      car.status = "recovering";
      own.locked = true;
      return null;
    }

    default:
      return fail("invalid-action", `Unknown action ${String((action as any)?.type)}`);
  }
}

/**
 * Apply ONE planning action. Rejects everything the rules forbid (unknown
 * seat, after lock-in, after the server deadline, non-existent/opponent/
 * damaged/duplicate cars, resource, action-point and fleet limits) and
 * returns a NEW state — the input is never mutated.
 */
export function applyAction(
  state: LaneRushState,
  seat: Seat,
  action: LaneRushAction,
  { now }: { now?: number } = {},
): ActionResult {
  const stateError = validateState(state);
  if (stateError) return fail("invalid-state", stateError);
  const at = clockOf(now);
  const guard = guardPlanning(state, seat, at);
  if (guard) return guard;
  if (!isPlainObject(action) || typeof action.type !== "string") {
    return fail("invalid-action", "Malformed action");
  }

  const next = cloneState(state);
  const error = runAction(next, seat, action, at);
  if (error) return error;

  const after = validateState(next);
  if (after) return fail("invalid-state", after);
  return { ok: true, state: next };
}

/**
 * Apply an entire plan all-or-nothing. The server can hand a client's queued
 * actions to this and either persist the returned state or nothing at all.
 */
export function applyPlan(
  state: LaneRushState,
  seat: Seat,
  actions: LaneRushAction[],
  { now }: { now?: number } = {},
): ActionResult {
  if (!Array.isArray(actions)) return fail("invalid-action", "Plan must be an array");
  let current = state;
  for (const action of actions) {
    const result = applyAction(current, seat, action, { now });
    if (!result.ok) return result;
    current = result.state;
  }
  return { ok: true, state: cloneState(current) };
}

/**
 * Start (or restart) the server-owned planning clock. Used when the ready
 * banner closes, so the 60 seconds never tick while both clients are still
 * on the "match found" screen.
 */
export function beginPlanning(
  state: LaneRushState,
  { now }: { now?: number } = {},
): ActionResult {
  const stateError = validateState(state);
  if (stateError) return fail("invalid-state", stateError);
  if (state.phase !== "planning") {
    return fail("not-planning", "The race is already over");
  }
  const next = cloneState(state);
  next.planningDeadline = new Date(clockOf(now) + PLANNING_MS).toISOString();
  return { ok: true, state: next };
}

/** Lock a seat's plan in. Idempotence is deliberately NOT granted. */
export function lockIn(
  state: LaneRushState,
  seat: Seat,
  { now }: { now?: number } = {},
): ActionResult {
  const stateError = validateState(state);
  if (stateError) return fail("invalid-state", stateError);
  const at = clockOf(now);
  const guard = guardPlanning(state, seat, at);
  if (guard) return guard;
  const next = cloneState(state);
  next.seats[seat].locked = true;
  return { ok: true, state: next };
}

// ── Race resolution ──────────────────────────────────────────────────

/** Whether the server may resolve the round now. */
export function isReadyToResolve(state: LaneRushState, now?: number): boolean {
  if (!state || state.phase !== "planning") return false;
  const bothLocked = SEATS.every((seat) => state.seats[seat]?.locked === true);
  return bothLocked || isPlanningExpired(state, now);
}

/**
 * The validated grid for one seat, in car order. Refuses a grid the rules
 * cannot race, so `resolveRound` never has to guess.
 */
export function validatedGrid(
  state: LaneRushState,
  seat: Seat,
): { ok: true; cars: LaneRushCar[] } | ActionFailure {
  if (!isSeat(seat)) return fail("invalid-seat", "Unknown seat");
  const seatState = state?.seats?.[seat];
  if (!seatState) return fail("invalid-state", `seats.${String(seat)} is missing`);
  const grid = racingCars(seatState);
  if (grid.length > MAX_RACING_CARS) {
    return fail("active-limit", `At most ${MAX_RACING_CARS} cars can race in a round`);
  }
  for (const car of grid) {
    if (!isRouteId(car.route)) {
      return fail("invalid-route", `Car ${car.id} has no valid route`);
    }
    if (car.damaged) {
      return fail("car-damaged", `Car ${car.id} is damaged and cannot race`);
    }
  }
  return { ok: true, cars: grid };
}

/**
 * Decide the match from cumulative points. `null` means "race on".
 * The 1,000-point threshold is the only win condition; if both seats cross it
 * in the same round, the higher total wins and an exact tie is a draw.
 */
export function decideWinner(p1Points: number, p2Points: number): MatchWinner {
  const p1 = isFiniteNumber(p1Points) ? p1Points : 0;
  const p2 = isFiniteNumber(p2Points) ? p2Points : 0;
  const p1Crossed = p1 >= WIN_SCORE;
  const p2Crossed = p2 >= WIN_SCORE;
  if (p1Crossed && p2Crossed) {
    if (p1 === p2) return "draw";
    return p1 > p2 ? "player1" : "player2";
  }
  if (p1Crossed) return "player1";
  if (p2Crossed) return "player2";
  return null;
}

/**
 * Resolve the round's races with authoritative random values.
 *
 * `randomValues` must contain ONE value in [0, 1) per racing car, in the
 * engine's deterministic order — player1's grid, then player2's, each in car
 * order. The server owns those draws; a client never sees or supplies a roll.
 *
 * On success every racing car returns to the garage (damaged on a DNF),
 * successful cars score `round(base × multiplier)` and pay their route
 * reward, workshop cars come back, the round counter advances and either the
 * next planning phase opens with 2 fresh action points or the match ends.
 */
export function resolveRound({
  state,
  randomValues,
  now,
}: {
  state: LaneRushState;
  randomValues: number[];
  now?: number;
}): ResolveResult {
  const stateError = validateState(state);
  if (stateError) return fail("invalid-state", stateError);
  if (state.phase !== "planning") return fail("not-planning", "The race is already over");

  const at = clockOf(now);
  if (!isReadyToResolve(state, at)) {
    return fail("not-ready", "Both plans must be locked in, or the clock must run out");
  }
  if (!Array.isArray(randomValues)) {
    return fail("invalid-randomness", "Race resolution needs authoritative random values");
  }

  const grids: Array<{ seat: Seat; cars: LaneRushCar[] }> = [];
  for (const seat of SEATS) {
    const grid = validatedGrid(state, seat);
    // `"error" in grid` (not `!grid.ok`): with strictNullChecks off TS widens
    // the boolean discriminant, so property narrowing is the reliable one.
    if ("error" in grid) return fail(grid.code, grid.error);
    grids.push({ seat, cars: grid.cars });
  }
  const totalCars = grids.reduce((sum, grid) => sum + grid.cars.length, 0);
  if (randomValues.length !== totalCars) {
    return fail(
      "invalid-randomness",
      `Expected ${totalCars} random value(s), received ${randomValues.length}`,
    );
  }
  for (const value of randomValues) {
    if (!isFiniteNumber(value) || value < 0 || value >= 1) {
      return fail("invalid-randomness", "Random values must be in [0, 1)");
    }
  }

  const next = cloneState(state);
  const roundCars: RaceCarResult[] = [];
  const earned: Record<Seat, number> = { player1: 0, player2: 0 };
  let cursor = 0;

  for (const { seat, cars } of grids) {
    const seatState = next.seats[seat];
    for (const { id } of cars) {
      const live = seatState.cars.find((car) => car.id === id)!;
      const route = live.route as RouteId;
      const roll = randomValues[cursor];
      cursor += 1;
      const dnf = isDnfRoll(route, roll);
      const config = routeConfig(route);
      const points = dnf ? 0 : scoreForRun(live.tier, route);
      const reward: RouteReward | null = dnf
        ? null
        : { resource: config.reward.resource, amount: config.reward.amount };

      if (dnf) {
        live.damaged = true;
      } else {
        seatState.points += points;
        earned[seat] += points;
        if (reward) {
          if (reward.resource === "scrap") seatState.scrap += reward.amount;
          else if (reward.resource === "fuel") seatState.fuel += reward.amount;
          else seatState.tech += reward.amount;
        }
      }

      // Every racing car comes home: a DNF comes home damaged.
      live.status = "garage";
      live.route = null;

      roundCars.push({
        seat,
        carId: live.id,
        tier: live.tier,
        route,
        roll,
        outcome: dnf ? "dnf" : "finished",
        points,
        reward,
      });
    }
  }

  // Workshop recovery completes as the round resolves, so the car is usable
  // in the next planning phase — never earlier.
  for (const seat of SEATS) {
    for (const car of next.seats[seat].cars) {
      if (car.status === "recovering") {
        car.status = "garage";
        car.damaged = false;
      }
    }
  }

  const round: LaneRushRound = {
    round: next.round,
    resolvedAt: new Date(at).toISOString(),
    cars: roundCars,
    points: earned,
    totals: {
      player1: next.seats.player1.points,
      player2: next.seats.player2.points,
    },
  };
  next.results.push(round);
  next.round += 1;

  const winner = decideWinner(next.seats.player1.points, next.seats.player2.points);
  if (winner) {
    next.phase = "finished";
    next.winner = winner;
    next.planningDeadline = null;
    for (const seat of SEATS) {
      next.seats[seat].locked = true;
      next.seats[seat].actionPoints = 0;
    }
  } else {
    next.phase = "planning";
    next.winner = null;
    next.planningDeadline = new Date(at + PLANNING_MS).toISOString();
    for (const seat of SEATS) {
      next.seats[seat].locked = false;
      next.seats[seat].actionPoints = ACTION_POINTS_PER_ROUND;
    }
  }

  const after = validateState(next);
  if (after) return fail("invalid-state", after);
  return { ok: true, state: next, round };
}
