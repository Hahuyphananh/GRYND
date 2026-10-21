// src/lib/lane-rush/bot.ts
//
// The Lane Rush practice bot — a MINIMAL LEGAL PLANNER, not a second rules
// engine. It proposes ordinary actions (buy / merge / repair / deploy /
// workshop recovery) and locks in, and every one of them goes through the
// same `applyAction` / `lockIn` validation a human request does. If the bot
// proposes something illegal the engine rejects it and the planner simply
// stops, so the bot can never invent resources, a fifth racing car, or a
// result.
//
// Difficulty only changes ROUTE SELECTION (how much risk the bot takes) and
// therefore how much variance it accepts — it never changes the rules.

import {
  BUY_COST,
  MAX_OWNED_CARS,
  MAX_RACING_CARS,
  MAX_TIER,
  ROUTE_IDS,
} from "./rules";
import type { LaneRushState, RouteId, Seat } from "./rules";
import type { LaneRushAction } from "./engine";
import { applyAction, canUseWorkshop, lockIn } from "./engine";

export interface BotPlanResult {
  /** The actions the engine accepted, in order (lock-in included separately). */
  actions: LaneRushAction[];
  /** The resulting state (the caller persists it). */
  state: LaneRushState;
  locked: boolean;
}

const ROUTE_WEIGHTS: Record<string, Record<RouteId, number>> = {
  easy: { safe: 0.7, sprint: 0.25, risk: 0.05 },
  medium: { safe: 0.35, sprint: 0.45, risk: 0.2 },
  hard: { safe: 0.15, sprint: 0.45, risk: 0.4 },
};

function chooseRoute(difficulty: string, random: () => number): RouteId {
  const table = ROUTE_WEIGHTS[difficulty] ?? ROUTE_WEIGHTS.medium;
  const roll = random();
  let accumulator = 0;
  for (const id of ROUTE_IDS) {
    accumulator += table[id];
    if (roll < accumulator) return id;
  }
  return "safe";
}

function garageCars(state: LaneRushState, seat: Seat) {
  return state.seats[seat].cars.filter((car) => car.status === "garage");
}

/**
 * Plan one complete turn for `seat`: spend the 2 action points on the best
 * legal garage improvement, deploy up to four undamaged cars, then lock in.
 *
 * Pure with respect to time/randomness: the caller (the store) hands in the
 * server clock and a random source. The returned `state` is the exact state
 * the server should persist.
 */
export function planBotTurn({
  state,
  seat = "player2",
  difficulty = "easy",
  random = Math.random,
  now,
}: {
  state: LaneRushState;
  seat?: Seat;
  difficulty?: string;
  random?: () => number;
  now?: number;
}): BotPlanResult {
  const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const actions: LaneRushAction[] = [];
  let current = state;

  const seatState = current?.seats?.[seat];
  if (!seatState || current.phase !== "planning") {
    return { actions, state: current, locked: Boolean(seatState?.locked) };
  }
  if (seatState.locked) {
    return { actions, state: current, locked: true };
  }

  const apply = (action: LaneRushAction): boolean => {
    const result = applyAction(current, seat, action, { now: at });
    if (!result.ok) return false;
    current = result.state;
    actions.push(action);
    return true;
  };

  // 1. A soft-locked garage (no Scrap, every car damaged) always recovers
  //    first. The recovery consumes the planning phase, so there is nothing
  //    left to plan.
  if (canUseWorkshop(current, seat)) {
    const car = garageCars(current, seat).find((c) => c.damaged);
    if (car && apply({ type: "workshopRecovery", carId: car.id })) {
      return { actions, state: current, locked: true };
    }
  }

  // 2. Repair damaged cars while Scrap and action points last, highest tier
  //    first (a Hypercar is worth repairing before a Compact).
  for (let guard = 0; guard < MAX_OWNED_CARS; guard += 1) {
    const snapshot = current.seats[seat];
    if (snapshot.actionPoints <= 0 || snapshot.scrap <= 0) break;
    const target = [...snapshot.cars]
      .filter((car) => car.status === "garage" && car.damaged)
      .sort((a, b) => b.tier - a.tier)[0];
    if (!target) break;
    if (!apply({ type: "repair", carId: target.id })) break;
  }

  // 3. Merge pairs of the same tier, highest tier first, while AP remains.
  for (let guard = 0; guard < MAX_OWNED_CARS; guard += 1) {
    const snapshot = current.seats[seat];
    if (snapshot.actionPoints <= 0) break;
    const byTier = new Map<number, string[]>();
    for (const car of snapshot.cars) {
      if (car.status !== "garage" || car.damaged || car.tier >= MAX_TIER) continue;
      const list = byTier.get(car.tier) ?? [];
      list.push(car.id);
      byTier.set(car.tier, list);
    }
    const tier = [...byTier.keys()].sort((a, b) => b - a).find((t) => (byTier.get(t) ?? []).length >= 2);
    if (tier === undefined) break;
    const [carId, otherCarId] = byTier.get(tier)!;
    if (!apply({ type: "merge", carId, otherCarId })) break;
  }

  // 4. Buy Tier 1 cars with whatever action points are left.
  for (let guard = 0; guard < MAX_OWNED_CARS; guard += 1) {
    const snapshot = current.seats[seat];
    if (snapshot.actionPoints <= 0) break;
    if (snapshot.scrap < BUY_COST.scrap) break;
    if (snapshot.cars.length >= MAX_OWNED_CARS) break;
    if (!apply({ type: "buy" })) break;
  }

  // 5. Deploy the best four undamaged garage cars (highest tier first).
  for (let guard = 0; guard < MAX_RACING_CARS; guard += 1) {
    const snapshot = current.seats[seat];
    const racing = snapshot.cars.filter((car) => car.status === "racing").length;
    if (racing >= MAX_RACING_CARS) break;
    const target = [...snapshot.cars]
      .filter((car) => car.status === "garage" && !car.damaged)
      .sort((a, b) => b.tier - a.tier)[0];
    if (!target) break;
    if (!apply({ type: "deploy", carId: target.id, route: chooseRoute(difficulty, random) })) break;
  }

  // 6. Lock in — the same action a human sends.
  const locked = lockIn(current, seat, { now: at });
  if (locked.ok) current = locked.state;

  return { actions, state: current, locked: Boolean(current.seats[seat].locked) };
}
