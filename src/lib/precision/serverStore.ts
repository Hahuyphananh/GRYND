// ── Server-side state for the Precision reaction-stop duel ───────────────
//
// Postgres-backed. This module used to be a pair of `globalThis` Maps with
// `setTimeout`s driving the round countdown and the bot's stop. That is not a
// store on a serverless deploy: each instance had its own copy (so a match
// created by one request was invisible to the next poll — the player landed on
// a match page with nothing on it), the timers died with the instance (so a
// round could sit at "0" forever), and nothing was ever reclaimed.
//
// What replaced it:
//   * `precision_lobbies` — the PvP queue (id doubles as the match id).
//   * `precision_matches` — the match state as a jsonb snapshot plus the few
//     columns worth indexing (phase, wager, timestamps) and the SERVER-ONLY
//     values a client must never see (rolled target, bot stop instant, pending
//     stops, anomaly ledger).
//   * NO timers. The arming countdown and the bot's stop are stored as
//     absolute instants; `applyDueTransitions` performs the transition they
//     would have performed, on the next read, wherever that read lands.
//
// The game RULES live in `./engine` (pure, DB-free, unit-tested). This file
// owns persistence, locking, the security guards (replay envelope, duplicate
// stops, server-stamped timing) and the sweeps.
//
// Concurrency: every mutation runs inside `db.transaction` and takes the match
// row `FOR UPDATE`, which is what makes "both seats stopped" and the
// single-stop-per-seat rule atomic across instances.

import { and, asc, eq, lt, ne } from "drizzle-orm";
import { db } from "../../db/client";
import { precisionLobbies, precisionMatches } from "../../db/schema";
import {
  foldPersistedSample,
  logAnomalyEvents,
  readPersistedLedger,
  summarizePersistedLedger,
} from "./anomalyDetection";
import type { PrecisionAnomalyPersistedLedger } from "./anomalyDetection";
import {
  mirrorPrecisionQueued,
  mirrorPrecisionTransition,
} from "./canonicalLifecycle";
import {
  applyRoundResult,
  armRoundState,
  computeStopTelemetry,
  evaluateRound,
  finishMatchState,
  generateRoundNonce,
  isArmedRoundDue,
  isStopElapsedInRange,
  makeInitialMatch,
  revealArmedRoundState,
  rollRandomTarget,
} from "./engine";
import type { PrecisionStopTelemetry } from "./engine";
import {
  LOBBY_TTL_MS,
  MATCH_ABANDONED_TTL_MS,
  MATCH_FINISHED_TTL_MS,
  MAX_STOP_MS,
  MIN_STOP_MS,
} from "./constants";
import type {
  PlayerSeat,
  PrecisionLobby,
  PrecisionPlayer,
  PrecisionState,
} from "./types";

export const PRECISION_AI_USER_ID = "AI_BOT";

/** True for a free practice match against the server-controlled bot. */
export function isPrecisionAiMatch(
  match: PrecisionState | null | undefined,
): boolean {
  return (
    Boolean(match?.isAiGame) &&
    Boolean(match?.players?.some((p) => p.seat === 2 && p.userId === PRECISION_AI_USER_ID))
  );
}

/** How long the bot "thinks" after the round opens, on top of the target.
 *  Spread of 80–320ms keeps its misses human-looking; the STOP itself is
 *  still stamped and graded server-side. */
function rollBotReactionError(random: () => number = Math.random): number {
  return 80 + Math.floor(random() * 241);
}

// ── Row shapes ───────────────────────────────────────────────────────────

/** A persisted lobby, in the public `PrecisionLobby` shape the client
 *  already consumes (`createdAt` normalised to epoch ms). */
export interface PrecisionLobbyRow {
  id: string;
  hostUserId: string;
  hostName: string;
  opponentUserId: string | null;
  opponentName: string | null;
  wager: number;
  gameMode: "pvp";
  status: "waiting" | "active";
  createdAt: number;
}

export interface PrecisionMatchRow {
  id: string;
  wager: number;
  isAiGame: boolean;
  phase: PrecisionState["phase"];
  /** Public snapshot — exactly what the client is allowed to see. */
  state: PrecisionState;
  /** SERVER-ONLY per-seat telemetry for the round in flight. */
  pendingStops: Record<string, PrecisionStopTelemetry>;
  /** SERVER-ONLY audit ledger (never leaves the server). */
  anomalyLedger: PrecisionAnomalyPersistedLedger;
  /** SERVER-ONLY rolled target while the round is still arming. */
  serverTargetMs: number | null;
  /** SERVER-ONLY instant the bot stops at (epoch ms). */
  aiStopAt: number | null;
  payoutProcessedAt: number | null;
  /** Terminal timestamp (house column, also the retention purge column). */
  endedAt: number | null;
  touchedAt: number;
}

/**
 * The canonical house columns (`pool_matches` / `tower_arena_matches`
 * shape) are DERIVED from the seats on every write, so the shared reporting
 * surfaces never have to understand Precision's jsonb snapshot:
 *
 *   status    `active` while the match is live (a row only exists once both
 *             seats are known), then `finished` when a winner was declared
 *             or `cancelled` when it ended without one (resign / teardown).
 *   winner_id the Clerk id of the winning seat, null when nobody won.
 */
