// src/lib/lane-rush/rules.ts
//
// THE rulebook for Lane Rush — simultaneous-planning strategic racing.
//
// Everything numeric or structural about the new game lives here: the garage
// economy, car tiers, routes, action costs, the planning window, the score
// threshold, and the ONE rounding rule used for every race. The engine
// (`./engine.ts`), the API routes and the board import from this module, so a
// balance change is a one-line diff and never a hunt through React components.
//
// The legacy glass-bridge duel keeps its own library
// (`src/lib/lane-rush-duel/`) untouched: this module describes the NEW game.
//
// ── Game shape ──────────────────────────────────────────────────────
// Each round is a PLANNING PHASE (60s, 2 action points) followed by a
// simultaneous race. Players own cars, deploy up to four to a route, and
// spend action points on the garage economy (buy / merge / repair). A
// successful run scores `tier base points × route multiplier`; a DNF scores
// nothing, pays no route reward, and leaves the car damaged in the garage.
// First seat to WIN_SCORE points wins the match.

/** Version stamped on every persisted race state (see `game_state_version`). */
export const LANE_RUSH_STATE_VERSION = 1;

// ── Seats ───────────────────────────────────────────────────────────
// The match table keeps its existing player1/player2 seat model.
export const SEATS = ["player1", "player2"] as const;
export type Seat = (typeof SEATS)[number];

export const SEAT_LABELS: Record<Seat, string> = {
  player1: "Player 1",
  player2: "Player 2",
};

/** The other seat. The engine never takes a seat as a client-supplied value. */
export function otherSeat(seat: Seat): Seat {
  return seat === "player1" ? "player2" : "player1";
}

export function isSeat(value: unknown): value is Seat {
  return value === "player1" || value === "player2";
}

// ── Starting garage (identical for both seats) ──────────────────────
/** Tier 1 cars each seat starts with, all in the garage. */
export const STARTING_CARS = 2;
/** Scrap each seat starts with. */
export const STARTING_SCRAP = 4;
/** Fuel chips each seat starts with. */
export const STARTING_FUEL = 0;
/** Tech chips each seat starts with. */
export const STARTING_TECH = 0;
/** Action points granted at the start of every planning phase (set, not added). */
export const ACTION_POINTS_PER_ROUND = 2;
/** Hard cap on owned cars — garage, racing and workshop cars all count. */
export const MAX_OWNED_CARS = 8;
/** Cars a seat may have racing in one round. */
export const MAX_RACING_CARS = 4;
/** Server-authoritative planning window. */
export const PLANNING_SECONDS = 60;
export const PLANNING_MS = PLANNING_SECONDS * 1000;
/** First seat to this many cumulative points wins the match. */
export const WIN_SCORE = 1000;

// ── Workshop recovery ───────────────────────────────────────────────
// Soft-lock guard: a seat with NO Scrap and EVERY owned car damaged can hand
// one damaged car to the workshop for free. The recovery:
//   • costs no Scrap and no action points,
//   • CONSUMES THE PLANNING PHASE (the seat is locked in immediately),
//   • completes during race resolution, so the car is back in the garage,
//     undamaged, for the NEXT planning phase.
// A car in the workshop can never race, be merged, repaired or recovered
// again until it comes out. See `canUseWorkshop` / `workshopRecovery` in the
// engine for the exact gate.
export const WORKSHOP_RECOVERY_ROUNDS = 1;

// ── Car tiers ───────────────────────────────────────────────────────
export const MIN_TIER = 1;
export const MAX_TIER = 4;

export const TIER_NAMES = {
  1: "Compact",
  2: "Sport",
  3: "Supercar",
  4: "Hypercar",
} as const;

/** Base points a successful run scores, before the route multiplier. */
export const TIER_BASE_POINTS = {
  1: 12,
  2: 28,
  3: 65,
  4: 150,
} as const;

export type Tier = 1 | 2 | 3 | 4;

export function isTier(value: unknown): value is Tier {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_TIER &&
    (value as number) <= MAX_TIER
  );
}

export function tierName(tier: unknown): string {
  return isTier(tier) ? TIER_NAMES[tier] : "Unknown car";
}

/** Base points for a tier. Throws on an invalid tier so a bad call is loud. */
export function tierBasePoints(tier: unknown): number {
  if (!isTier(tier)) {
    throw new RangeError(`tierBasePoints: invalid tier ${String(tier)}`);
  }
  return TIER_BASE_POINTS[tier];
}

/**
 * The tier a merge produces, or null when the pair cannot merge up (Tier 4 is
 * the maximum). Tier 4 cars are never merge sources.
 */
export function mergedTier(tier: unknown): Tier | null {
  if (!isTier(tier) || tier >= MAX_TIER) return null;
  return (tier + 1) as Tier;
}

/** Purchases are deliberately limited to Tier 1. */
export const PURCHASABLE_TIER: Tier = 1;

// ── Routes ──────────────────────────────────────────────────────────
export const RESOURCES = ["scrap", "fuel", "tech"] as const;
export type Resource = (typeof RESOURCES)[number];

export const ROUTE_IDS = ["safe", "sprint", "risk"] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export interface RouteReward {
  resource: Resource;
  amount: number;
}

