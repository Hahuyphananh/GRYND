// src/lib/tower-arena/serverStore.ts
//
// Server-authoritative Tower Arena state machine.
//
// Everything that matters — who is in a match, which block the pool offers,
// what a placement resolves to, whether a tower collapses, who is
// eliminated, the final rankings, and every token transfer — is decided
// here inside a DB transaction and persisted. Clients only submit intent
// (reserve a block id, or a placement's shape / x / rotation); they never
// supply HP, stability, winners, payouts, or balances.
//
// Settlement is idempotent: every money-writing path takes a FOR UPDATE
// row lock on the match and only pays out when a conditional UPDATE (status
// 'active' → 'finished') actually transitions the row, so a retried
// resign / disconnect / timer packet can never pay a player twice.
//
// State machine:
//   waiting → active {phase: placement} → finished | cancelled
//   placement: currentTurnPlayerId places; a ceiling breach eliminates them,
//             trims the tower, and advances directly to the next player.
//             If the pool empties or a player is eliminated it refills without
//             rebuilding the tower.
//   finish   : reached when only one player remains (or the match is
//             resigned to that point). Payouts by placement, summing
//             exactly to the prize pool.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  towerArenaMatches,
  towerArenaPlayers,
  towerArenaTurns,
  users,
} from "../../db/schema";
import { resolvePrestigeBadge } from "../prestige";
import { STAKES_RETIRED } from "../games/stakes";
import { sendSystemNotificationEmail } from "../emails/system";
import { DEFAULT_ICON_KEY } from "../iconAssets";
import { getFrameDecorations } from "../cosmetics";
import {
  buildResourcePool,
  BLOCK_SHAPES,
  dropInBounds,
  type BlockShape,
  type ResourcePiece,
  type TowerState,
} from "./engine";
import {
  TURN_PLACEMENT_WINDOW_MS,
  RESERVE_WINDOW_MS,
  AI_TURN_PLACEMENT_WINDOW_MS,
  AI_RESERVE_WINDOW_MS,
  MAX_RESERVE_USES,
  BOT_THINK_MS,
  activeStanding,
} from "./turnResolver";
import { computePotPrize, payoutsByPlacement, paidPlacementsFor } from "./payout";
import { applyPlacementTrophies } from "../trophyStore";
import {
  towerArenaStarted,
  towerArenaBlockPlaced,
  towerArenaTimeout,
  towerArenaCollapse,
  towerArenaEliminated,
  towerArenaFinished,
} from "./analytics";
import { coerceAiDifficulty } from "../aiDifficulty";
import {
  relayTowerArenaLobbyUpdate,
  broadcastTowerArenaMatchEvent,
  TOWER_ARENA_EVENTS,
} from "./realtimeRelay";
import {
  resolvePlacement,
  safeFallbackIntent,
  isReadyGateMet,
  parseReserveMap,
  parsePool,
  parsePlacements,
  type ResolverPlayer,
  type MatchSnapshot,
  type PlacementIntent,
  type ResolvedPlacement,
} from "./turnResolver";

// ── Tunables (re-exported so callers share one source of truth) ────────

export {
  TURN_PLACEMENT_WINDOW_MS,
  RESERVE_WINDOW_MS,
  AI_TURN_PLACEMENT_WINDOW_MS,
  AI_RESERVE_WINDOW_MS,
  MAX_RESERVE_USES,
  BOT_THINK_MS,
} from "./turnResolver";

// Pre-game ready gate: once every player has clicked READY (AI seats are
// always ready) the match enters a 10-second start countdown before play
// begins. The deadline is stored in `turnDeadline` while `status` stays
// "waiting" (phase "countdown"), then `advanceMatchOnPoll` flips the
// match to active (reserve phase + fresh resource pool).
export const READY_COUNTDOWN_MS = 10_000;

export const TOWER_ARENA_LOCK_NAMESPACE = 90_131; // arbitrary game namespace

const ACTIVE_MATCH_STATES = new Set(["active"]);
const OPEN_MATCH_STATES = new Set(["waiting", "active"]);

// ── Free-play pause ─────────────────────────────────────────────────────
//
// Human-vs-AI free-play matches can be paused (a wager match never can). The
// flag lives inside the match's `reserveState` JSONB under a reserved key —
// reserve logic only ever indexes by userId, so a sentinel key is invisible
// to every other path and needs no schema migration. While paused the turn
// engine is frozen: the poll no-ops, bots don't act, and the turn deadline
// is refreshed on resume so pausing never burns anyone's window.
// ── Per-match turn windows ─────────────────────────────────────────────
//
// Free-play (human-vs-AI) matches run on a snappier cadence than paid PvP:
// the reserve window is short (a quick pick or skip) and bots place
// immediately (advanceMatchOnPoll auto-plays them), so the game never
// stalls 60s on a bot. Humans still get the full placement window to aim.

function reserveWindowMs(match: any): number {
  // Free vs-AI matches are untimed for the human — no reserve window.
  // Bots act on demand, so they don't need a pacing window either.
  return Boolean(match?.isAi) ? 0 : RESERVE_WINDOW_MS;
}

function placementWindowMs(match: any): number {
  return Boolean(match?.isAi) ? 0 : TURN_PLACEMENT_WINDOW_MS;
}

const PAUSE_KEY = "__paused__";

function pauseMeta(match: any): { paused?: boolean; pausedAt?: string } | null {
  const m = reserveMap(match)[PAUSE_KEY];
  return m && typeof m === "object" ? (m as { paused?: boolean; pausedAt?: string }) : null;
}

export function matchIsPaused(match: any): boolean {
  return Boolean(pauseMeta(match)?.paused);
}

/**
 * Toggle free-play pause for a human-vs-AI match. Only active participants
 * of an AI match may pause; resuming hands the current phase a fresh full
 * window so the pause never burns a turn.
 */
export async function toggleMatchPause({
  userId,
  matchId,
  paused,
}: {
  userId: string;
  matchId: string;
  paused: boolean;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!match.isAi) return { error: "Only free-play matches can be paused", status: 400 };
    if (!ACTIVE_MATCH_STATES.has(match.status)) return { error: "Match is not active", status: 400 };
    const players = await fetchPlayers(tx, matchId);
    const p = playerByUserId(players, userId);
    if (!p || !isActive(p)) return { error: "Not an active participant", status: 403 };  const reserve = reserveMap(match);
      const nextReserve: Record<string, any> = { ...reserve };
    let turnDeadline: Date | null = match.turnDeadline;
    if (paused) {
      nextReserve[PAUSE_KEY] = {
        paused: true,
        pausedAt: new Date().toISOString(),
      };
    } else {
      if (!pauseMeta(match)?.paused) return { error: "Match is not paused", status: 409 };
      delete nextReserve[PAUSE_KEY];
      // Resume hands the current holder a fresh full window — but a bot
      // holder only gets its short think window (the human's ghost beat).
      // Untimed vs-AI matches keep a null deadline for the human.
      const holder = playerByUserId(players, match.currentTurnPlayerId);
      if (holder?.isAi) {
        turnDeadline = new Date(Date.now() + BOT_THINK_MS);
      } else {
        turnDeadline = match.isAi ? null : new Date(Date.now() + placementWindowMs(match));
      }
    }

    await tx
      .update(towerArenaMatches)
      .set({ reserveState: nextReserve, turnDeadline })
      .where(eq(towerArenaMatches.id, matchId));

    void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.STATE, {
      paused,
      status: match.status,
    });
    return { ok: true, paused };
  });
}

// ── Small helpers ──────────────────────────────────────────────────────