function reportingColumns(state: PrecisionState): {
  player1Id: string;
  player2Id: string | null;
  winnerId: string | null;
  status: "active" | "finished" | "cancelled";
} {
  const seat1 = state.players.find((p) => p.seat === 1);
  const seat2 = state.players.find((p) => p.seat === 2);
  const winner =
    state.winnerSeat === null
      ? null
      : state.players.find((p) => p.seat === state.winnerSeat);
  const status =
    state.phase === "finished" ? (winner ? "finished" : "cancelled") : "active";
  return {
    player1Id: seat1?.userId ?? "",
    player2Id: seat2?.userId ?? null,
    winnerId: winner?.userId ?? null,
    status,
  };
}

/** Rows come back from Postgres with `varchar` columns widened to `string`
 *  and timestamps as `Date`; normalise both here so every consumer works
 *  with the same shape the routes hand the client. */
export function mapLobbyRow(row: Record<string, unknown>): PrecisionLobbyRow {
  const status = row.status === "active" ? "active" : "waiting";
  return {
    id: String(row.id),
    hostUserId: String(row.hostUserId ?? ""),
    hostName: String(row.hostName ?? "Player 1"),
    opponentUserId: row.opponentUserId ? String(row.opponentUserId) : null,
    opponentName: row.opponentName ? String(row.opponentName) : null,
    wager: Number(row.wager ?? 0),
    gameMode: "pvp",
    status,
    createdAt: toEpoch(row.createdAt) ?? Date.now(),
  };
}

/** A lobby row as the client-facing type. */
export function toClientLobby(row: PrecisionLobbyRow): PrecisionLobby {
  return {
    id: row.id,
    hostUserId: row.hostUserId,
    hostName: row.hostName,
    opponentUserId: row.opponentUserId,
    opponentName: row.opponentName,
    wager: row.wager,
    gameMode: "pvp",
    status: row.status,
    createdAt: row.createdAt,
  };
}

function toEpoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Defensive normalisation of the jsonb snapshot. A row whose state was
 *  written by an older/partial code path must degrade to "match not found"
 *  rather than crash a client render. */
function readState(raw: unknown): PrecisionState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as PrecisionState;
  if (typeof state.matchId !== "string" || typeof state.phase !== "string") {
    return null;
  }
  if (!Array.isArray(state.players)) return null;
  return state;
}

function mapMatchRow(row: Record<string, unknown>): PrecisionMatchRow | null {
  const state = readState(row.state);
  if (!state) return null;
  return {
    id: String(row.id),
    wager: Number(row.wager ?? 0),
    isAiGame: Boolean(row.isAiGame),
    phase: state.phase,
    state,
    pendingStops: (row.pendingStops ?? {}) as Record<string, PrecisionStopTelemetry>,
    anomalyLedger: readPersistedLedger(row.anomalyLedger),
    serverTargetMs:
      row.serverTargetMs === null || row.serverTargetMs === undefined
        ? null
        : Number(row.serverTargetMs),
    aiStopAt: toEpoch(row.aiStopAt),
    payoutProcessedAt: toEpoch(row.payoutProcessedAt),
    endedAt: toEpoch(row.endedAt),
    touchedAt: toEpoch(row.touchedAt) ?? Date.now(),
  };
}

const MATCH_COLUMNS = {
  id: precisionMatches.id,
  wager: precisionMatches.wager,
  isAiGame: precisionMatches.isAiGame,
  state: precisionMatches.state,
  pendingStops: precisionMatches.pendingStops,
  anomalyLedger: precisionMatches.anomalyLedger,
  serverTargetMs: precisionMatches.serverTargetMs,
  aiStopAt: precisionMatches.aiStopAt,
  payoutProcessedAt: precisionMatches.payoutProcessedAt,
  endedAt: precisionMatches.endedAt,
  touchedAt: precisionMatches.touchedAt,
};

export const LOBBY_COLUMNS = {
  id: precisionLobbies.id,
  hostUserId: precisionLobbies.hostUserId,
  hostName: precisionLobbies.hostName,
  opponentUserId: precisionLobbies.opponentUserId,
  opponentName: precisionLobbies.opponentName,
  wager: precisionLobbies.wager,
  gameMode: precisionLobbies.gameMode,
  status: precisionLobbies.status,
  createdAt: precisionLobbies.createdAt,
};

/** The internal shape written back after a transition: everything that can
 *  change during a round. */
interface MatchWrite {
  state: PrecisionState;
  pendingStops: Record<string, PrecisionStopTelemetry>;
  anomalyLedger: PrecisionAnomalyPersistedLedger;
  serverTargetMs: number | null;
  aiStopAt: Date | null;
  endedAt: Date | null;
  payoutProcessedAt?: Date | null;
  touchedAt: Date;
}

