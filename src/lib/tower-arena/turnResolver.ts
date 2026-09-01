// src/lib/tower-arena/turnResolver.ts
//
// Pure, deterministic Tower Arena turn-resolution logic. This is the game
// ENGINE's decision layer: given the current server-owned match snapshot and
// a player's intents (block shape / anchor / rotation), it returns the full
// next-state transition — which resource was consumed, whether it came from
// the shared pool or a reservation, whether the tower collapsed, who was
// eliminated, the placement value, exactly how the pool refills, whose turn
// is next, whether the match is finished — WITHOUT touching a database.
//
// `serverStore` is the only caller and is responsible for persisting these
// outcomes inside a transaction. Keeping this pure (no DB, no Math.random,
// no client state) makes every rule in the spec unit-testable and guarantees
// identical inputs always produce identical outcomes.
//
// Nomenclature to avoid confusion:
//   * `actionType` — who initiated the placement: "PLACE" (human),
//     "AI", or "TIMEOUT" (deterministic fallback). It is recorded for audit
//     but NEVER changes the resolved geometry (a timeout still ages the tower
//     the exact same way a voluntary placement of the same block would).
//   * The two resource sources are "pool" (shared) and "reserve" (private).

import {
  BLOCK_SHAPES,
  centerDepthFor,
  centerXFor,
  fitsInGrid,
  footprintFor,
  refillResourcePool,
  simulatePlacement,
  takeFromPool,
  buildResourcePool,
  type BlockShape,
  type ResourcePiece,
  type TowerState,
} from "./engine";

export const TURN_PLACEMENT_WINDOW_MS = 8000;
export const RESERVE_WINDOW_MS = 8000;
export const MAX_RESERVE_USES = 2;

// ── Snapshots/types decoupled from the ORM ─────────────────────────────

/** Server snapshot of one active participant (whatever the store projects). */
export interface ResolverPlayer {
  userId: string;
  seat: number;
  status: string;
  isAi: boolean;
  reserveUsesRemaining: number;
  /** Pre-game ready flag (bots are always ready). */
  ready?: boolean;
}

/** Reserve bookkeeping keyed by userId. */
export type ReserveMap = Record<string, { blockId: string; shape: BlockShape } | null>;

/** Placement audit entry (mirrors the persisted placements array). */
export interface PlacementEntry {
  turnNumber: number;
  userId: string;
  seat: number;
  shape: BlockShape;
  positionX: number;
  rotation: number;
  blockId: string;
  fromReserve: boolean;
  collapsed: boolean;
  removedBlockIds: string[];
  actionType: string;
  at: string;
}

export interface MatchSnapshot {
  id: string;
  status: string;
  phase: string;
  maxPlayers: number;
  resourceCycle: number;
  turnNumber: number;
  currentTurnPlayerId: string | null;
  turnDeadline: string | number | Date | null;
  resourcePool: ResourcePiece[];
  towerState: TowerState;
  reserveState: unknown;
  placements: PlacementEntry[];
}

export interface PlacementIntent {
  shape: BlockShape;
  positionX: number;
  rotation: number;
  actionType: "PLACE" | "AI" | "TIMEOUT";
}

export type ResolveFailure = { ok: false; error: string; status: number };
export type ResolveSuccess = { ok: true; resolved: ResolvedPlacement };
export type ResolveResult = ResolveFailure | ResolveSuccess;

export interface EliminationOutcome {
  userId: string;
  /** Placement value (1 = winner … N). Assigned at elimination time. */
  placement: number;
}

export interface ResolvedPlacement {
  blockShape: BlockShape;
  fromReserve: boolean;
  entry: PlacementEntry;
  stable: boolean;
  collapsed: boolean;
  removedBlockIds: string[];
  /** Full tower after placement + any collapse recovery (never "reset"). */
  towerState: TowerState;
  /** Remaining shared pool after this placement + optional refill. */
  pool: ResourcePiece[];
  reserveState: ReserveMap;
  /** True when the pool (re)filled this transition (elimination or empty). */
  refilled: boolean;
  resourceCycle: number;
  /** Eliminations that resulted from THIS placement (collapse). */
  eliminations: EliminationOutcome[];
  /** True once only one active player remains (match should finish). */
  finished: boolean;
  /** Active (surviving) participant count after the placement. */
  activeRemaining: number;
  /** Whose turn is next (null when target is waiting/finishing). */
  nextTurnPlayerId: string | null;
  /** Epoch-ms deadline for the next window. */
  nextDeadlineMs: number | null;
  nextPhase: "placement" | "reserve";
}