function hashMatchmakeKey(wager: number, maxPlayers: number): number {
  let h = 2166136261;
  const s = `${Math.trunc(wager)}:${maxPlayers}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h | 0) & 0x7fffffff;
}

async function fetchMatchForUpdate(tx: any, matchId: string) {
  const [match] = await tx
    .select()
    .from(towerArenaMatches)
    .where(eq(towerArenaMatches.id, matchId))
    .for("update");
  return match || null;
}

async function fetchPlayers(tx: any, matchId: string) {
  return tx
    .select()
    .from(towerArenaPlayers)
    .where(eq(towerArenaPlayers.matchId, matchId))
    .orderBy(asc(towerArenaPlayers.seat));
}

function playerByUserId(players: any[], userId: string) {
  for (const p of players) if (p.userId === userId) return p;
  return null;
}

function isActive(p: any) {
  return p?.status === "active";
}

// Seeded, stable pick of the starting seat (randomized but auditable).
function pickStartId(players: any[]): string | null {
  const active = players.filter(isActive);
  if (active.length === 0) return null;
  const idx = Math.floor(Math.random() * active.length);
  return active[idx].userId;
}

// The next active seat after `afterUserId` (wraps around, skips
// eliminated). Returns null when only `afterUserId`/none remain.
function nextActiveAfter(players: any[], afterUserId: string): string | null {
  const seats = players.filter(isActive).map((p) => p.userId);
  if (seats.length <= 1) return null;
  const idx = seats.indexOf(afterUserId);
  return seats[(idx + 1) % seats.length];
}

function reserveMap(match: any): Record<string, { blockId: string; shape: BlockShape } | null> {
  const raw = match?.reserveState;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function poolPieces(match: any): ResourcePiece[] {
  return Array.isArray(match?.resourcePool) ? match.resourcePool : [];
}

function placements(match: any): any[] {
  return Array.isArray(match?.placements) ? match.placements : [];
}

// Build a fresh pool + reset reserve bookkeeping for a new cycle.
function newCycleState(match: any, idx: number) {
  const nonce = `${match.id}:cycle:${idx}`;
  const pool = buildResourcePool(match.maxPlayers, nonce);
  return { pool, nonce };
}

// ── Create / join (matchmaking + manual join), wager escrow ────────────

function validateParams(wager: number, maxPlayers: number) {
  const w = Math.trunc(Number(wager) || 0);
  const m = Math.trunc(Number(maxPlayers) || 0);
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a free lobby (wager 0) is
  // the only legal entry, so the positive-integer rule no longer rejects it.
  if (!STAKES_RETIRED && w <= 0) return { ok: false as const, error: "Wager must be a positive integer", status: 400 };
  if (!Number.isInteger(m) || m < 2 || m > 6) {
    return { ok: false as const, error: "maxPlayers must be an integer from 2 to 6", status: 400 };
  }
  return { ok: true as const, wager: w, maxPlayers: m };
}

/**
 * Matchmaking entry point used by quick-queue and the tower arena lobby
 * "play" flow: fill an open waiting lobby with the same wager + seat
 * count, or create a new one. Escrows the wager on join. Returns the
 * match (waiting until seats fill, then started).
 */
export async function createOrJoinTowerArena({
  userId,
  wager,
  maxPlayers,
}: {
  userId: string;
  wager: number;
  maxPlayers: number;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const v = validateParams(wager, maxPlayers);
  if (!v.ok) return { error: v.error, status: v.status };

  const lockKey = hashMatchmakeKey(v.wager, v.maxPlayers);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TOWER_ARENA_LOCK_NAMESPACE}, ${lockKey})`);

    const candidates = await tx
      .select()
      .from(towerArenaMatches)
      .where(
        and(
          eq(towerArenaMatches.wager, v.wager),
          eq(towerArenaMatches.maxPlayers, v.maxPlayers),
          eq(towerArenaMatches.status, "waiting"),
        ),
      )
      .orderBy(asc(towerArenaMatches.createdAt))
      .for("update");

    for (const cand of candidates) {
      const cur = await fetchPlayers(tx, cand.id);
      if (cur.some((p) => p.userId === userId)) return { match: cand, joined: false };
      if (cur.length < cand.maxPlayers) {
        return await joinLobbyTx(tx, cand, userId);
      }
    }

    return await createLobbyTx(tx, userId, v.wager, v.maxPlayers);
  });
}

/** Manual create lobby (explicit player count). */
export async function createTowerArenaLobby({
  userId,
  wager,
  maxPlayers,
}: {
  userId: string;
  wager: number;
  maxPlayers: number;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const v = validateParams(wager, maxPlayers);
  if (!v.ok) return { error: v.error, status: v.status };
  const res = await db.transaction(async (tx) => createLobbyTx(tx, userId, v.wager, v.maxPlayers));
  if (res.match?.id) {
    void relayTowerArenaLobbyUpdate(res.match.id, { event: "created", wager: v.wager, maxPlayers: v.maxPlayers, playerCount: 1 });
  }
  return res;
}

/** Manual join a specific lobby. */
export async function joinTowerArenaLobby({ userId, lobbyId }: { userId: string; lobbyId: string }) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, lobbyId);
    if (!match) return { error: "Match unavailable", status: 404 };
    if (!OPEN_MATCH_STATES.has(match.status)) {
      return { error: "Lobby is no longer available", status: 409 };
    }
    const cur = await fetchPlayers(tx, match.id);
    if (cur.some((p) => p.userId === userId)) return { match, joined: false };
    if (cur.length >= match.maxPlayers) return { error: "Lobby is full", status: 409 };
    return await joinLobbyTx(tx, match, userId);
  }).then(async (res: any) => {
    if (!res.error && res.match?.id) {
      void relayTowerArenaLobbyUpdate(res.match.id, {
        event: res.started ? "started" : "joined",
        wager: res.match.wager,
        maxPlayers: res.match.maxPlayers,
        playerCount: (typeof res.playerCount === "number" ? res.playerCount : undefined) ?? undefined,
      });
    }
    return res;
  });
}

async function createLobbyTx(tx: any, userId: string, wager: number, maxPlayers: number) {
  const [match] = await tx
    .insert(towerArenaMatches)
    .values({
      hostUserId: userId,
      wager,
      maxPlayers,
      status: "waiting",
      phase: "waiting",
    })
    .returning();

  await tx.insert(towerArenaPlayers).values({
    matchId: match.id,
    userId,
    seat: 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
  });

  return { match, joined: false, started: false };
}

/**
 * Free-play human-vs-AI match. No tokens move; `maxPlayers - 1` bot
 * seats are added but the match does NOT start yet — the human lands in
 * the ready room and clicks READY (bots are always ready), which opens
 * the 10s start countdown. Uses the placement-only stacker (bots place via
 * playAiTurn).
 */
export async function createAiTowerArenaMatch({
  userId,
  maxPlayers = 2,
  difficulty,
}: {
  userId: string;
  maxPlayers?: number;
  difficulty?: unknown;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const m = Math.trunc(Number(maxPlayers) || 0);
  if (!Number.isInteger(m) || m < 2 || m > 6) {
    return { error: "maxPlayers must be an integer from 2 to 6", status: 400 };
  }
  // The lobby's AI tier, stored on the row so the bot's placement policy
  // (see safeFallbackPlacement) reads it on every turn.
  const aiDifficulty = coerceAiDifficulty(difficulty);
  return db.transaction(async (tx) => {
    const [match] = await tx
      .insert(towerArenaMatches)
      .values({
        hostUserId: userId,
        wager: 0,
        maxPlayers: m,
        status: "waiting",
        // Lobby is "full" the moment it is created (the bot seats exist),
        // so it opens directly in the ready gate.
        phase: "ready",
        isAi: true,
        aiDifficulty,
      })
      .returning();

    await tx.insert(towerArenaPlayers).values({
      matchId: match.id,
      userId,
      seat: 1,
      status: "active",
      isAi: false,
      ready: false,
      reserveUsesRemaining: MAX_RESERVE_USES,
    });
    for (let seat = 2; seat <= m; seat += 1) {
      await tx.insert(towerArenaPlayers).values({
        matchId: match.id,
        userId: `AI_BOT_${seat}`,
        seat,
        status: "active",
        isAi: true,
        ready: true,
        reserveUsesRemaining: MAX_RESERVE_USES,
      });
    }

    return { match, joined: true, started: false };
  });
}

/**
 * Deterministic AI placement when it is a bot's turn. The bot prefers a
 * held reservation, else the safest available shape, placed centered.
 * Used by /api/tower-arena/ai-turn; timeout fallback also resolves bots.
 */
export async function playAiTurn({ matchId }: { matchId: string }) {
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!ACTIVE_MATCH_STATES.has(match.status) || match.phase !== "placement") {
      return { error: "Not in placement phase", status: 400 };
    }
    if (matchIsPaused(match)) return { error: "Match is paused", status: 409 };
    const players = await fetchPlayers(tx, matchId);
    const cur = playerByUserId(players, match.currentTurnPlayerId);
    if (!cur) return { error: "No active turn", status: 400 };
    if (!cur.isAi) return { error: "Not an AI turn", status: 403 };
    // Respect the bot's short think window: the /ai-turn request (fired by
    // every viewer after BOT_THINK_MS) must not resolve the bot early — the
    // poll backstop resolves it the moment the window passes.
    if (match.turnDeadline) {
      const dl = new Date(match.turnDeadline).getTime();
      if (dl > Date.now()) return { error: "Bot is still planning its placement", status: 409 };
    }
    const fallback = safeFallbackPlacement(match);
    const result = await applyPlacement(tx, match, players, cur, {
      ...fallback,
      actionType: "AI",
    });
    return result.error
      ? { error: result.error, status: result.status || 409 }
      : { ok: true, match: await fetchMatchForUpdate(tx, matchId), ...result };
  });
}