// `tx: any` matches the convention used by the other DB-backed stores
// (`tower-arena/serverStore.ts`), whose tx-accepting helpers are typed the
// same way so they can be called with either `db` or a transaction handle.
async function persistMatch(
  dbOrTx: any,
  matchId: string,
  write: MatchWrite,
): Promise<void> {
  await dbOrTx
    .update(precisionMatches)
    .set({
      ...reportingColumns(write.state),
      phase: write.state.phase,
      state: write.state,
      pendingStops: write.pendingStops,
      anomalyLedger: write.anomalyLedger,
      serverTargetMs: write.serverTargetMs,
      aiStopAt: write.aiStopAt,
      endedAt: write.endedAt,
      touchedAt: write.touchedAt,
      ...(write.payoutProcessedAt !== undefined
        ? { payoutProcessedAt: write.payoutProcessedAt }
        : {}),
    })
    .where(eq(precisionMatches.id, matchId));
}

/** Rebuild the mutable write view from a loaded row. */
function toWrite(row: PrecisionMatchRow, now: number): MatchWrite {
  return {
    state: row.state,
    pendingStops: { ...row.pendingStops },
    anomalyLedger: row.anomalyLedger,
    serverTargetMs: row.serverTargetMs,
    aiStopAt: row.aiStopAt === null ? null : new Date(row.aiStopAt),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt),
    touchedAt: new Date(now),
  };
}

// ── Arm + reveal ─────────────────────────────────────────────────────────

/** Arm a round in the write view: stamp the countdown, roll the round's
 *  target into the SERVER-ONLY slot, and reset the per-round state. */
function armRound(write: MatchWrite, now: number): void {
  armRoundState(write.state, generateRoundNonce(), now);
  write.serverTargetMs = rollRandomTarget();
  write.aiStopAt = null;
  write.pendingStops = {};
}

// ── Due transitions (the timers, expressed as instants) ──────────────────

/**
 * Perform every transition a timer used to own, based on the stored
 * instants. Pure with respect to the DB — mutates `write` and reports
 * whether anything changed so the caller can persist (or not).
 *
 *   1. `arming` whose `countdownEndsAt` has passed → reveal the round
 *      (publish the rolled target, stamp `roundGoInstant`). This is what
 *      guarantees a round can never be stranded by a dead timer: any reader
 *      completes it — see the "self-healing" note in the old implementation,
 *      which this generalises.
 *   2. An AI match whose `aiStopAt` has passed and whose bot has not stopped
 *      this round → record the bot's stop (server-stamped) and, if the human
 *      has already stopped, decide the round. Same reasoning: the bot is an
 *      instant, not a process.
 */
function applyDueTransitions(
  write: MatchWrite,
  now: number,
  options: { isAiGame: boolean },
): boolean {
  let changed = false;

  if (isArmedRoundDue(write.state, now)) {
    const target =
      write.serverTargetMs ?? rollRandomTarget();
    revealArmedRoundState(write.state, target, now);
    write.serverTargetMs = null;
    if (options.isAiGame) {
      // The bot's stop instant is derived from the revealed target plus a
      // human-looking error, exactly like the old `setTimeout` delay.
      write.aiStopAt = new Date(now + Math.max(100, target + rollBotReactionError()));
    }
    changed = true;
  }

  if (
    options.isAiGame &&
    write.state.phase === "active" &&
    write.aiStopAt !== null &&
    write.aiStopAt.getTime() <= now &&
    write.state.roundGoInstant !== null &&
    !Object.prototype.hasOwnProperty.call(write.pendingStops, PRECISION_AI_USER_ID)
  ) {
    const telemetry = computeStopTelemetry(
      write.state.roundGoInstant,
      write.aiStopAt.getTime(),
    );
    write.pendingStops[PRECISION_AI_USER_ID] = telemetry;
    write.aiStopAt = null;
    changed = true;
    // If the human already stopped, the round is now decidable.
    changed = applyRoundResolutionIfReady(write, now) || changed;
  }

  return changed;
}

/** Both seats have a stop for this round → grade it, apply the outcome, and
 *  either finish the match or arm the next round. Returns true when it did
 *  something. */
function applyRoundResolutionIfReady(write: MatchWrite, now: number): boolean {
  const state = write.state;
  if (state.phase !== "active") return false;
  const seat1 = state.players.find((p) => p.seat === 1);
  const seat2 = state.players.find((p) => p.seat === 2);
  if (!seat1 || !seat2) return false;
  const stop1 = write.pendingStops[seat1.userId];
  const stop2 = write.pendingStops[seat2.userId];
  if (!stop1 || !stop2) return false;
  if (state.targetMs === null) return false;

  const result = evaluateRound({
    score: state.score,
    seat1: { userId: seat1.userId, stop: stop1 },
    seat2: { userId: seat2.userId, stop: stop2 },
    targetMs: state.targetMs,
  });
  applyRoundResult(state, result);

  // ── Audit-only anomaly ledger ──
  // Persisted on the row (the store is shared across instances now) and
  // never consulted for gameplay decisions.
  const roundSequence = state.roundSequence ?? 0;
  const samples: Array<{ userId: string; stop: PrecisionStopTelemetry }> = [
    { userId: seat1.userId, stop: result.lastRoundStops.seat1 },
    { userId: seat2.userId, stop: result.lastRoundStops.seat2 },
  ];
  for (const { userId, stop } of samples) {
    if (!userId || userId === PRECISION_AI_USER_ID) continue;
    const folded = foldPersistedSample({
      ledger: write.anomalyLedger,
      userId,
      sample: {
        roundSequence,
        elapsedMs: stop.elapsedMs,
        diffMs: stop.diffMs,
        stopInstant: stop.stopInstant,
      },
    });
    write.anomalyLedger = folded.ledger;
    logAnomalyEvents({ matchId: state.matchId, userId, events: folded.events });
  }

  if (result.matchFinished) {
    finishMatchState(state, result.matchWinnerSeat);
    write.endedAt = new Date(now);
    write.pendingStops = {};
    write.serverTargetMs = null;
    write.aiStopAt = null;
    summarizePersistedLedger(state.matchId, write.anomalyLedger);
    void mirrorPrecisionTransition({
      matchId: state.matchId,
      status: "completed",
      playerCount: state.players.length,
    });
    return true;
  }

  // Round decided (or tied → the SAME currentRound replays with a fresh
  // target and a fresh replay envelope).
  if (result.roundWinnerSeat !== null) {
    state.currentRound += 1;
  }
  armRound(write, now);
  return true;
}