export interface RouteConfig {
  id: RouteId;
  name: string;
  /** Probability in [0, 1) that a run ends in a DNF. */
  dnfChance: number;
  /** Points multiplier applied to the car's tier base points. */
  pointsMultiplier: number;
  /** Awarded only on a successful run. */
  reward: RouteReward;
  blurb: string;
}

export const ROUTES: Record<RouteId, RouteConfig> = Object.freeze({
  safe: Object.freeze({
    id: "safe",
    name: "Safe Circuit",
    dnfChance: 0.05,
    pointsMultiplier: 1,
    reward: Object.freeze({ resource: "scrap", amount: 1 }),
    blurb: "5% DNF · 1.0× points · +1 Scrap",
  }),
  sprint: Object.freeze({
    id: "sprint",
    name: "Sprint Lane",
    dnfChance: 0.15,
    pointsMultiplier: 1.5,
    reward: Object.freeze({ resource: "fuel", amount: 1 }),
    blurb: "15% DNF · 1.5× points · +1 Fuel",
  }),
  risk: Object.freeze({
    id: "risk",
    name: "Risk Route",
    dnfChance: 0.3,
    pointsMultiplier: 2.2,
    reward: Object.freeze({ resource: "tech", amount: 1 }),
    blurb: "30% DNF · 2.2× points · +1 Tech",
  }),
});

export const DEFAULT_ROUTE: RouteId = "safe";

export function isRouteId(value: unknown): value is RouteId {
  return typeof value === "string" && (ROUTE_IDS as readonly string[]).includes(value);
}

/** Route config for an id. Throws on an invalid route (callers validate first). */
export function routeConfig(route: unknown): RouteConfig {
  if (!isRouteId(route)) {
    throw new RangeError(`routeConfig: invalid route ${String(route)}`);
  }
  return ROUTES[route];
}

export function isDnfRoll(route: unknown, roll: number): boolean {
  const config = routeConfig(route);
  return Number(roll) < config.dnfChance;
}

/**
 * Points a successful run scores: `tierBasePoints × route multiplier`.
 *
 * ROUNDING RULE: exactly one round — `Math.round` (half up) — applied to the
 * product, so the whole game agrees on e.g. Compact/Risk (12 × 2.2 = 26.4 →
 * 26) and Supercar/Sprint (65 × 1.5 = 97.5 → 98). Never round a subtotal or a
 * multiplier anywhere else.
 */
export function scoreForRun(tier: unknown, route: unknown): number {
  const base = tierBasePoints(tier);
  const multiplier = routeConfig(route).pointsMultiplier;
  return Math.round(base * multiplier);
}

// ── Action costs ────────────────────────────────────────────────────
// Only the garage economy spends action points. Deploying a car and changing
// its route cost nothing, so the 2 AP budget can never starve the race — the
// MAX_RACING_CARS cap is what limits a grid, not the action budget.
export const BUY_COST = Object.freeze({
  tier: PURCHASABLE_TIER,
  scrap: 2,
  actionPoints: 1,
});

export const MERGE_COST = Object.freeze({ actionPoints: 1 });

export const REPAIR_COST = Object.freeze({
  scrap: 1,
  actionPoints: 1,
});

// ── State shapes (serialized as the match row's versioned `game_state`) ──

/**
 * `garage` — idle, can be deployed / merged / repaired.
 * `racing` — deployed for the CURRENT round only.
 * `recovering` — in the free workshop; unavailable until next round.
 */
export type CarStatus = "garage" | "racing" | "recovering";

export interface LaneRushCar {
  /** Stable, seat-scoped unique id (`p1-c1`, `p1-c2`, …). */
  id: string;
  owner: Seat;
  tier: Tier;
  status: CarStatus;
  damaged: boolean;
  /** Route selection. Only meaningful (and required) while racing. */
  route: RouteId | null;
  /**
   * Per-car upgrades from later rules. Empty today; persisted so an upgrade
   * never lives only in a client's memory.
   */
  upgrades: string[];
}

export interface LaneRushSeat {
  points: number;
  scrap: number;
  fuel: number;
  tech: number;
  actionPoints: number;
  /** True once the seat locks in (or a workshop recovery consumes the phase). */
  locked: boolean;
  /** Monotonic counter behind stable car ids. */
  nextCarNumber: number;
  cars: LaneRushCar[];
}

export interface RaceCarResult {
  seat: Seat;
  carId: string;
  tier: Tier;
  route: RouteId;
  /** Authoritative random draw in [0, 1) supplied by the server. */
  roll: number;
  outcome: "finished" | "dnf";
  points: number;
  reward: RouteReward | null;
}

export interface LaneRushRound {
  round: number;
  resolvedAt: string;
  /** Cars in deterministic order: player1's grid, then player2's. */
  cars: RaceCarResult[];
  /** Points earned by each seat in this round. */
  points: Record<Seat, number>;
  /** Cumulative points after this round. */
  totals: Record<Seat, number>;
}

export type MatchPhase = "planning" | "finished";
export type MatchWinner = Seat | "draw" | null;

export interface LaneRushState {
  version: number;
  /** 1-based round. `round === results.length + 1` always holds. */
  round: number;
  phase: MatchPhase;
  /** Absolute ISO deadline for the current planning phase (null when finished). */
  planningDeadline: string | null;
  seats: Record<Seat, LaneRushSeat>;
  results: LaneRushRound[];
  winner: MatchWinner;
}