async function joinLobbyTx(tx: any, match: any, userId: string) {
  const cur = await fetchPlayers(tx, match.id);
  const nextSeat = cur.length + 1;

  const [player] = await tx
    .insert(towerArenaPlayers)
    .values({
      matchId: match.id,
      userId,
      seat: nextSeat,
      status: "active",
      isAi: false,
      ready: false,
      reserveUsesRemaining: MAX_RESERVE_USES,
    })
    .returning();

  let updated = match;
  let becameReady = false;
  if (nextSeat >= match.maxPlayers) {
    // Lobby is full — do NOT auto-start. Move to the ready gate so every
    // player clicks READY; the match starts after the 10s countdown.
    const [u] = await tx
      .update(towerArenaMatches)
      .set({ phase: "ready" })
      .where(
        and(
          eq(towerArenaMatches.id, match.id),
          eq(towerArenaMatches.status, "waiting"),
          eq(towerArenaMatches.phase, "waiting"),
        ),
      )
      .returning();
    if (u) {
      updated = u;
      becameReady = true;
    }
  }

  // Defensive: if the filled lobby somehow already has every player ready
  // (e.g. an AI bot seat was added), open the start countdown immediately.
  const after = await fetchPlayers(tx, match.id);
  if (becameReady && isReadyGateMet(after)) {
    await tx
      .update(towerArenaMatches)
      .set({ phase: "countdown", turnDeadline: new Date(Date.now() + READY_COUNTDOWN_MS) })
      .where(and(eq(towerArenaMatches.id, match.id), eq(towerArenaMatches.status, "waiting")));
    updated = await fetchMatchForUpdate(tx, match.id);
  }

  return { match: updated, joined: true, started: false, player };
}

// ── Ready gate ─────────────────────────────────────────────────────────
//
// Every ACTIVE player must click READY before the match may start; clicking
// again unreadies (which cancels a running countdown). Once the lobby is
// full and every player is ready, the match enters a 10-second start
// countdown (status stays "waiting", phase "countdown", deadline in
// `turnDeadline`); `advanceMatchOnPoll` flips it to active when the
// deadline passes. AI seats are always ready.

export async function toggleTowerArenaReady({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== "waiting") {
      return { error: "Match has already started", status: 409 };
    }
    const players = await fetchPlayers(tx, matchId);
    const p = playerByUserId(players, userId);
    if (!p) return { error: "Not a participant", status: 403 };
    if (p.isAi) return { error: "AI seats are always ready", status: 403 };

    const nextReady = !Boolean(p.ready);
    await tx
      .update(towerArenaPlayers)
      .set({ ready: nextReady })
      .where(and(eq(towerArenaPlayers.matchId, matchId), eq(towerArenaPlayers.userId, userId)));

    const after = await fetchPlayers(tx, matchId);
    let phase = match.phase;
    let deadline = match.turnDeadline;
    let countdownStarted = false;
    let countdownCancelled = false;
    if (nextReady && isReadyGateMet(after) && after.length >= match.maxPlayers) {
      // Everyone (incl. the just-readied player) is ready and the lobby is
      // full → begin the 10-second start countdown.
      phase = "countdown";
      deadline = new Date(Date.now() + READY_COUNTDOWN_MS);
      countdownStarted = true;
    } else if (!nextReady && phase === "countdown") {
      // A player unreadied mid-countdown → abort the start.
      phase = "ready";
      deadline = null;
      countdownCancelled = true;
    } else if (!nextReady && phase !== "countdown" && match.maxPlayers > 0 && after.length >= match.maxPlayers) {
      phase = "ready";
    }

    if (phase !== match.phase || deadline !== match.turnDeadline) {
      await tx
        .update(towerArenaMatches)
        .set({ phase, turnDeadline: deadline })
        .where(eq(towerArenaMatches.id, matchId));
    }

    const playerCount = after.length;
    // Instant refresh for every seat in the lobby (and the public grid).
    void relayTowerArenaLobbyUpdate(matchId, {
      event: countdownStarted ? "countdown" : countdownCancelled ? "countdown-cancelled" : nextReady ? "ready" : "unready",
      wager: match.wager,
      maxPlayers: match.maxPlayers,
      playerCount,
      ready: nextReady,
      phase,
    });
    if (countdownStarted) {
      void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.STATE, {
        status: "waiting",
        phase: "countdown",
        turnDeadline: deadline ? new Date(deadline).toISOString() : null,
      });
    }

    return {
      ok: true,
      ready: nextReady,
      countdownStarted,
      countdownCancelled,
      phase,
      playerCount,
    };
  });
}

/**
 * Flip a full waiting match into active play: pick a randomized starting
 * player, open placement, and build the pool.
 */
async function startMatchTx(tx: any, matchId: string, _opts: { finalMaxPlayers?: number }) {
  const match = await fetchMatchForUpdate(tx, matchId);
  const players = await fetchPlayers(tx, matchId);
  const startId = pickStartId(players);
  const startPlayer = players.find((p) => p.userId === startId);
  // If the randomized starting seat is a bot, it gets the short think window
  // (viewers see its planned-placement ghost); humans keep the full window.
  // Untimed vs-AI matches stamp no deadline for a human starter.
  const startWin = startPlayer?.isAi ? BOT_THINK_MS : placementWindowMs(match);
  const startDeadline = startPlayer?.isAi || !match.isAi ? new Date(Date.now() + startWin) : null;

  const { pool } = newCycleState(match, 1);
  await tx
    .update(towerArenaMatches)
    .set({
      status: "active",
      phase: "placement",
      resourceCycle: 1,
      turnNumber: 0,
      currentTurnPlayerId: startId,
      turnDeadline: startDeadline,
      resourcePool: pool,
      towerState: [] as TowerState,
      reserveState: {},
      placements: [],
      finalRankings: [],
      startedAt: new Date(),
    })
    .where(eq(towerArenaMatches.id, matchId));

  towerArenaStarted({
    distinctId: startId || match.hostUserId || "tower_arena",
    matchId: match.id,
    maxPlayers: match.maxPlayers,
    wager: match.wager,
    isAi: Boolean(match.isAi),
  });

  const placementDeadline = startDeadline ?? new Date(Date.now() + startWin);
  const broadcastDeadline = startDeadline ? placementDeadline.toISOString() : null;
  void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.STATE, {
    status: "active",
    phase: "placement",
    currentTurnPlayerId: startId,
    turnDeadline: broadcastDeadline,
    resourceCycle: 1,
    turnNumber: 0,
  });
  void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.TURN_STARTED, {
    playerId: startId,
    turnDeadline: broadcastDeadline,
  });

  return fetchMatchForUpdate(tx, matchId);
}

// ── Legacy reserve endpoint ────────────────────────────────────────────
//
// Reserve was intentionally removed from active gameplay. Keep this export
// temporarily so an old route/deployment fails closed instead of mutating
// match state.