// ── Small, pure helpers exported for tests ─────────────────────────────

export function isActivePlayer(p: ResolverPlayer): boolean {
  return p?.status === "active";
}

export function parseReserveMap(raw: unknown): ReserveMap {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as ReserveMap;
  }
  return {};
}

export function parsePool(raw: unknown): ResourcePiece[] {
  // Copy so takeFromPool (which splices in place) never mutates the caller's
  // stored snapshot — the resolver is strictly pure for race-safe replay.
  return Array.isArray(raw) ? (raw as ResourcePiece[]).slice() : [];
}

export function parsePlacements(raw: unknown): PlacementEntry[] {
  return Array.isArray(raw) ? (raw as PlacementEntry[]) : [];
}

/**
 * Pre-game ready gate: every ACTIVE participant must have clicked READY
 * before the 10s start countdown may begin. AI seats are always ready
 * (they have no click), so a human-vs-bot free-play match only needs the
 * human to ready up. An empty roster can never be "all ready".
 */
export function isReadyGateMet(players: ResolverPlayer[]): boolean {
  const active = players.filter(isActivePlayer);
  if (active.length === 0) return false;
  return active.every((p) => p.isAi || Boolean(p.ready));
}

/**
 * Next active seat strictly after `afterUserId`, wrapping around and
 * skipping eliminated players. Returns null when nobody else remains.
 */
export function nextActiveAfter(players: ResolverPlayer[], afterUserId: string): string | null {
  const active = players.filter(isActivePlayer).map((p) => p.userId);
  if (active.length <= 1) return null;
  const idx = active.indexOf(afterUserId);
  if (idx === -1) return null;
  return active[(idx + 1) % active.length];
}

export function playerByUserId(players: ResolverPlayer[], userId: string): ResolverPlayer | null {
  for (const p of players) if (p.userId === userId) return p;
  return null;
}

/** Deterministic safe fallback intent: smallest available shape, centered. */
export function safeFallbackIntent(snapshot: MatchSnapshot): PlacementIntent {
  const reserve = parseReserveMap(snapshot.reserveState);
  const pool = parsePool(snapshot.resourcePool);
  const held = reserve[snapshot.currentTurnPlayerId ?? ""];

  let shape: BlockShape = "short";
  if (held) {
    shape = held.shape === "short" || held.shape === "square" ? held.shape : "short";
  } else {
    const byOrder: BlockShape[] = ["short", "square", "I", "T", "L"];
    const available = pool.map((p) => p.shape);
    for (const s of byOrder) {
      if (available.includes(s)) {
        shape = s;
        break;
      }
    }
  }
  return { shape, positionX: centerXFor(shape, 0), rotation: 0, actionType: "TIMEOUT" };
}

/**
 * Raise a fresh deterministic pool for a new cycle (used when refilling on an
 * elimination): a full replacement pool, seeded by matchId + cycle.
 */
export function freshPoolForCycle(maxPlayers: number, matchId: string, cycle: number): ResourcePiece[] {
  return buildResourcePool(maxPlayers, `${matchId}:cycle:${cycle}`);
}

/** Reset reserve bookkeeping to a clean cycle (everyone loses their hold). */
export function clearReserves(reserve: ReserveMap): ReserveMap {
  const next: ReserveMap = {};
  for (const k of Object.keys(reserve)) next[k] = null;
  return next;
}

// ── The core transition ────────────────────────────────────────────────

/**
 * Resolve one legal placement against the CURRENT snapshot. Does not
 * validate turn ownership / phase / actor (the store does authz); it assumes
 * the acting player is the current active holder and it mutates nothing.
 *
 * Returns a fully-specified next state. The caller persists it and shields the
 * match JSONB/CUwith FOR UPDATE semantics against concurrency.
 */