// ── Reads ────────────────────────────────────────────────────────────────

/** Load a match and apply any transition that has come due, persisting the
 *  result. Every read path goes through here, which is what makes the
 *  countdown and the bot independent of any live process. */
export async function readMatch(
  matchId: string,
  options: { persist?: boolean } = {},
): Promise<PrecisionMatchRow | null> {
  if (!matchId) return null;
  const [raw] = await db
    .select(MATCH_COLUMNS)
    .from(precisionMatches)
    .where(eq(precisionMatches.id, matchId))
    .limit(1);
  if (!raw) return null;
  const row = mapMatchRow(raw as Record<string, unknown>);
  if (!row) return null;

  const now = Date.now();
  const write = toWrite(row, now);
  const changed = applyDueTransitions(write, now, { isAiGame: row.isAiGame });
  if (changed && options.persist !== false) {
    await persistMatch(db, matchId, write);
    row.state = write.state;
    row.pendingStops = write.pendingStops;
    row.anomalyLedger = write.anomalyLedger;
    row.serverTargetMs = write.serverTargetMs;
    row.aiStopAt = write.aiStopAt === null ? null : write.aiStopAt.getTime();
    row.endedAt = write.endedAt === null ? null : write.endedAt.getTime();
    row.phase = write.state.phase;
    row.touchedAt = write.touchedAt.getTime();
  }
  return row;
}

/** The public snapshot for a match id (or null when the id holds nothing).
 *  `get-match` hands this straight to the client. */
export async function getMatchState(
  matchId: string,
): Promise<PrecisionState | null> {
  const row = await readMatch(matchId);
  return row?.state ?? null;
}

/** The waiting lobby behind an id, in the client shape (null when the id is
 *  not a waiting lobby). */
export async function getWaitingLobby(
  lobbyId: string,
): Promise<PrecisionLobbyRow | null> {
  if (!lobbyId) return null;
  const [raw] = await db
    .select(LOBBY_COLUMNS)
    .from(precisionLobbies)
    .where(and(eq(precisionLobbies.id, lobbyId), eq(precisionLobbies.status, "waiting")))
    .limit(1);
  if (!raw) return null;
  return mapLobbyRow(raw as Record<string, unknown>);
}

export async function listWaitingLobbies(limit = 50): Promise<PrecisionLobbyRow[]> {
  const rows = await db
    .select(LOBBY_COLUMNS)
    .from(precisionLobbies)
    .where(eq(precisionLobbies.status, "waiting"))
    .orderBy(asc(precisionLobbies.createdAt))
    .limit(limit);
  return rows.map((row) => mapLobbyRow(row as Record<string, unknown>));
}

// ── Queue lifecycle ──────────────────────────────────────────────────────

/** Create the match row behind a pairing. Both seats start un-ready: the
 *  server NEVER starts a round on its own (see `markPlayerReady`).
 *
 *  Accepts an optional transaction handle so a pairing can claim the lobby
 *  and create the match in ONE atomic step — see `tryAutoMatch`. */
export async function createMatchForPairing(
  input: {
    matchId: string;
    wager: number;
    players: PrecisionPlayer[];
    isAiGame?: boolean;
  },
  dbOrTx: any = db,
): Promise<PrecisionState> {
  const state = makeInitialMatch(
    input.matchId,
    input.wager,
    input.players,
    "ready_up",
    1,
    Boolean(input.isAiGame),
  );
  await dbOrTx.insert(precisionMatches).values({
    id: input.matchId,
    ...reportingColumns(state),
    wager: input.wager,
    isAiGame: Boolean(input.isAiGame),
    phase: state.phase,
    state,
    pendingStops: {},
    anomalyLedger: {},
    touchedAt: new Date(),
  });
  mirrorPrecisionQueued({
    matchId: input.matchId,
    mode: input.isAiGame ? "ai" : "pvp",
    playerCount: input.players.length,
  });
  return state;
}

/**
 * Create a free practice (vs AI) match for the caller. The bot seat is ready
 * from the start; the human's Ready click arms the first round through the
 * normal `markPlayerReady` path, so the countdown always starts while the
 * player is looking at the page (never at create time — that was the stale
 * "countdown stuck at 0").
 *
 * The row only ever lives in `precision_matches` (never in
 * `precision_lobbies`), which is what keeps a practice match un-joinable.
 */
