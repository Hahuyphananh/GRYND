// src/lib/tower-arena/turnResolver.ts
//
// Pure, deterministic Tower Arena turn resolution. The game is a stable
// Tetris-like stacker: every placement uses the shared pool, blocks stay fixed,
// and a placement over the ceiling eliminates its player and trims the tower.

import {
  BLOCK_SHAPES,
  centerXFor,
  dropInBounds,
  findSafeDrop,
  refillResourcePool,
  simulatePlacement,
  takeFromPool,
  buildResourcePool,
  trimTowerAfterElimination,
  type BlockShape,
  type ResourcePiece,
  type TowerState,
} from "./engine";

export const TURN_PLACEMENT_WINDOW_MS = 60_000;
// Kept as compatibility exports for older store callers; active games no
// longer enter a reserve phase or expose reserve controls.
export const RESERVE_WINDOW_MS = 60_000;
export const AI_RESERVE_WINDOW_MS = 10_000;
export const AI_TURN_PLACEMENT_WINDOW_MS = 60_000;
export const MAX_RESERVE_USES = 2;

// How long a bot's placement turn lasts. Bots don't need the full 60s
// human window; a short "thinking" beat lets every viewer see the bot's
// planned-placement ghost before the block pops into the tower. The server
// enforces this window (polls no-op until it passes), so the placeholder is
// visible on every client, not just the one that fires /ai-turn.
export const BOT_THINK_MS = 700;

export interface ResolverPlayer {
  userId: string;
  seat: number;
  status: string;
  isAi: boolean;
  reserveUsesRemaining: number;
  placement?: number;
  ready?: boolean;
}

export type ReserveMap = Record<string, { blockId: string; shape: BlockShape } | null>;

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
  resolvedX: number;
  placedCells: Array<{ x: number; depth: number; z: number }>;
  removedBlocks: Array<{ id: string; cells: Array<{ x: number; depth: number; z: number }> }>;
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
  placement: number;
}

export interface ResolvedPlacement {
  blockShape: BlockShape;
  fromReserve: boolean;
  entry: PlacementEntry;
  stable: boolean;
  collapsed: boolean;
  removedBlockIds: string[];
  towerState: TowerState;
  pool: ResourcePiece[];
  reserveState: ReserveMap;
  refilled: boolean;
  resourceCycle: number;
  eliminations: EliminationOutcome[];
  finished: boolean;
  activeRemaining: number;
  nextTurnPlayerId: string | null;
  nextDeadlineMs: number | null;
  nextPhase: "placement";
}

export function isActivePlayer(p: ResolverPlayer): boolean {
  return p?.status === "active";
}

export function activeStanding(
  players: ResolverPlayer[],
  tower: Array<{ placedByUserId?: string }> | null | undefined,
  userId: string,
): number {
  const active = players.filter(isActivePlayer);
  if (active.length === 0) return 1;
  const byBlocks = new Map<string, number>();
  for (const block of tower || []) {
    if (block?.placedByUserId) byBlocks.set(block.placedByUserId, (byBlocks.get(block.placedByUserId) || 0) + 1);
  }
  if ((byBlocks.get(userId) || 0) <= 0) return active.length;
  const sorted = [...active].sort((a, b) => {
    const da = byBlocks.get(a.userId) || 0;
    const db = byBlocks.get(b.userId) || 0;
    return db !== da ? db - da : a.seat - b.seat;
  });
  const index = sorted.findIndex((p) => p.userId === userId);
  return index < 0 ? active.length : index + 1;
}

export function parseReserveMap(raw: unknown): ReserveMap {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as ReserveMap : {};
}

export function parsePool(raw: unknown): ResourcePiece[] {
  return Array.isArray(raw) ? (raw as ResourcePiece[]).slice() : [];
}

export function parsePlacements(raw: unknown): PlacementEntry[] {
  return Array.isArray(raw) ? raw as PlacementEntry[] : [];
}

export function isReadyGateMet(players: ResolverPlayer[]): boolean {
  const active = players.filter(isActivePlayer);
  return active.length > 0 && active.every((p) => p.isAi || Boolean(p.ready));
}

export function nextActiveAfter(players: ResolverPlayer[], afterUserId: string): string | null {
  const active = players.filter(isActivePlayer).map((p) => p.userId);
  if (active.length <= 1) return null;
  const index = active.indexOf(afterUserId);
  return index < 0 ? null : active[(index + 1) % active.length];
}

export function playerByUserId(players: ResolverPlayer[], userId: string): ResolverPlayer | null {
  return players.find((p) => p.userId === userId) || null;
}

export function safeFallbackIntent(snapshot: MatchSnapshot): PlacementIntent {
  const pool = parsePool(snapshot.resourcePool);
  const available: BlockShape[] = [];
  for (const piece of pool) if (!available.includes(piece.shape)) available.push(piece.shape);
  const safe = findSafeDrop(snapshot.towerState || [], available);
  if (safe) return { shape: safe.shape, positionX: safe.x, rotation: safe.rotation, actionType: "TIMEOUT" };
  const shape = (["short", "square", "I", "L", "T", "big", "long"] as BlockShape[]).find((s) => available.includes(s)) || "short";
  return { shape, positionX: centerXFor(shape, 0), rotation: 0, actionType: "TIMEOUT" };
}

export function freshPoolForCycle(maxPlayers: number, matchId: string, cycle: number): ResourcePiece[] {
  return buildResourcePool(maxPlayers, `${matchId}:cycle:${cycle}`);
}