export async function reserveBlock({
  userId,
  matchId,
  blockId,
}: {
  userId: string;
  matchId: string;
  blockId: string;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  void matchId;
  void blockId;
  return { error: "Reserve logic has been removed", status: 410 };
}

// ── Placement ──────────────────────────────────────────────────────────

function validatePlacementPayload(body: any) {
  const shape = String(body?.shape || "");
  if (!BLOCK_SHAPES.includes(shape as BlockShape)) {
    return { ok: false as const, error: "Unknown block shape", status: 400 };
  }
  const x = Math.trunc(Number(body?.positionX));
  const rotation = Math.trunc(Number(body?.rotation) || 0);
  if (!Number.isInteger(x)) return { ok: false as const, error: "positionX is required", status: 400 };
  return { ok: true as const, shape: shape as BlockShape, x, rotation };
}

/** Explicit human (or AI) placement. */
export async function submitPlacement({
  userId,
  matchId,
  shape,
  positionX,
  rotation,
}: {
  userId: string;
  matchId: string;
  shape: BlockShape;
  positionX: number;
  rotation?: number;
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const v = validatePlacementPayload({ shape, positionX, rotation });
  if (!v.ok) return { error: v.error, status: v.status };
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!ACTIVE_MATCH_STATES.has(match.status) || match.phase !== "placement") {
      return { error: "Not in placement phase", status: 400 };
    }
    if (matchIsPaused(match)) return { error: "Match is paused", status: 409 };
    // Free vs-AI matches are untimed — the human's deadline never expires,
    // so the stale-deadline guard must not reject their placement.
    if (!match.isAi && TURN_PLACEMENT_WINDOW_MS > 0 && match.turnDeadline) {
      const dl = new Date(match.turnDeadline).getTime();
      if (dl <= Date.now()) {
        // Timed out — a safe deterministic fallback must resolve first.
        return { error: "Turn expired; safe fallback will be applied", status: 409 };
      }
    }
    const players = await fetchPlayers(tx, matchId);
    if (userIsAi(players, userId)) {
      return { error: "Cannot act for the AI seat", status: 403 };
    }
    if (match.currentTurnPlayerId !== userId) {
      return { error: "Not your turn", status: 403 };
    }
    const p = playerByUserId(players, userId);
    if (!p || !isActive(p)) return { error: "Not an active participant", status: 403 };

    // Drop-aim validation before mutating anything: there are NO side walls —
    // any aim inside the drop range is legal, including fully into the void
    // beside the platform (which resolves to a void fall and elimination).
    if (!dropInBounds(v.shape, v.rotation, v.x)) {
      return { error: "Placement out of bounds", status: 400 };
    }

    return applyPlacement(tx, match, players, p, {
      shape: v.shape,
      positionX: v.x,
      rotation: v.rotation,
      actionType: "PLACE",
    });
  });
}

function userIsAi(players: any[], userId: string): boolean {
  const p = playerByUserId(players, userId);
  return Boolean(p?.isAi);
}

// Full, shared placement transition (used by explicit submit, the AI
// route, and the deterministic timeout fallback). Resolves the next state via
// the pure turnResolver, then persists every outcome inside the caller's
// transaction. The condition that only ONE active player remains short-circuits
// straight to finishMatchTx (idempotent settlement).
async function applyPlacement(
  tx: any,
  match: any,
  players: any[],
  acting: any,
  params: { shape: BlockShape; positionX: number; rotation: number; actionType: "PLACE" | "AI" | "TIMEOUT" },
) {
  const snapshot: MatchSnapshot = matchSnapshot(match);
  const resolvers: ResolverPlayer[] = players.map(toResolverPlayer);
  const result = resolvePlacement(snapshot, resolvers, {
    shape: params.shape,
    positionX: params.positionX,
    rotation: params.rotation,
    actionType: params.actionType,
  }, acting.userId, {
    reserveWindowMs: reserveWindowMs(match),
    placementWindowMs: placementWindowMs(match),
  });
  if (!("resolved" in result)) return { error: result.error, status: result.status };
  const r = result.resolved;
  const eliminated = r.eliminations.length > 0;

  // Persist eliminations (a collapse drops the responsible player).
  for (const e of r.eliminations) {
    await tx
      .update(towerArenaPlayers)
      .set({ status: "eliminated", eliminatedAt: new Date(), placement: e.placement })
      .where(and(eq(towerArenaPlayers.matchId, match.id), eq(towerArenaPlayers.userId, e.userId)));
  }

  const newestPlacements = [...placements(match), r.entry];
  const updates: Record<string, unknown> = {
    turnNumber: r.entry.turnNumber,
    towerState: r.towerState,
    resourcePool: r.pool,
    reserveState: r.reserveState,
    placements: newestPlacements,
    phase: r.finished ? "placement" : r.nextPhase,
    currentTurnPlayerId: r.finished ? null : r.nextTurnPlayerId,
    turnDeadline: r.finished ? null : r.nextDeadlineMs ? new Date(r.nextDeadlineMs) : null,
  };
  if (r.resourceCycle !== match.resourceCycle) {
    updates.resourceCycle = r.resourceCycle;
  }

  await tx
    .update(towerArenaMatches)
    .set(updates)
    .where(eq(towerArenaMatches.id, match.id));
  await tx.insert(towerArenaTurns).values({
    matchId: match.id,
    userId: acting.userId,
    seat: acting.seat,
    turnNumber: r.entry.turnNumber,
    resourceCycle: r.resourceCycle,
    phase: "placement",
    actionType: params.actionType,
    blockShape: r.blockShape,
    positionX: params.positionX,
    rotation: params.rotation,
    blockId: r.entry.blockId,
    collapsed: r.collapsed,
    towerDelta: { removedBlockIds: r.removedBlockIds, fromReserve: r.fromReserve },
  });

  // Server-authoritative analytics (fire-and-forget; never affects settlement).
  if (params.actionType === "TIMEOUT") {
    towerArenaTimeout({ distinctId: acting.userId, matchId: match.id, isAi: Boolean(match.isAi) });
  } else if (params.actionType === "PLACE") {
    towerArenaBlockPlaced({
      distinctId: acting.userId,
      matchId: match.id,
      turnNumber: r.entry.turnNumber,
      collapsed: r.collapsed,
      isAi: Boolean(match.isAi),
    });
  }
  if (r.collapsed) {
    towerArenaCollapse({
      distinctId: acting.userId,
      matchId: match.id,
      maxPlayers: match.maxPlayers,
      isAi: Boolean(match.isAi),
    });
  }
  for (const e of r.eliminations) {
    towerArenaEliminated({
      distinctId: e.userId,
      matchId: match.id,
      placement: e.placement,
      reason: "collapse",
      maxPlayers: match.maxPlayers,
    });
  }

  // Push in-match realtime events. Light payloads only — authoritative
  // details (winner / payout / collapse verdict) are re-fetched by clients.
  void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.BLOCK_PLACED, {
    playerId: acting.userId,
    turnNumber: r.entry.turnNumber,
  });
  if (r.collapsed) {
    void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.COLLAPSE, {
      playerId: acting.userId,
    });
  }
  for (const e of r.eliminations) {
    void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.PLAYER_ELIMINATED, {
      playerId: e.userId,
      placement: e.placement,
      reason: "collapse",
    });
  }
  if (r.refilled) {
    void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.RESOURCE_REFILL, {
      resourceCycle: r.resourceCycle,
    });
  }
  void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.RESOURCE_UPDATE, {
    resourceCycle: r.resourceCycle,
  });
  if (!r.finished && r.nextTurnPlayerId) {
    const deadline = r.nextDeadlineMs ? new Date(r.nextDeadlineMs).toISOString() : undefined;
    void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.TURN_STARTED, {
      playerId: r.nextTurnPlayerId,
      turnDeadline: deadline,
    });
  }

  const placementValue = r.eliminations.length ? r.eliminations[0].placement : null;
  if (r.finished) {
    const freshMatch = await fetchMatchForUpdate(tx, match.id);
    const freshPlayers = await fetchPlayers(tx, match.id);
    await finishMatchTx(tx, freshMatch, freshPlayers);
    return {
      ok: true,
      collapsed: r.collapsed,
      eliminated,
      matchFinished: true,
      placementValue,
    };
  }

  return {
    ok: true,
    collapsed: r.collapsed,
    eliminated,
    matchFinished: false,
    placementValue,
  };
}