export async function createAiMatch(
  userId: string,
  humanName = "You",
): Promise<string> {
  const matchId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const players: PrecisionPlayer[] = [
    { seat: 1, userId, name: humanName, isReady: false, isConnected: true },
    {
      seat: 2,
      userId: PRECISION_AI_USER_ID,
      name: "GRYND AI",
      isReady: true,
      isConnected: true,
    },
  ];
  await createMatchForPairing({ matchId, wager: 0, players, isAiGame: true });
  return matchId;
}

/**
 * Cancel a waiting queue entry. Only the host may cancel, and only while the
 * lobby is STILL waiting — the `status = 'waiting'` predicate lives in the
 * DELETE itself, so a pairing that lands in the same instant can never be
 * cancelled out from under the fresh match.
 */
export async function cancelQueueEntry(
  lobbyId: string,
  hostUserId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(precisionLobbies)
    .where(
      and(
        eq(precisionLobbies.id, lobbyId),
        eq(precisionLobbies.hostUserId, hostUserId),
        eq(precisionLobbies.status, "waiting"),
      ),
    )
    .returning({ id: precisionLobbies.id });
  return deleted.length > 0;
}

/**
 * Join a PUBLIC waiting lobby as seat 2.
 *
 * The claim and the match insert happen in ONE transaction, so an id can
 * never be left `active` without a match behind it (which would strand the
 * joiner on an empty game page). Two players clicking Join at the same
 * instant cannot both win: the claim UPDATE carries `status = 'waiting'` and
 * takes the row lock, so exactly one of them flips it.
 */
export async function joinLobbyById(input: {
  lobbyId: string;
  userId: string;
  userName: string;
}): Promise<{
  /** Set when the pairing succeeded. */
  matchId: string | null;
  error?: string;
  /** HTTP status the route should answer with on failure. */
  status?: number;
}> {
  const { lobbyId, userId, userName } = input;

  // Already a match behind this id → never joinable again (this is also what
  // keeps a free "vs AI" practice match un-joinable: its id only ever has a
  // match row, never a waiting lobby).
  const existing = await db
    .select({ id: precisionMatches.id })
    .from(precisionMatches)
    .where(eq(precisionMatches.id, lobbyId))
    .limit(1);
  if (existing.length > 0) {
    return { matchId: null, error: "This game has already started.", status: 409 };
  }

  return db.transaction(async (tx) => {
    // Atomic claim: whoever flips `waiting → active` owns the pairing.
    const claim = await tx
      .update(precisionLobbies)
      .set({ status: "active", opponentUserId: userId, opponentName: userName })
      .where(
        and(
          eq(precisionLobbies.id, lobbyId),
          eq(precisionLobbies.status, "waiting"),
          ne(precisionLobbies.hostUserId, userId),
        ),
      )
      .returning(LOBBY_COLUMNS);
    const claimed = claim[0]
      ? mapLobbyRow(claim[0] as Record<string, unknown>)
      : null;

    if (!claimed) {
      const [lobbyRaw] = await tx
        .select(LOBBY_COLUMNS)
        .from(precisionLobbies)
        .where(eq(precisionLobbies.id, lobbyId))
        .limit(1);
      if (!lobbyRaw) {
        return { matchId: null, error: "Lobby not found.", status: 404 };
      }
      const lobby = mapLobbyRow(lobbyRaw as Record<string, unknown>);
      if (lobby.hostUserId === userId) {
        return {
          matchId: null,
          error: "You are already waiting in this lobby.",
          status: 409,
        };
      }
      return { matchId: null, error: "Lobby is no longer open.", status: 409 };
    }

    const players: PrecisionPlayer[] = [
      {
        seat: 1,
        userId: claimed.hostUserId,
        name: claimed.hostName || "Player 1",
        isReady: false,
        isConnected: true,
      },
      {
        seat: 2,
        userId,
        name: userName || "Player 2",
        isReady: false,
        isConnected: true,
      },
    ];
    await createMatchForPairing(
      {
        matchId: claimed.id,
        wager: claimed.wager,
        players,
      },
      tx,
    );
    return { matchId: claimed.id };
  });
}

/** Mark one seat ready. When BOTH seats are ready the first round is armed
 *  (fresh 5s countdown + rolled target), all inside one transaction. */