export function resolvePlacement(
  snapshot: MatchSnapshot,
  players: ResolverPlayer[],
  intent: PlacementIntent,
  actingUserId: string,
): ResolveResult {
  const pool = parsePool(snapshot.resourcePool);
  const reserve = parseReserveMap(snapshot.reserveState);
  const tower = Array.isArray(snapshot.towerState) ? snapshot.towerState : [];
  const placements = parsePlacements(snapshot.placements);
  const rotation = Number.isInteger(intent.rotation) ? intent.rotation : 0;

  // Basic geometry sanity (bounds) — the store also checks this but keep the
  // resolver self-contained so direct callers can't produce an OOB block.
  const extent = footprintFor(intent.shape, rotation);
  if (!fitsInGrid(extent, intent.positionX, 0)) {
    const failure: ResolveFailure = { ok: false, error: "Placement out of bounds", status: 400 };
    return failure;
  }

  const activePlayers = players.filter(isActivePlayer);

  // Resolve the resource source. A held reservation with the SAME shape is
  // used first (consuming the hold, not the pool, and costing no extra use).
  // A hold with a DIFFERENT shape is skipped — the player draws from the pool
  // and their (mismatched) hold stays until used or the cycle clears.
  let blockShape = intent.shape;
  let fromReserve = false;
  const held = reserve[actingUserId];
  if (held && held.shape === intent.shape) {
    blockShape = held.shape;
    fromReserve = true;
    reserve[actingUserId] = null;
  } else if (!held || held.shape !== intent.shape) {
    const taken = takeFromPool(pool, blockShape);
    if (!taken.piece) {
      const failure: ResolveFailure = { ok: false, error: `${blockShape} block is not available`, status: 409 };
      return failure;
    }
  }

  const turnNumber = snapshot.turnNumber + 1;
  const blockId = `b:${turnNumber}`;
  const sim = simulatePlacement(tower, {
    shape: blockShape,
    x: intent.positionX,
    depth: centerDepthFor(blockShape, rotation),
    rotation,
    blockId,
    placedByUserId: actingUserId,
    turnNumber,
  });

  const entry: PlacementEntry = {
    turnNumber,
    userId: actingUserId,
    seat: playerByUserId(activePlayers, actingUserId)?.seat ?? 0,
    shape: blockShape,
    positionX: intent.positionX,
    rotation,
    blockId,
    fromReserve,
    collapsed: sim.collapsed,
    removedBlockIds: sim.removedBlockIds,
    actionType: intent.actionType,
    at: new Date().toISOString(),
  };

  // Determine eliminations + the surviving count.
  const eliminations: EliminationOutcome[] = [];
  let activeRemaining = activePlayers.length;
  if (sim.collapsed) {
    // The responsible player drops to the LAST unassigned placement (the
    // number of active participants BEFORE this turn). Subsequent players
    // tighten the field, so later eliminations get earlier (higher finish)
    // placements — matching "final placement = elimination order".
    const placementValue = activeRemaining;
    eliminations.push({ userId: actingUserId, placement: placementValue });
    activeRemaining -= 1;
  }

  // Refill policy:
  //   * elimination  → full replacement pool (fresh cycle)
  //   * pool empties → non-empty append (fresh cycle pieces added)
  // Never rebuild the tower.
  let nextPool = pool;
  let nextCycle = snapshot.resourceCycle;
  let refilled = false;
  if (eliminations.length > 0 || pool.length === 0) {
    nextCycle += 1;
    if (eliminations.length > 0) {
      nextPool = freshPoolForCycle(snapshot.maxPlayers, snapshot.id, nextCycle);
    } else {
      nextPool = refillResourcePool(pool, snapshot.maxPlayers, `${snapshot.id}:cycle:${nextCycle}`);
    }
    refilled = true;
    // A fresh cycle clears every reservation.
    for (const k of Object.keys(reserve)) reserve[k] = null;
  }

  const finished = activeRemaining <= 1;

  // Next actor + phase.
  let nextPhase: "placement" | "reserve" = "placement";
  let nextTurnPlayerId: string | null = null;
  let nextDeadlineMs: number | null = null;
  if (!finished) {
    nextTurnPlayerId = nextActiveAfter(activePlayers, actingUserId);
    if (refilled) {
      // Fresh resource cycle → every remaining player may reserve first.
      nextPhase = "reserve";
      if (nextTurnPlayerId) nextDeadlineMs = Date.now() + RESERVE_WINDOW_MS;
    } else {
      nextPhase = "placement";
      if (nextTurnPlayerId) nextDeadlineMs = Date.now() + TURN_PLACEMENT_WINDOW_MS;
    }
  }

  const success: ResolveSuccess = {
    ok: true,
    resolved: {
      blockShape,
      fromReserve,
      entry,
      stable: sim.stable,
      collapsed: sim.collapsed,
      removedBlockIds: sim.removedBlockIds,
      towerState: sim.tower,
      pool: nextPool,
      reserveState: reserve,
      refilled,
      resourceCycle: nextCycle,
      eliminations,
      finished,
      activeRemaining,
      nextTurnPlayerId,
      nextDeadlineMs,
      nextPhase,
    },
  };
  return success;
}

// Re-exported shape guard so the resolver stays self-contained for tests.
export { BLOCK_SHAPES, footprintFor };