/** Project an ORM match row into the pure resolver's snapshot shape. */
function matchSnapshot(m: any): MatchSnapshot {
  return {
    id: m.id,
    status: m.status,
    phase: m.phase,
    maxPlayers: m.maxPlayers,
    resourceCycle: Number(m.resourceCycle || 0),
    turnNumber: Number(m.turnNumber || 0),
    currentTurnPlayerId: m.currentTurnPlayerId ?? null,
    turnDeadline: m.turnDeadline ?? null,
    resourcePool: parsePool(m.resourcePool),
    towerState: Array.isArray(m.towerState) ? m.towerState : [],
    reserveState: parseReserveMap(m.reserveState),
    placements: parsePlacements(m.placements),
  };
}

function toResolverPlayer(p: any): ResolverPlayer {
  return {
    userId: p.userId,
    seat: p.seat,
    status: p.status,
    isAi: Boolean(p.isAi),
    reserveUsesRemaining: Number(p.reserveUsesRemaining ?? 0),
    placement: p.placement != null ? Number(p.placement) : undefined,
  };
}

// ── Finish + settlement (idempotent) ───────────────────────────────────
//
// Only one caller may settle: the FOR UPDATE lock + a conditional UPDATE
// `status = 'active' → 'finished'` guard means the tokens are credited
// only when THIS transaction is the one that flips the row. A retry that
// arrives after settlement sees status already 'finished' and refunds
// nothing.
async function finishMatchTx(tx: any, match: any, players: any[]) {
  // The final survivor takes the best placement still free (normally 1 — but
  // a mid-match resignation can claim an in-order slot, e.g. a 2nd-place
  // resigner keeps 2nd, so the survivor takes the smallest unclaimed one).
  const taken = new Set<number>();
  for (const p of players) {
    if (p.status !== "active" && Number.isInteger(p.placement)) taken.add(Number(p.placement));
  }
  let survivorPlacement = 1;
  while (taken.has(survivorPlacement)) survivorPlacement += 1;

  // Recompute final rankings from player placement values (ascending).
  const ranked = [...players]
    .map((p) => ({
      userId: p.userId,
      seat: p.seat,
      placement: isActive(p) ? survivorPlacement : Number(p.placement || 0),
      payout: 0,
      isAi: Boolean(p.isAi),
      isWinner: false,
    }))
    .sort((a, b) => a.placement - b.placement);

  const winner = ranked.find((r) => r.placement === 1) || null;
  // STAKES ARE RETIRED: there is no pot, no rake and no payout to move.
  const prizePool = 0;
  const houseFee = 0;
  const pot = 0;
  const isPaid = false;

  // Win/lose verdict per player (drives the result popups): a seat that landed
  // in a paid slot is a winner.
  const paidSlots = paidPlacementsFor(match.maxPlayers);
  ranked.forEach((r) => {
    r.isWinner = r.placement <= paidSlots;
  });

  // The transition guard: only credit if we actually flip active→finished.
  const [updated] = await tx
    .update(towerArenaMatches)
    .set({
      status: "finished",
      phase: "finished",
      winnerId: winner?.userId ?? null,
      finalRankings: ranked,
      prizePool,
      houseFee,
      pot,
      endedAt: new Date(),
      currentTurnPlayerId: null,
      turnDeadline: null,
    })
    .where(and(eq(towerArenaMatches.id, match.id), eq(towerArenaMatches.status, "active")))
    .returning();

  if (!updated) return { match, alreadyFinished: true };

  // ── Trophies: the symmetric placement ladder ────────────────────────
  // `ranked` is the server-derived final standing (clients can never supply
  // it, and the engine's collapse/elimination order is what produces it), so
  // the human seats are read straight into the ladder: the top of the table
  // banks the full +30, the bottom pays the full −30, and every seat between
  // them trades the even shares (a 4-seat table pays +30/+10/−10/−30, a 6-seat
  // table +30/+18/+6/−6/−18/−30). Seats level on the same placement — which the
  // engine can produce when two players are eliminated by one collapse — share
  // the average of the ranks they span.
  //
  // This is a REAL PvP match (`match.isAi` is an AI-filled practice match) whose
  // win was decided on the server. It deliberately does NOT depend on the
  // wager: the token economy is being retired, and a rated match must not stop
  // being rated because its buy-in changed. Bot seats hold no account and are
  // left out; a match won by a bot settles nothing at all. The
  // active→finished guard above means this runs exactly once per match, and the
  // per-seat trophy journal makes a replay a no-op on top of that.
  if (!match.isAi && winner && !winner.isAi) {
    const placementGroups: string[][] = [];
    let lastPlacement: number | null = null;
    for (const seat of ranked) {
      if (seat.isAi || !seat.userId) continue;
      if (lastPlacement !== null && seat.placement === lastPlacement) {
        placementGroups[placementGroups.length - 1].push(seat.userId);
        continue;
      }
      placementGroups.push([seat.userId]);
      lastPlacement = seat.placement;
    }
    if (placementGroups.flat().length > 1) {
      await applyPlacementTrophies({
        tx,
        gameKey: "tower-arena",
        matchId: String(match.id),
        placements: placementGroups,
      }).catch(() => {});
    }
  }

  const finishDistinctId =
    winner && !winner.isAi ? winner.userId : match.hostUserId || "system";
  towerArenaFinished({
    distinctId: finishDistinctId,
    matchId: match.id,
    maxPlayers: match.maxPlayers,
    wager: match.wager,
    isAi: Boolean(match.isAi),
  });

  // Realtime: the authoritative finale. Clients reconcile via get-match.
  void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.STATE, {
    status: "finished",
    winnerId: winner?.userId ?? null,
    maxPlayers: match.maxPlayers,
    finalRankings: ranked.map((r) => ({
      userId: r.userId,
      placement: r.placement,
      payout: r.payout,
      isWinner: r.isWinner,
    })),
  });
  void broadcastTowerArenaMatchEvent(match.id, TOWER_ARENA_EVENTS.MATCH_FINISHED, {
    winnerId: winner?.userId ?? null,
    maxPlayers: match.maxPlayers,
  });

  if (winner && isPaid && match.wager >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `Tower Arena finished (${match.maxPlayers} players, wager ${match.wager}); winner ${winner.userId} took ${Math.max(0, ranked[0]?.payout || 0)}.`,
      metadata: { matchId: match.id, wager: match.wager, winnerId: winner.userId },
    }).catch(() => {});
  }

  return { match, alreadyFinished: false };
}

// ── Decided standing (read-only) ───────────────────────────────────────
//
// The viewer's placement + payout for a seat whose result is ALREADY
// decided while the match is still running — an eliminated player in a
// 3+ seat game. Pure read-only mirror of the settlement math in
// `finishMatchTx` and the resign branch of `removeParticipant`, so the
// client can show the losing popup the moment a player is out without
// inventing (or altering) any number: the real credit still happens once,
// at finish, from the same helpers.
function decidedStanding(match: any, player: any) {
  const placement = Number(player?.placement);
  if (!Number.isInteger(placement) || placement < 1) return null;
  const isPaid = !match.isAi && match.wager > 0;
  let payout = 0;
  if (isPaid) {
    const cfg = computePotPrize({ maxPlayers: match.maxPlayers, wager: match.wager });
    const byPlacement = payoutsByPlacement({
      maxPlayers: match.maxPlayers,
      wager: match.wager,
      prizePool: cfg.prizePool,
    });
    payout = Math.min(
      byPlacement[Math.max(0, placement - 1)] ?? 0,
      cfg.prizePool,
    );
  }
  return {
    placement,
    payout,
    net: payout - match.wager,
    isWinner: match.isAi
      ? placement <= paidPlacementsFor(match.maxPlayers)
      : payout > match.wager,
  };
}

// ── Resign / disconnect (idempotent, shared) ───────────────────────────