export async function markPlayerReady(
  matchId: string,
  userId: string,
): Promise<{
  match: PrecisionState | null;
  playerReady: boolean;
  bothReady: boolean;
  alreadyAdvanced: boolean;
}> {
  return db.transaction(async (tx) => {
    const [raw] = await tx
      .select(MATCH_COLUMNS)
      .from(precisionMatches)
      .where(eq(precisionMatches.id, matchId))
      .for("update")
      .limit(1);
    if (!raw) {
      return { match: null, playerReady: false, bothReady: false, alreadyAdvanced: false };
    }
    const row = mapMatchRow(raw as Record<string, unknown>);
    if (!row) {
      return { match: null, playerReady: false, bothReady: false, alreadyAdvanced: false };
    }

    const now = Date.now();
    const write = toWrite(row, now);
    applyDueTransitions(write, now, { isAiGame: row.isAiGame });

    if (write.state.phase !== "ready_up") {
      // Already past ready-up (or finished) — report current truth; the client
      // reconciles from the snapshot.
      if (write.state.phase !== row.phase) await persistMatch(tx, matchId, write);
      return {
        match: write.state,
        playerReady: true,
        bothReady: false,
        alreadyAdvanced: true,
      };
    }

    let touched = false;
    for (const p of write.state.players) {
      if (p.userId === userId && !p.isReady) {
        p.isReady = true;
        touched = true;
      }
    }
    const allReady =
      write.state.players.length >= 2 && write.state.players.every((p) => p.isReady);

    if (allReady) {
      // Both seats ready → arm round 1 immediately. The countdown starts NOW,
      // with the players already looking at the page.
      armRound(write, now);
      await persistMatch(tx, matchId, write);
      void mirrorPrecisionTransition({
        matchId,
        status: "started",
        playerCount: write.state.players.length,
      });
      return {
        match: write.state,
        playerReady: true,
        bothReady: true,
        alreadyAdvanced: false,
      };
    }

    if (touched) {
      write.state.version += 1;
      await persistMatch(tx, matchId, write);
    }
    return {
      match: write.state,
      playerReady: touched || write.state.players.some((p) => p.userId === userId && p.isReady),
      bothReady: false,
      alreadyAdvanced: false,
    };
  });
}

// ── Round stops ──────────────────────────────────────────────────────────

export interface RecordRoundStopResult {
  match: PrecisionState | null;
  alreadySubmitted: boolean;
  bothStopped: boolean;
  roundWinnerSeat: PlayerSeat | null;
  matchFinished: boolean;
  validationError: boolean;
  error?: string;
}

function stopResult(
  match: PrecisionState | null,
  overrides: Partial<RecordRoundStopResult> = {},
): RecordRoundStopResult {
  return {
    match,
    alreadySubmitted: false,
    bothStopped: false,
    roundWinnerSeat: null,
    matchFinished: false,
    validationError: false,
    ...overrides,
  };
}

/**
 * Record one seat's STOP for the round in flight, then decide the round if
 * both seats have submitted.
 *
 * Server-authoritative timing: the STOP instant is `Date.now()` at receive
 * time and `elapsedMs = stopInstant - state.roundGoInstant`. A client-supplied
 * millisecond value is never accepted (the route ignores any it is sent).
 *
 * Replay protection (unchanged from the in-memory implementation):
 *   * phase must be `active` and the caller must occupy a seat;
 *   * `roundId` must equal the live one (monotonic per arm — ties re-arm with
 *     a fresh id);
 *   * `nonce` must equal the live server-rolled nonce;
 *   * one stop per seat per round — a duplicate is rejected, NOT refreshed,
 *     so an attacker cannot iterate telemetry until a favourable diff lands.
 */
export async function recordRoundStop(
  matchId: string,
  userId: string,
  roundId: string,
  nonce: string,
): Promise<RecordRoundStopResult> {
  return db.transaction(async (tx) => {
    const [raw] = await tx
      .select(MATCH_COLUMNS)
      .from(precisionMatches)
      .where(eq(precisionMatches.id, matchId))
      .for("update")
      .limit(1);
    if (!raw) return stopResult(null, { error: "Match not found." });
    const row = mapMatchRow(raw as Record<string, unknown>);
    if (!row) return stopResult(null, { error: "Match not found." });

    const requestInstant = Date.now();
    const write = toWrite(row, requestInstant);
    // The bot's stop may already be due (or the round may still be arming
    // because its countdown expired while no client was polling), so apply
    // the due transitions BEFORE validating the human's packet.
    applyDueTransitions(write, requestInstant, { isAiGame: row.isAiGame });

    const state = write.state;

    if (state.phase !== "active") {
      if (write.state.phase !== row.phase) await persistMatch(tx, matchId, write);
      return stopResult(state, {
        matchFinished: state.phase === "finished",
        error:
          state.phase === "finished"
            ? "Match is already finished."
            : `Match is not active (phase=${state.phase}).`,
      });
    }
    if (state.winnerSeat !== null) {
      return stopResult(state, { matchFinished: true, error: "Match is already finished." });
    }
    const caller = state.players.find((p) => p.userId === userId);
    if (!caller) {
      return stopResult(state, { error: "Caller is not a participant in this match." });
    }
    if (state.players.length < 2) {
      return stopResult(state, { error: "Match is incomplete (only one participant)." });
    }
    if (state.roundGoInstant === null) {
      return stopResult(state, { error: "Round is not open yet (no server GO instant)." });
    }
    if (write.pendingStops[userId]) {
      return stopResult(state, {
        alreadySubmitted: true,
        validationError: true,
        error: "A stop packet has already been submitted for this round.",
      });
    }
    if (typeof roundId !== "string" || roundId.length === 0) {
      return stopResult(state, { validationError: true, error: "Missing roundId." });
    }
    if (roundId !== state.roundId) {
      console.warn(
        "[precision] rejecting stop with stale roundId from user",
        userId,
        "matchId",
        matchId,
      );
      return stopResult(state, {
        validationError: true,
        error: "Round ID mismatch. Stop packet from a previous round rejected.",
      });
    }
    if (typeof nonce !== "string" || nonce.length === 0) {
      return stopResult(state, { validationError: true, error: "Missing nonce." });
    }
    if (nonce !== state.roundNonce) {
      console.warn(
        "[precision] rejecting stop with stale nonce from user",
        userId,
        "matchId",
        matchId,
      );
      return stopResult(state, {
        validationError: true,
        error: "Nonce mismatch. Stop packet rejected (possible replay).",
      });
    }
    if (requestInstant < state.roundGoInstant) {
      return stopResult(state, {
        validationError: true,
        error: "Server clock produced a negative elapsed (unlikely).",
      });
    }

    const telemetry = computeStopTelemetry(state.roundGoInstant, requestInstant);
    if (!isStopElapsedInRange(telemetry.elapsedMs)) {
      // Out of bounds — recorded telemetry would be garbage, so the packet is
      // dropped without touching the round.
      return stopResult(state, {
        validationError: true,
        error: `Server-measured elapsedMs (${telemetry.elapsedMs}) is outside [${MIN_STOP_MS}, ${MAX_STOP_MS}].`,
      });
    }

    write.pendingStops[userId] = telemetry;

    // Not both seats in yet — persist the bot's progress (if any) and wait.
    if (!applyRoundResolutionIfReady(write, requestInstant)) {
      await persistMatch(tx, matchId, write);
      return stopResult(state, { bothStopped: false });
    }

    const resolved = write.state;
    await persistMatch(tx, matchId, write);
    return stopResult(resolved, {
      bothStopped: true,
      roundWinnerSeat: resolved.lastRoundWinnerSeat,
      matchFinished: resolved.phase === "finished",
    });
  });
}