export function clearReserves(reserve: ReserveMap): ReserveMap {
  const next: ReserveMap = {};
  for (const key of Object.keys(reserve)) next[key] = null;
  return next;
}

function priorCeilingEliminations(placements: PlacementEntry[]): number {
  return placements.filter((entry) => Boolean(entry.collapsed)).length;
}

export function resolvePlacement(
  snapshot: MatchSnapshot,
  players: ResolverPlayer[],
  intent: PlacementIntent,
  actingUserId: string,
  windows?: { reserveWindowMs?: number; placementWindowMs?: number },
): ResolveResult {
  const placementWindowMs = windows?.placementWindowMs ?? TURN_PLACEMENT_WINDOW_MS;
  const pool = parsePool(snapshot.resourcePool);
  const tower = Array.isArray(snapshot.towerState) ? snapshot.towerState : [];
  const placements = parsePlacements(snapshot.placements);
  const rotation = Number.isInteger(intent.rotation) ? intent.rotation : 0;

  if (!BLOCK_SHAPES.includes(intent.shape) || !dropInBounds(intent.shape, rotation, intent.positionX)) {
    return { ok: false, error: "Placement out of bounds", status: 400 };
  }

  const activePlayers = players.filter(isActivePlayer);
  const taken = takeFromPool(pool, intent.shape);
  if (!taken.piece) return { ok: false, error: `${intent.shape} block is not available`, status: 409 };

  const turnNumber = snapshot.turnNumber + 1;
  const blockId = `b:${turnNumber}`;
  const sim = simulatePlacement(tower, {
    shape: intent.shape,
    x: intent.positionX,
    rotation,
    blockId,
    placedByUserId: actingUserId,
    turnNumber,
  });

  let nextTower = sim.tower;
  let removedBlockIds = sim.removedBlockIds.slice();
  let removedBlocks = (sim.fallenBlocks || []).map((block) => ({ id: block.id, cells: block.cells }));
  const eliminations: EliminationOutcome[] = [];

  if (sim.collapsed) {
    const alreadyTaken = new Set<number>();
    for (const player of players) {
      if (player.status !== "active" && Number.isInteger(player.placement)) alreadyTaken.add(player.placement as number);
    }
    let placement = snapshot.maxPlayers;
    while (placement > 1 && alreadyTaken.has(placement)) placement -= 1;
    eliminations.push({ userId: actingUserId, placement });

    const trim = trimTowerAfterElimination(tower, priorCeilingEliminations(placements) + 1);
    nextTower = trim.tower;
    removedBlockIds = [...new Set([...removedBlockIds, ...trim.removedBlockIds])];
    const oldById = new Map(tower.map((block) => [block.id, block]));
    removedBlocks = [
      ...removedBlocks,
      ...trim.removedBlockIds.map((id) => oldById.get(id)).filter(Boolean).map((block) => ({ id: block!.id, cells: block!.cells })),
    ];
  }

  let nextCycle = snapshot.resourceCycle;
  let nextPool = taken.pool;
  let refilled = false;
  if (eliminations.length > 0 || nextPool.length === 0) {
    nextCycle += 1;
    nextPool = eliminations.length > 0
      ? freshPoolForCycle(snapshot.maxPlayers, snapshot.id, nextCycle)
      : refillResourcePool(nextPool, snapshot.maxPlayers, `${snapshot.id}:cycle:${nextCycle}`);
    refilled = true;
  }

  const activeRemaining = activePlayers.length - eliminations.length;
  const finished = activeRemaining <= 1;
  const nextTurnPlayerId = finished ? null : nextActiveAfter(activePlayers, actingUserId);
  // The next holder's window depends on who holds it: humans keep the full
  // placement window, bots get a short think window so their planned
  // placement is visible to every viewer before it resolves. A 0 window
  // means untimed (free vs-AI matches) — no deadline is stamped at all.
  const nextHolder = nextTurnPlayerId
    ? activePlayers.find((p) => p.userId === nextTurnPlayerId)
    : null;
  const nextHolderWindowMs = nextHolder?.isAi ? BOT_THINK_MS : placementWindowMs;
  const nextDeadlineMs = nextTurnPlayerId
    ? nextHolderWindowMs > 0
      ? Date.now() + nextHolderWindowMs
      : null
    : null;
  const entry: PlacementEntry = {
    turnNumber,
    userId: actingUserId,
    seat: playerByUserId(activePlayers, actingUserId)?.seat ?? 0,
    shape: intent.shape,
    positionX: intent.positionX,
    rotation,
    blockId,
    fromReserve: false,
    collapsed: sim.collapsed,
    removedBlockIds,
    resolvedX: sim.placedBlock?.x ?? intent.positionX,
    placedCells: sim.placedBlock?.cells ?? [],
    removedBlocks,
    actionType: intent.actionType,
    at: new Date().toISOString(),
  };

  return {
    ok: true,
    resolved: {
      blockShape: intent.shape,
      fromReserve: false,
      entry,
      stable: sim.stable,
      collapsed: sim.collapsed,
      removedBlockIds,
      towerState: nextTower,
      pool: nextPool,
      reserveState: {},
      refilled,
      resourceCycle: nextCycle,
      eliminations,
      finished,
      activeRemaining,
      nextTurnPlayerId,
      nextDeadlineMs,
      nextPhase: "placement",
    },
  };
}

export { BLOCK_SHAPES, centerXFor };