/** Shared eliminator used by user resign and realtime disconnect settle. */
export async function removeParticipant({
  userId,
  matchId,
  reason = "resign",
}: {
  userId: string;
  matchId: string;
  reason?: "resign" | "disconnect";
}) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };

    // Terminal already — idempotent no-op.
    if (match.status === "finished" || match.status === "cancelled") {
      return { match, alreadyTerminal: true };
    }

    const players = await fetchPlayers(tx, matchId);
    const p = playerByUserId(players, userId);
    if (!p) return { error: "Not a participant", status: 403 };

    // Lobby yet to fill — refund the caller's escrowed wager and cancel
    // the lobby (host leaves an unfilled lobby).
    if (match.status === "waiting") {
      if (p.userId === match.hostUserId) {
        await tx
          .update(towerArenaMatches)
          .set({ status: "cancelled", phase: "cancelled", endedAt: new Date() })
          .where(and(eq(towerArenaMatches.id, matchId), eq(towerArenaMatches.status, "waiting")));
        const cancelled = await fetchMatchForUpdate(tx, matchId);
        void relayTowerArenaLobbyUpdate(matchId, { event: "cancelled", wager: match.wager, maxPlayers: match.maxPlayers, playerCount: 0 });
        return { match: cancelled, cancelled: true };
      }
      // A waiting non-host just leaves — drop the seat.
      const others = await fetchPlayers(tx, matchId);
      await tx.delete(towerArenaPlayers).where(eq(towerArenaPlayers.id, p.id));
      // Leaving a ready / counting-down lobby reopens it (and cancels any
      // pending start countdown) — the remaining players can't start short.
      if (match.phase === "ready" || match.phase === "countdown") {
        await tx
          .update(towerArenaMatches)
          .set({ phase: "waiting", turnDeadline: null })
          .where(and(eq(towerArenaMatches.id, matchId), eq(towerArenaMatches.status, "waiting")));
      }
      void relayTowerArenaLobbyUpdate(matchId, { event: "left", wager: match.wager, maxPlayers: match.maxPlayers, playerCount: Math.max(0, others.length - 1) });
      return { match, removed: true };
    }

    // Active match — only real (non-AI) players may resign.
    if (match.phase !== "finished") {
      // Already out (ceiling breach or an earlier resignation): leaving or a
      // disconnect is a no-op — their placement/payout were decided when they
      // were eliminated, and the match continues for the remaining players.
      // (Without this guard, an eliminated spectator dropping off would re-run
      // the resignation math and could end the match prematurely.)
      if (p.status === "eliminated") return { match, alreadyTerminal: true };
      if (p.isAi) return { error: "AI seat cannot resign", status: 403 };
      const activeBefore = players.filter(isActive).length;
      // Resignation placement = the player's CURRENT standing among the
      // active roster (blocks they hold in the tower), NOT always last: a
      // player who resigns while in 2nd place keeps 2nd (and its payout),
      // while someone who never contributed ranks last. Depends on how many
      // players are in the match and where the resigner sits at the time.
      // A resigner can NEVER take 1st place — resigning means you give up the
      // win (2-player: resigning always loses your money, per spec); the best
      // a resigner can hold is the place they currently stand at, capped at
      // 2nd, so the true survivor keeps 1st.
      const placement = Math.max(2, activeStanding(players, match.towerState, userId));
      await tx
        .update(towerArenaPlayers)
        .set({
          status: "eliminated",
          eliminatedAt: new Date(),
          placement,
          reservedBlock: null,
        })
        .where(and(eq(towerArenaPlayers.matchId, matchId), eq(towerArenaPlayers.userId, userId)));

      towerArenaEliminated({
        distinctId: userId,
        matchId,
        placement,
        reason,
        maxPlayers: match.maxPlayers,
      });
      void broadcastTowerArenaMatchEvent(matchId, TOWER_ARENA_EVENTS.PLAYER_ELIMINATED, {
        playerId: userId,
        placement,
        reason,
      });

      // The resigner's payout is fully determined by their placement — the
      // client shows the win/lose popup immediately from these values.
      const resignCfg =
        !match.isAi && match.wager > 0
          ? computePotPrize({ maxPlayers: match.maxPlayers, wager: match.wager })
          : null;
      const resignPayouts = resignCfg
        ? payoutsByPlacement({
            maxPlayers: match.maxPlayers,
            wager: match.wager,
            prizePool: resignCfg.prizePool,
          })
        : null;
      const payout = resignPayouts ? (resignPayouts[Math.max(0, placement - 1)] ?? 0) : 0;
      const net = payout - match.wager;
      const isWinner = match.isAi
        ? placement <= paidPlacementsFor(match.maxPlayers)
        : payout > match.wager;

      const reserve = reserveMap(match);
      if (reserve[userId]) reserve[userId] = null;

      const activeAfter = activeBefore - 1;
      if (activeAfter <= 1) {
        const freshMatch = await fetchMatchForUpdate(tx, matchId);
        const freshPlayers = await fetchPlayers(tx, matchId);
        await finishMatchTx(tx, freshMatch, freshPlayers);
        return {
          match: await fetchMatchForUpdate(tx, matchId),
          resigned: true,
          matchFinished: true,
          placement,
          payout,
          net,
          isWinner,
        };
      }

      // Refill the pool and continue directly with the next placement turn.
      const cycleAfter = Number(match.resourceCycle || 0) + 1;
      const { pool } = newCycleState(match, cycleAfter);
      const nextTurnId = nextActiveAfter(players, userId) || players.find(isActive)?.userId || null;
      // The next holder's window depends on who holds it (bot think beat vs
      // full human window) — keeps the planned-placement ghost visible.
      // Untimed vs-AI matches stamp no deadline for a human holder.
      const nextHolder = players.find((p) => p.userId === nextTurnId);
      const nextWin = nextHolder?.isAi ? BOT_THINK_MS : placementWindowMs(match);
      const nextDeadline = nextTurnId
        ? nextHolder?.isAi || !match.isAi
          ? new Date(Date.now() + nextWin)
          : null
        : null;
      await tx
        .update(towerArenaMatches)
        .set({
          phase: "placement",
          resourceCycle: cycleAfter,
          resourcePool: pool,
          reserveState: reserve,
          currentTurnPlayerId: nextTurnId,
          turnDeadline: nextDeadline,
        })
        .where(eq(towerArenaMatches.id, matchId));
      void broadcastTowerArenaMatchEvent(matchId, TOWER_ARENA_EVENTS.RESOURCE_REFILL, {
        resourceCycle: cycleAfter,
      });
      void broadcastTowerArenaMatchEvent(matchId, TOWER_ARENA_EVENTS.RESOURCE_UPDATE, {
        resourceCycle: cycleAfter,
      });
      void broadcastTowerArenaMatchEvent(matchId, TOWER_ARENA_EVENTS.TURN_STARTED, {
        playerId: nextTurnId,
      });
      await tx.insert(towerArenaTurns).values({
        matchId,
        userId,
        seat: p.seat,
        turnNumber: match.turnNumber,
        resourceCycle: cycleAfter,
        phase: "placement",
        actionType: "RESIGN",
      });
      return {
        match: await fetchMatchForUpdate(tx, matchId),
        resigned: true,
        placement,
        payout,
        net,
        isWinner,
      };
    }

    return { match, alreadyTerminal: true };
  });
}

// ── Poll-driven auto-advance (deterministic timeout) ──

/**
 * Advances a match when its placement window has expired. The current player
 * gets a deterministic safe
 *     fallback placement (never an instant elimination) — if that safe
 *     move still collapses (precarious tower) the result is authoritative.
 * Safe, pure policy: smallest available block ('short' > 'square'), placed
 * centered with no rotation. Runs inside a transaction; a raced second poll
 * is a no-op because the conditional update on phase/deadline rejects it.
 */