// ── Terminal paths ───────────────────────────────────────────────────────

/** Forfeit a match: the opponent is declared the winner exactly like a
 *  natural finish (used by the disconnect grace timer and by an explicit
 *  leave). Idempotent — an already-finished match is a successful no-op so a
 *  retry loop stops. */
export async function forfeitMatch(
  matchId: string,
  loserUserId: string,
): Promise<{ ok: boolean; match?: PrecisionState; reason?: string }> {
  return db.transaction(async (tx) => {
    const [raw] = await tx
      .select(MATCH_COLUMNS)
      .from(precisionMatches)
      .where(eq(precisionMatches.id, matchId))
      .for("update")
      .limit(1);
    if (!raw) return { ok: false, reason: "Match not found" };
    const row = mapMatchRow(raw as Record<string, unknown>);
    if (!row) return { ok: false, reason: "Match not found" };

    const loser = row.state.players.find((p) => p.userId === loserUserId);
    if (!loser) return { ok: false, reason: "Caller is not a participant" };
    if (row.state.phase === "finished") return { ok: true, match: row.state };

    const now = Date.now();
    const write = toWrite(row, now);
    finishMatchState(write.state, loser.seat === 1 ? 2 : 1);
    write.pendingStops = {};
    write.serverTargetMs = null;
    write.aiStopAt = null;
    write.endedAt = new Date(now);
    await persistMatch(tx, matchId, write);
    void mirrorPrecisionTransition({
      matchId,
      status: "completed",
      playerCount: write.state.players.length,
    });
    return { ok: true, match: write.state };
  });
}

/** Resign: the match ends immediately with no declared winner (the resigning
 *  client shows its own loss framing) — same semantics as the previous
 *  implementation, now durable. */
export async function resignMatch(
  matchId: string,
  userId: string,
): Promise<{ ok: boolean; match?: PrecisionState; reason?: string }> {
  return db.transaction(async (tx) => {
    const [raw] = await tx
      .select(MATCH_COLUMNS)
      .from(precisionMatches)
      .where(eq(precisionMatches.id, matchId))
      .for("update")
      .limit(1);
    if (!raw) return { ok: false, reason: "Match not found" };
    const row = mapMatchRow(raw as Record<string, unknown>);
    if (!row) return { ok: false, reason: "Match not found" };
    if (!row.state.players.some((p) => p.userId === userId)) {
      return { ok: false, reason: "Caller is not a participant" };
    }
    const now = Date.now();
    const write = toWrite(row, now);
    write.state.phase = "finished";
    write.state.armingStartedAt = null;
    write.state.countdownEndsAt = null;
    write.state.roundId = null;
    write.state.roundNonce = null;
    write.state.version += 1;
    write.pendingStops = {};
    write.serverTargetMs = null;
    write.aiStopAt = null;
    write.endedAt = new Date(now);
    await persistMatch(tx, matchId, write);
    summarizePersistedLedger(matchId, write.anomalyLedger);
    void mirrorPrecisionTransition({
      matchId,
      status: "cancelled",
      cancelReason: "user_cancelled",
      playerCount: write.state.players.length,
    });
    return { ok: true, match: write.state };
  });
}

/** Tear a match (and its lobby row, if any) out of the database. Idempotent:
 *  `false` means there was nothing left to remove. */
export async function removePrecisionMatch(matchId: string): Promise<boolean> {
  if (!matchId) return false;
  const removed = await db
    .delete(precisionMatches)
    .where(eq(precisionMatches.id, matchId))
    .returning({ id: precisionMatches.id });
  await db.delete(precisionLobbies).where(eq(precisionLobbies.id, matchId));
  return removed.length > 0;
}

/** Stamp the payout guard across instances. Returns true when THIS caller
 *  won the race and may settle the match. */
export async function claimPayout(matchId: string): Promise<{
  claimed: boolean;
  alreadyProcessed: boolean;
  wager: number;
  isAiGame: boolean;
  state: PrecisionState | null;
}> {
  return db.transaction(async (tx) => {
    const [raw] = await tx
      .select(MATCH_COLUMNS)
      .from(precisionMatches)
      .where(eq(precisionMatches.id, matchId))
      .for("update")
      .limit(1);
    if (!raw) {
      return { claimed: false, alreadyProcessed: false, wager: 0, isAiGame: false, state: null };
    }
    const row = mapMatchRow(raw as Record<string, unknown>);
    if (!row) {
      return { claimed: false, alreadyProcessed: false, wager: 0, isAiGame: false, state: null };
    }
    if (row.payoutProcessedAt !== null) {
      return {
        claimed: false,
        alreadyProcessed: true,
        wager: row.wager,
        isAiGame: row.isAiGame,
        state: row.state,
      };
    }
    await tx
      .update(precisionMatches)
      .set({ payoutProcessedAt: new Date() })
      .where(eq(precisionMatches.id, matchId));
    return {
      claimed: true,
      alreadyProcessed: false,
      wager: row.wager,
      isAiGame: row.isAiGame,
      state: row.state,
    };
  });
}

/** Release the payout guard after a failed settlement so a retry can win the
 *  race again (mirrors the old `precisionPaidOutMatches.delete`). */
export async function releasePayoutClaim(matchId: string): Promise<void> {
  await db
    .update(precisionMatches)
    .set({ payoutProcessedAt: null })
    .where(eq(precisionMatches.id, matchId));
}

// ── Sweeps ───────────────────────────────────────────────────────────────

export interface PrecisionSweepReport {
  waitingLobbies: number;
  finishedMatches: number;
  abandonedMatches: number;
  staleLobbies: number;
}

/**
 * Reclaim rows nothing can ever use again:
 *   * `waiting` lobbies older than `LOBBY_TTL_MS` (host closed the tab);
 *   * `finished` matches whose end-replay window has lapsed;
 *   * NON-finished matches with no activity for `MATCH_ABANDONED_TTL_MS` —
 *     a quit mid-match, or a `ready_up` match both seats walked away from.
 *     Without this those rows pinned a dead game forever and the next player
 *     routed onto that id got a match page with nothing on it;
 *   * lobby rows whose match is long gone (kept only for history).
 *
 * Safe to call from any request path; the callers throttle it. Deletes are
 * plain range predicates on indexed columns.
 */
export async function sweepPrecisionGames(
  now: number = Date.now(),
): Promise<PrecisionSweepReport> {
  const [waiting, finished, abandoned, stale] = await Promise.all([
    db
      .delete(precisionLobbies)
      .where(
        and(
          eq(precisionLobbies.status, "waiting"),
          lt(precisionLobbies.createdAt, new Date(now - LOBBY_TTL_MS)),
        ),
      )
      .returning({ id: precisionLobbies.id }),
    db
      .delete(precisionMatches)
      .where(
        and(
          eq(precisionMatches.phase, "finished"),
          lt(precisionMatches.endedAt, new Date(now - MATCH_FINISHED_TTL_MS)),
        ),
      )
      .returning({ id: precisionMatches.id }),
    db
      .delete(precisionMatches)
      .where(
        and(
          ne(precisionMatches.phase, "finished"),
          lt(precisionMatches.touchedAt, new Date(now - MATCH_ABANDONED_TTL_MS)),
        ),
      )
      .returning({ id: precisionMatches.id }),
    db
      .delete(precisionLobbies)
      .where(
        and(
          ne(precisionLobbies.status, "waiting"),
          lt(precisionLobbies.createdAt, new Date(now - MATCH_ABANDONED_TTL_MS)),
        ),
      )
      .returning({ id: precisionLobbies.id }),
  ]);

  return {
    waitingLobbies: waiting.length,
    finishedMatches: finished.length,
    abandonedMatches: abandoned.length,
    staleLobbies: stale.length,
  };
}

/** Opportunistic, throttled sweep. Read paths call this so abandoned rows are
 *  reclaimed even without a cron: an in-process timestamp means each instance
 *  runs it at most once a minute, and the sweep itself is idempotent. */
let lastOpportunisticSweepAt = 0;
const OPPORTUNISTIC_SWEEP_INTERVAL_MS = 60_000;

export async function sweepPrecisionGamesIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastOpportunisticSweepAt < OPPORTUNISTIC_SWEEP_INTERVAL_MS) return;
  lastOpportunisticSweepAt = now;
  try {
    await sweepPrecisionGames(now);
  } catch (err) {
    // Side-effect only — never fail a game read because housekeeping failed.
    console.error("[precision] opportunistic sweep failed:", err);
  }
}