export async function advanceMatchOnPoll(matchId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    const now = Date.now();

    // Pre-game (status still "waiting"): ready gate + 10s start countdown.
    if (match.status === "waiting") {
      if (match.phase === "countdown") {
        const players = await fetchPlayers(tx, matchId);
        // Someone unreadied / left mid-countdown → abort the start.
        if (!isReadyGateMet(players)) {
          await tx
            .update(towerArenaMatches)
            .set({ phase: "ready", turnDeadline: null })
            .where(
              and(
                eq(towerArenaMatches.id, match.id),
                eq(towerArenaMatches.status, "waiting"),
                eq(towerArenaMatches.phase, "countdown"),
              ),
            );
          void relayTowerArenaLobbyUpdate(match.id, {
            event: "countdown-cancelled",
            wager: match.wager,
            maxPlayers: match.maxPlayers,
            playerCount: players.length,
            phase: "ready",
          });
          return { match: await fetchMatchForUpdate(tx, matchId), countdownCancelled: true };
        }
        if (match.turnDeadline && new Date(match.turnDeadline).getTime() > now) return { match };
        // Countdown finished → the match really starts (reserve phase + pool).
        const started = await startMatchTx(tx, match.id, { finalMaxPlayers: match.maxPlayers });
        return { match: started, started: true };
      }
      if (match.phase === "ready") {
        // Defensive: the ready toggle usually opens the countdown, but if a
        // race or a lost relay left a full+all-ready lobby stuck in "ready",
        // start the countdown here so the game can never deadlock.
        const players = await fetchPlayers(tx, matchId);
        if (isReadyGateMet(players) && players.length >= match.maxPlayers) {
          await tx
            .update(towerArenaMatches)
            .set({ phase: "countdown", turnDeadline: new Date(Date.now() + READY_COUNTDOWN_MS) })
            .where(
              and(
                eq(towerArenaMatches.id, match.id),
                eq(towerArenaMatches.status, "waiting"),
                eq(towerArenaMatches.phase, "ready"),
              ),
            );
          void relayTowerArenaLobbyUpdate(match.id, {
            event: "countdown",
            wager: match.wager,
            maxPlayers: match.maxPlayers,
            playerCount: players.length,
            phase: "countdown",
          });
          return { match: await fetchMatchForUpdate(tx, matchId), countdownStarted: true };
        }
      }
      return { match };
    }

    if (!ACTIVE_MATCH_STATES.has(match.status)) return { match };

    // Free-play pause: the turn engine is frozen — no phase transitions, no
    // timeouts, no bot moves — until the human resumes.
    if (matchIsPaused(match)) return { match, paused: true };

    if (match.phase === "placement") {
      const players = await fetchPlayers(tx, matchId);
      const cur = playerByUserId(players, match.currentTurnPlayerId);
      if (!cur) {
        const [updated] = await tx
          .update(towerArenaMatches)
          .set({ phase: "placement", turnDeadline: null, currentTurnPlayerId: null })
          .where(and(eq(towerArenaMatches.id, match.id), eq(towerArenaMatches.status, "active")))
          .returning();
        return { match: updated || match };
      }

      const deadlineMs = match.turnDeadline ? new Date(match.turnDeadline).getTime() : 0;
      const botTurn = Boolean(cur.isAi);
      // Bots place on a SHORT think window (BOT_THINK_MS) instead of
      // immediately, so every viewer sees the bot's planned-placement ghost
      // before the block pops into the tower. The client fires /ai-turn once
      // the window passes; this poll is the authoritative backstop. Humans
      // still get their full window and are only resolved by the timeout
      // fallback once it expires. (A bot with no deadline at all — defensive
      // — acts immediately rather than stalling.)
      const expired = (deadlineMs > 0 && deadlineMs <= now) || (botTurn && deadlineMs <= 0);
      if (!expired) return { match };
      // Free vs-AI matches: the human's turn never expires — no TIMEOUT
      // fallback and no forced placement. Bots still play on their short
      // think window (botTurn is true above).
      if (!botTurn && Boolean(match.isAi)) return { match };

      // Guarded conditional UPDATE only for the state we saw — a raced
      // double-poll leaves phase 'placement' from the first poll and the
      // second (matched 0 rows) becomes a no-op inside applyPlacement's
      // own gate, which re-reads the row and refuses a stale turn.
      const fallback = safeFallbackPlacement(match);
      const [stillActive] = await tx
        .update(towerArenaMatches)
        .set({ phase: "placement", turnDeadline: new Date(Date.now() + placementWindowMs(match)) })
        .where(
          and(
            eq(towerArenaMatches.id, match.id),
            eq(towerArenaMatches.status, "active"),
            eq(towerArenaMatches.phase, "placement"),
            eq(towerArenaMatches.currentTurnPlayerId, match.currentTurnPlayerId),
          ),
        )
        .returning();
      if (!stillActive) return { match: await fetchMatchForUpdate(tx, matchId), raced: true };

      const result = await applyPlacement(tx, match, players, cur, {
        ...fallback,
        actionType: botTurn ? "AI" : "TIMEOUT",
      });
      if (result.error) return { match: await fetchMatchForUpdate(tx, matchId), error: result.error };
      return {
        match: await fetchMatchForUpdate(tx, matchId),
        timedOut: !botTurn,
        botPlayed: botTurn,
        ...result,
      };
    }

    return { match };
  });
}

/**
 * Deterministic safe fallback: smallest shape, centered, no rotation.
 * Delegates to the pure resolver so timeout and AI intents share one policy.
 */
export function safeFallbackPlacement(match: any): { shape: BlockShape; positionX: number; rotation: number } {
  const tier = coerceAiDifficulty(match?.aiDifficulty);
  if (tier === "easy") {
    // A deliberately careless bot: a random available shape dropped at a
    // random in-bounds column, instead of the safe drop the other tiers play.
    const snapshot = matchSnapshot(match);
    const pool = parsePool(snapshot.resourcePool);
    const available: BlockShape[] = [];
    for (const piece of pool) {
      if (!available.includes(piece.shape)) available.push(piece.shape);
    }
    const shape =
      available.length > 0
        ? available[Math.floor(Math.random() * available.length)]
        : "short";
    const candidates: number[] = [];
    for (let x = 0; x <= 500; x += 5) {
      if (dropInBounds(shape, 0, x)) candidates.push(x);
    }
    const positionX =
      candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : 250;
    return { shape, positionX, rotation: 0 };
  }
  // `normal` and `hard` play the same safe drop: the placement-only stacker
  // has no stronger legal move to reach for.
  const intent = safeFallbackIntent(matchSnapshot(match));
  return { shape: intent.shape, positionX: intent.positionX, rotation: intent.rotation };
}

// ── Listing ────────────────────────────────────────────────────────────

/**
 * Player display lookup keyed by clerkId — name + official icon key.
 * Used by the lobby + match projections so only server-resolved names /
 * icons reach the client (never user-supplied avatar URLs).
 */async function userDisplayMap(
  tx: any,
  clerkIds: string[],
): Promise<
  Map<
    string,
    {
      name: string;
      iconKey: string;
      prestigeBadge: string | null;
      profileFrame: unknown;
    }
  >
> {
  const ids = [...new Set(clerkIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      clerkId: users.clerkId,
      name: users.name,
      selectedIcon: users.selectedIcon,
      equippedCosmetics: users.equippedCosmetics,
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      showPrestigeBadge: users.showPrestigeBadge,
    })
    .from(users)
    .where(inArray(users.clerkId, ids));
  const decorations = await getFrameDecorations(
    rows.map((row: any) => row.equippedCosmetics),
  );
  const decorationByClerkId = new Map(
    rows.map((row: any, index: number) => [row.clerkId, decorations[index]]),
  );
  const map = new Map<
    string,
    {
      name: string;
      iconKey: string;
      prestigeBadge: string | null;
      profileFrame: unknown;
    }
  >();
  for (const row of rows) {
    map.set(row.clerkId, {
      name: row.name || "Player",
      iconKey: row.selectedIcon || DEFAULT_ICON_KEY,
      profileFrame: decorationByClerkId.get(row.clerkId) || null,
      // Prestige is derived from ratings + per-game trophies, which are not
      // loaded here — an opted-in player with no capped game resolves to no
      // badge.
      prestigeBadge: resolvePrestigeBadge({
        showPrestigeBadge: row.showPrestigeBadge,
      }),
    });
  }
  return map;
}

async function enrichMatchPlayers(tx: any, players: any[]) {
  const display = await userDisplayMap(
    tx,
    players.filter((p) => !p.isAi).map((p) => p.userId),
  );
  return players.map((p) => {
    const d = p.isAi ? null : display.get(p.userId);
    return {
      userId: p.userId,
      seat: p.seat,
      status: p.status,
      placement: p.placement,
      isAi: p.isAi,
      ready: Boolean(p.ready),
      joinedAt: p.joinedAt,
      eliminatedAt: p.eliminatedAt,      name: p.isAi ? `Bot ${p.seat}` : (d?.name ?? "Player"),
      iconKey: p.isAi ? DEFAULT_ICON_KEY : (d?.iconKey ?? DEFAULT_ICON_KEY),
      profileFrame: p.isAi ? null : (d?.profileFrame ?? null),
      prestigeBadge: p.isAi ? null : (d?.prestigeBadge ?? null),
    };
  });
}


/**
 * Open waiting lobbies for the public lobby grid. Each entry carries the
 * live seat count, host display info, and an estimated prize pool — all
 * computed server-side. `excludeUserId` hides a lobby the caller already
 * holds so the client's "your open lobby" banner doesn't double-list it.
 */
export async function listOpenTowerArenaMatches({
  limit = 30,
  excludeUserId,
}: { limit?: number; excludeUserId?: string } = {}) {
  const lobbyIds = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: towerArenaMatches.id })
      .from(towerArenaMatches)
      .where(and(eq(towerArenaMatches.status, "waiting"), eq(towerArenaMatches.isAi, false)))
      .orderBy(desc(towerArenaMatches.createdAt))
      .limit(Math.max(1, Math.min(limit, 200)))
      .for("update");
    return rows.map((r) => r.id);
  });
  if (lobbyIds.length === 0) return [];

  // Re-derive seat counts + owner display outside the locked txn.
  const [matches, playerRows, userRows] = await Promise.all([
    db
      .select()
      .from(towerArenaMatches)
      .where(inArray(towerArenaMatches.id, lobbyIds)),
    db
      .select({ matchId: towerArenaPlayers.matchId, userId: towerArenaPlayers.userId, isAi: towerArenaPlayers.isAi })
      .from(towerArenaPlayers)
      .where(inArray(towerArenaPlayers.matchId, lobbyIds)),
    db
      .select({
        clerkId: users.clerkId,
        name: users.name,
        selectedIcon: users.selectedIcon,
        equippedCosmetics: users.equippedCosmetics,
      })
      .from(users)
      .where(
        inArray(
          users.clerkId,
          lobbyIds.length
            ? db
                .select({ clerkId: towerArenaMatches.hostUserId })
                .from(towerArenaMatches)
                .where(inArray(towerArenaMatches.id, lobbyIds))
            : [],
        ),
      ),
  ]);

  const countByMatch = new Map<string, number>();
  for (const p of playerRows) {
    countByMatch.set(p.matchId, (countByMatch.get(p.matchId) ?? 0) + 1);
  }
  const hostDecorations = await getFrameDecorations(
    userRows.map((u) => u.equippedCosmetics),
  );
  const hostDecorationByClerkId = new Map(
    userRows.map((u, index) => [u.clerkId, hostDecorations[index]]),
  );
  const hostDisplay = new Map(userRows.map((u) => [u.clerkId, u]));
  const excludeMyOpenLobby = excludeUserId
    ? await (async () => {
        const mine = await db
          .select({ matchId: towerArenaPlayers.matchId })
          .from(towerArenaPlayers)
          .where(eq(towerArenaPlayers.userId, excludeUserId))
          .limit(50);
        return new Set(mine.map((m) => m.matchId));
      })()
    : null;

  return matches
    .filter((m) => !excludeMyOpenLobby || !excludeMyOpenLobby.has(m.id))
    // A full lobby sitting in the ready gate / start countdown has no open
    // seats, so it must not appear as a joinable row in the public grid.
    .filter((m) => (countByMatch.get(m.id) ?? 0) < m.maxPlayers)
    .map((m) => {
      const cfg = computePotPrize({ maxPlayers: m.maxPlayers, wager: m.wager });
      const host = hostDisplay.get(m.hostUserId);
      return {
        id: m.id,
        hostUserId: m.hostUserId,
        hostName: host?.name ?? "Player",
        hostIconKey: host?.selectedIcon ?? DEFAULT_ICON_KEY,
        hostProfileFrame: host?.clerkId
          ? hostDecorationByClerkId.get(host.clerkId) || null
          : null,
        wager: m.wager,
        maxPlayers: m.maxPlayers,
        playerCount: countByMatch.get(m.id) ?? 0,
        status: m.status,
        // Estimated prize pool (server-computed from centralized payout config).
        pot: cfg.pot,
        houseFee: cfg.houseFee,
        prizePool: cfg.prizePool,
        createdAt: m.createdAt,
      };
    });
}

/**
 * Project a single match + its players for a participant, with server-
 * resolved display names + icons and the viewer's private reserve. Used by
 * `/api/tower-arena/get-match` (lobby wait-room + live match share the same
 * projection).
 */
export async function getTowerArenaMatchProjection({ userId, matchId }: { userId: string; matchId: string }) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const match = await db
    .select()
    .from(towerArenaMatches)
    .where(eq(towerArenaMatches.id, matchId))
    .limit(1);
  if (match.length === 0) return { error: "Match unavailable", status: 404 };
  const [m] = match;

  const playerRows = await db
    .select()
    .from(towerArenaPlayers)
    .where(eq(towerArenaPlayers.matchId, m.id))
    .orderBy(asc(towerArenaPlayers.seat));

  const isParticipant = playerRows.some((p) => p.userId === userId);
  if (!isParticipant) return { error: "Not a participant", status: 403 };

  const display = await db.transaction((tx) => enrichMatchPlayers(tx, playerRows));
  const reserveState =
    m.reserveState && typeof m.reserveState === "object" && !Array.isArray(m.reserveState)
      ? m.reserveState
      : {};
  const me = playerRows.find((p) => p.userId === userId);
  const paused = Boolean(
    m.reserveState && typeof m.reserveState === "object" && (m.reserveState as any)[PAUSE_KEY]?.paused,
  );
  return {
    match: {
      id: m.id,
      status: m.status,
      phase: m.phase,
      wager: m.wager,
      maxPlayers: m.maxPlayers,
      isAi: m.isAi,
      paused,
      hostUserId: m.hostUserId,
      resourceCycle: m.resourceCycle,
      turnNumber: m.turnNumber,
      currentTurnPlayerId: m.currentTurnPlayerId,
      turnDeadline: m.turnDeadline,
      resourcePool: m.resourcePool,
      towerState: m.towerState,
      placements: m.placements,
      finalRankings: m.finalRankings,
      winnerId: m.winnerId,
      prizePool: m.prizePool,
      houseFee: m.houseFee,
      pot: m.pot,
      createdAt: m.createdAt,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
    },
    players: display,
    me: {
      userId,
      seat: me?.seat ?? null,
      isHost: m.hostUserId === userId,
      isAi: Boolean(me?.isAi),
      ready: Boolean(me?.ready),
      status: me?.status ?? "active",
      reserveUsesRemaining: me?.reserveUsesRemaining ?? 0,
      reservedBlock: reserveState[userId] || null,
      // Placement + payout already decided for this seat (null while the
      // seat is still in the running). Drives the eliminated player's
      // losing popup in a 3+ seat match, where the match plays on without
      // them.
      standing: decidedStanding(m, me),
    },
  };
}

// ── History ────────────────────────────────────────────────────────────
export async function listTowerArenaHistory({ userId, limit = 30 }: { userId: string; limit?: number }) {
  if (!userId) return { error: "Unauthorized", status: 401 };
  // Any match the user is a player in, most recently created first, then
  // de-duplicated by match id (a user has exactly one seat per match).
  const rows = await db
    .select({
      id: towerArenaMatches.id,
      wager: towerArenaMatches.wager,
      maxPlayers: towerArenaMatches.maxPlayers,
      winnerId: towerArenaMatches.winnerId,
      prizePool: towerArenaMatches.prizePool,
      finalRankings: towerArenaMatches.finalRankings,
      status: towerArenaMatches.status,
      endedAt: towerArenaMatches.endedAt,
      createdAt: towerArenaMatches.createdAt,
    })
    .from(towerArenaMatches)
    .innerJoin(towerArenaPlayers, eq(towerArenaPlayers.matchId, towerArenaMatches.id))
    .where(eq(towerArenaPlayers.userId, userId))
    .orderBy(desc(towerArenaMatches.createdAt))
    .limit(limit);

  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return r.status === "finished";
  });
}