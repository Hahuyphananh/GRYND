// src/lib/lane-rush/raceStore.ts
//
// The authoritative multiplayer lifecycle for the reworked Lane Rush racing
// game. This module owns everything between a database row and the engine:
//
//   waiting → ready → planning (active) → resolving → planning → … → finished
//                                       ↘ cancelled (waiting only)
//                                       ↘ finished (resignation)
//
// WHY A SEPARATE STORE: the legacy glass-bridge duel in
// `src/lib/lane-rush-duel/serverStore.js` is preserved verbatim so an
// unfinished legacy row can still finish on the old rules (its versions are
// `gameStateVersion = 0`). Every new match is stamped with version 1 and is
// dispatched here. Both games share the same rows, seat model, escrow,
// settlement, socket rooms and history — only the gameplay differs.
//
// RESOLUTION IS TWO COMMITTED STEPS, ON PURPOSE:
//   1. `markResolving` flips active → resolving once both plans are locked (or
//      the 60s server deadline passed);
//   2. `resolveRaceRound` re-locks the row, generates the server-side random
//      rolls, applies the engine's result, scores/resources, and settles the
//      match in ONE transaction.
// A crash between the steps leaves a `resolving` row; the next status read
// resumes it. A concurrent resolver sees the status already consumed and does
// nothing, so points/resources can never be awarded twice.

import crypto from "crypto";

import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { laneRushDuelMatches } from "../../db/schema";
import {
  BOT_USER_ID,
  MATCH_STATUS,
  RESULT,
  isBotMatch,
  seatForUserId,
} from "../lane-rush-duel/constants";
import { settleLaneRushMatch } from "../lane-rush-duel/serverStore";
import { isPracticePaused } from "../practicePause";
import {
  applyAction,
  beginPlanning,
  isPlanningExpired,
  isReadyToResolve,
  lockIn,
  plannedCarCount,
  readState,
  resolveRound,
} from "./engine";
import type { LaneRushAction } from "./engine";
import { planBotTurn } from "./bot";
import {
  LANE_RUSH_STATE_VERSION,
  PLANNING_SECONDS,
  SEATS,
  isRouteId,
  otherSeat,
} from "./rules";
import type { LaneRushCar, LaneRushState, Seat } from "./rules";

// ── Types ────────────────────────────────────────────────────────────

type MatchRow = Record<string, any>;

export interface StoreFailure {
  error: string;
  status: number;
  code: string;
}

export interface RaceMutationResult {
  match?: MatchRow;
  state?: LaneRushState;
  duplicate?: boolean;
  paused?: boolean;
  noop?: boolean;
  expired?: boolean;
  planned?: number;
  locked?: boolean;
  resolved?: boolean;
  finished?: boolean;
  resolvedRound?: number | null;
  winner?: string | null;
  resolution?: RaceResolutionResult;
  error?: string;
  status?: number;
  code?: string;
}

export interface RaceResolutionResult {
  resolved?: boolean;
  finished?: boolean;
  round?: number | null;
  winner?: string | null;
  already?: boolean;
  /** The row after the resolution transaction (status active/finished). */
  match?: MatchRow;
  error?: string;
  status?: number;
  code?: string;
}

interface DecodedState {
  ok: boolean;
  state?: LaneRushState;
  reason?: string;
  error?: string;
}

// ── Tiny helpers ─────────────────────────────────────────────────────

function fail(error: string, status: number, code: string): StoreFailure {
  return { error, status, code };
}

function codeStatus(code?: string): number {
  switch (code) {
    case "locked":
    case "expired":
    case "not-planning":
    case "not-ready":
    case "stale_round":
    case "stale_state":
    case "stale_match":
    case "action_id_conflict":
    case "state_unavailable":
    case "deadline_expired":
      return 409;
    default:
      return 400;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A row belongs to the racing game iff it carries the current state version.
 * Anything else (including the column default 0) is a legacy glass-bridge
 * row and is handled by the old store.
 */
export function isRaceMatch(match: MatchRow | null | undefined): boolean {
  return Number(match?.gameStateVersion) === LANE_RUSH_STATE_VERSION;
}

function decodeState(raw: unknown): DecodedState {
  const result = readState(raw);
  if ("error" in result) return { ok: false, reason: result.reason, error: result.error };
  return { ok: true, state: result.state };
}

function seatOf(match: MatchRow, userId: string): Seat | null {
  return (seatForUserId(match, userId) as Seat | null) ?? null;
}

/** Server-side race randomness: never accepted from a client. */
function serverRolls(count: number): number[] {
  const rolls: number[] = [];
  for (let i = 0; i < count; i += 1) {
    rolls.push(crypto.randomBytes(4).readUInt32BE(0) / 0x100000000);
  }
  return rolls;
}

async function loadMatch(matchId: number): Promise<MatchRow | null> {
  const [row] = await db
    .select()
    .from(laneRushDuelMatches)
    .where(eq(laneRushDuelMatches.id, matchId));
  return row || null;
}

async function fetchForUpdate(tx: any, matchId: number): Promise<MatchRow | null> {
  const [row] = await tx
    .select()
    .from(laneRushDuelMatches)
    .where(eq(laneRushDuelMatches.id, matchId))
    .for("update");
  return row || null;
}

function actionLog(match: MatchRow): any[] {
  return Array.isArray(match.actions) ? match.actions : [];
}

function hasActionId(log: any[], actionId: string): any | null {
  return log.find((entry) => entry && String(entry.actionId ?? "") === actionId) ?? null;
}

/**
 * Keep the engine's absolute deadline aligned with the row's `roundDeadline`
 * column. The existing practice-pause service shifts only that column (and
 * started_at), so a paused vs-bot race would otherwise resume with an already
 * expired JSON deadline. The column is the PERSISTED clock; the engine state
 * is re-synced from it before any deadline decision.
 */
function syncPlanningDeadline(state: LaneRushState, match: MatchRow): LaneRushState {
  if (!state || state.phase !== "planning") return state;
  if (
    match?.status !== MATCH_STATUS.ACTIVE &&
    match?.status !== MATCH_STATUS.RESOLVING
  ) {
    return state;
  }
  if (!match.roundDeadline) return state;
  const at = new Date(match.roundDeadline).getTime();
  if (!Number.isFinite(at)) return state;
  const iso = new Date(at).toISOString();
  if (state.planningDeadline === iso) return state;
  return { ...state, planningDeadline: iso };
}

function lifecycleFor(match: MatchRow, state?: LaneRushState | null): string {
  switch (match.status) {
    case MATCH_STATUS.WAITING:
      return "waiting";
    case MATCH_STATUS.READY:
      return "ready";
    case MATCH_STATUS.RESOLVING:
      return "resolving";
    case MATCH_STATUS.FINISHED:
      return "finished";
    case MATCH_STATUS.CANCELLED:
      return "cancelled";
    case MATCH_STATUS.ACTIVE:
      return state?.phase === "finished" ? "finished" : "planning";
    default:
      return String(match.status || "unknown");
  }
}

// ── Public view ──────────────────────────────────────────────────────

function publicCar(car: LaneRushCar, hideRoute: boolean) {
  return {
    id: car.id,
    owner: car.owner,
    tier: car.tier,
    status: car.status,
    damaged: car.damaged,
    // A deployed route is the opponent's private plan: it stays hidden until
    // the round has been resolved (at which point cars are back in the garage
    // anyway and the result itself carries the route).
    route: hideRoute ? null : car.route,
    upgrades: Array.isArray(car.upgrades) ? car.upgrades : [],
  };
}

/**
 * The ONLY race shape a client receives. It carries everything a reconnect
 * needs — phase, deadline, scores, resources, own cars and plans, public fleet
 * state, lock status and the resolved round history — and withholds the
 * opponent's current route selection and resource counts.
 */
export function raceMatchView(
  match: MatchRow,
  viewerUserId: string,
  decoded?: DecodedState,
): Record<string, any> {
  const state = decoded?.ok
    ? syncPlanningDeadline(decoded.state as LaneRushState, match)
    : null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const seat: Seat = viewerIsPlayer1 ? "player1" : "player2";
  const opponentSeat = otherSeat(seat);
  const mine = state?.seats?.[seat] ?? null;
  const theirs = state?.seats?.[opponentSeat] ?? null;
  const log = actionLog(match);
  const hideRoute = match.status === MATCH_STATUS.ACTIVE || match.status === MATCH_STATUS.RESOLVING;
  const finished = match.status === MATCH_STATUS.FINISHED;
  const results = state?.results ?? [];
  const lastResult = results.length > 0 ? results[results.length - 1] : null;

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount) || 0,
    difficulty: match.difficulty,
    status: match.status,
    lifecycle: lifecycleFor(match, state),
    mode: "race",
    gameStateVersion: LANE_RUSH_STATE_VERSION,
    isPractice: isBotMatch(match),

    // ── The authoritative race state ────────────────────────────────
    stateAvailable: Boolean(state),
    stateError: decoded && !decoded.ok ? decoded.error ?? "State unavailable" : null,
    phase: state?.phase ?? null,
    round: state?.round ?? null,
    planningDeadline: state?.planningDeadline ?? null,
    deadlinePassed: state ? isPlanningExpired(state, Date.now()) : false,
    roundDeadline: state?.planningDeadline ?? null,
    serverNow: new Date().toISOString(),
    roundTimerSeconds: PLANNING_SECONDS,

    viewerIsPlayer1,
    mySeat: seat,
    // The race has no turn: both seats plan simultaneously.
    currentTurnUserId: null,
    isViewerTurn: false,
    isMyTurn: false,
    canAct: Boolean(
      state &&
        state.phase === "planning" &&
        match.status === MATCH_STATUS.ACTIVE &&
        !mine?.locked &&
        !isPlanningExpired(state, Date.now()),
    ),

    locked: Boolean(mine?.locked),
    oppLocked: Boolean(theirs?.locked),
    actionPoints: mine?.actionPoints ?? 0,
    myActionPoints: mine?.actionPoints ?? 0,
    myPoints: mine?.points ?? 0,
    oppPoints: theirs?.points ?? 0,
    myResources: mine
      ? { scrap: mine.scrap, fuel: mine.fuel, tech: mine.tech }
      : null,
    myCars: mine?.cars ?? [],
    // The opponent's fleet is public; its route selection and economy are not.
    oppCars: (theirs?.cars ?? []).map((car) => publicCar(car, hideRoute)),

    // Own planning log only (never the opponent's private action history).
    myActions: log.filter((entry) => entry && entry.seat === seat),
    results,
    lastResult,
    raceWinner: state?.winner ?? null,

    // ── Legacy-compatible outcome fields (history / result screen) ───
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    winnerSeat:
      match.result === "player1"
        ? "player1"
        : match.result === "player2"
          ? "player2"
          : match.result === "draw"
            ? "draw"
            : state?.winner ?? null,
    prizePaid: finished && match.winnerId === viewerUserId ? Number(match.prizePaid) || 0 : 0,
    houseFee: finished && match.winnerId === viewerUserId ? Number(match.houseFee) || 0 : 0,
    startedAt: match.startedAt ?? null,
    endedAt: match.endedAt ?? null,
    createdAt: match.createdAt ?? null,

    // The bridge-specific fields are intentionally empty for a race match:
    // a client must dispatch on `mode === "race"`, never render stale bridge
    // state from a shared row.
    bridge: null,
    bridgeRows: 0,
    myRow: 0,
    oppRow: 0,
    broken: [],
    myFlags: [],
    oppFlags: [],
    myFlagsLeft: 0,
    oppFlagsLeft: 0,
    flagsPerPlayer: 0,
    serverSeed: null,
    serverSeedHash: null,
    p1ClientSeed: null,
    p2ClientSeed: null,
  };
}

// ── Ready → planning ─────────────────────────────────────────────────

/**
 * Close the 3s "match found" banner and open the first 60s planning window.
 * The planning clock is restamped here (never at join) so the countdown can
 * never burn while a client is still reading the ready screen.
 */
export async function advanceRaceToPlanning(matchId: number): Promise<boolean> {
  return await db.transaction(async (tx: any) => {
    const match = await fetchForUpdate(tx, matchId);
    if (!match || !isRaceMatch(match) || match.status !== MATCH_STATUS.READY) return false;
    if (match.roundDeadline && new Date(match.roundDeadline).getTime() > Date.now()) {
      return false;
    }
    const decoded = decodeState(match.gameState);
    if (!decoded.ok || !decoded.state) return false;
    const begun = beginPlanning(decoded.state, { now: Date.now() });
    if ("error" in begun) return false;

    const [updated] = await tx
      .update(laneRushDuelMatches)
      .set({
        status: MATCH_STATUS.ACTIVE,
        gameState: begun.state,
        gameStateVersion: LANE_RUSH_STATE_VERSION,
        roundDeadline: new Date(begun.state.planningDeadline as string),
        roundTimerSeconds: PLANNING_SECONDS,
        currentTurnUserId: null,
      })
      .where(
        and(
          eq(laneRushDuelMatches.id, matchId),
          eq(laneRushDuelMatches.status, MATCH_STATUS.READY),
        ),
      )
      .returning();
    return Boolean(updated);
  });
}

// ── Race resolution ──────────────────────────────────────────────────

/**
 * Mark an active race as resolving when both plans are locked or the deadline
 * has passed. The conditional update + row lock makes the marker exactly-once
 * even when two status polls arrive together.
 */
async function markResolving(matchId: number): Promise<boolean> {
  return await db.transaction(async (tx: any) => {
    const match = await fetchForUpdate(tx, matchId);
    if (!match || !isRaceMatch(match) || match.status !== MATCH_STATUS.ACTIVE) {
      return false;
    }
    const decoded = decodeState(match.gameState);
    if (!decoded.ok || !decoded.state) return false;
    if (!isReadyToResolve(syncPlanningDeadline(decoded.state, match), Date.now())) {
      return false;
    }

    const [updated] = await tx
      .update(laneRushDuelMatches)
      .set({ status: MATCH_STATUS.RESOLVING })
      .where(
        and(
          eq(laneRushDuelMatches.id, matchId),
          eq(laneRushDuelMatches.status, MATCH_STATUS.ACTIVE),
        ),
      )
      .returning();
    return Boolean(updated);
  });
}

/**
 * Apply the race result exactly once. Requires the row to already be in
 * `resolving`; the status is consumed inside the same transaction that writes
 * scores, resources, cars and (when the threshold is crossed) settlement.
 */
export async function resolveRaceRound(matchId: number): Promise<RaceResolutionResult> {
  return await db.transaction(async (tx: any) => {
    const match = await fetchForUpdate(tx, matchId);
    if (!match) return fail("Match not found", 404, "not_found");
    if (!isRaceMatch(match)) return fail("Not a Lane Rush race", 409, "legacy_match");
    if (match.status !== MATCH_STATUS.RESOLVING) {
      return { resolved: false, already: true };
    }

    const now = Date.now();
    const decoded = decodeState(match.gameState);
    if (!decoded.ok || !decoded.state) {
      await tx
        .update(laneRushDuelMatches)
        .set({ status: MATCH_STATUS.ACTIVE })
        .where(
          and(
            eq(laneRushDuelMatches.id, matchId),
            eq(laneRushDuelMatches.status, MATCH_STATUS.RESOLVING),
          ),
        );
      return fail(decoded.error ?? "Match state is unavailable", 409, "state_unavailable");
    }

    const state = syncPlanningDeadline(decoded.state, match);
    if (!isReadyToResolve(state, now)) {
      // Never resolve before the rules allow it. Put the row back so a later
      // lock/deadline can try again.
      await tx
        .update(laneRushDuelMatches)
        .set({ status: MATCH_STATUS.ACTIVE })
        .where(
          and(
            eq(laneRushDuelMatches.id, matchId),
            eq(laneRushDuelMatches.status, MATCH_STATUS.RESOLVING),
          ),
        );
      return { resolved: false, already: true };
    }

    const result = resolveRound({
      state,
      randomValues: serverRolls(plannedCarCount(state)),
      now,
    });
    if ("error" in result) {
      await tx
        .update(laneRushDuelMatches)
        .set({ status: MATCH_STATUS.ACTIVE })
        .where(
          and(
            eq(laneRushDuelMatches.id, matchId),
            eq(laneRushDuelMatches.status, MATCH_STATUS.RESOLVING),
          ),
        );
      return fail(result.error, codeStatus(result.code), result.code);
    }

    const next = result.state;
    const log = [
      ...actionLog(match),
      {
        type: "raceResolved",
        round: result.round.round,
        at: new Date(now).toISOString(),
        // Public after the fact: the roll, route and outcome of every car are
        // exactly what the result payload shows to both seats.
        cars: result.round.cars.map((car) => ({
          seat: car.seat,
          carId: car.carId,
          route: car.route,
          roll: car.roll,
          outcome: car.outcome,
          points: car.points,
        })),
      },
    ];

    if (next.phase === "finished") {
      const resultCode =
        next.winner === "player1"
          ? RESULT.PLAYER1
          : next.winner === "player2"
            ? RESULT.PLAYER2
            : RESULT.DRAW;

      // The ONE official settlement path (escrow, 80/20, draw refunds,
      // stats/Elo/trophies/leaderboards, practice exclusions). It also flips
      // the row to `finished`, so a concurrent resolver can no longer get in.
      const settled = await settleLaneRushMatch(
        tx,
        { ...match, actions: log },
        {
          result: resultCode,
          action: {
            type: "raceFinished",
            round: result.round.round,
            winner: next.winner,
            at: new Date(now).toISOString(),
          },
          reason: "race_target",
        },
      );

      const [updated] = await tx
        .update(laneRushDuelMatches)
        .set({
          gameState: next,
          gameStateVersion: LANE_RUSH_STATE_VERSION,
          p1Points: next.seats.player1.points,
          p2Points: next.seats.player2.points,
          roundDeadline: null,
          currentTurnUserId: null,
        })
        .where(
          and(
            eq(laneRushDuelMatches.id, matchId),
            eq(laneRushDuelMatches.status, MATCH_STATUS.FINISHED),
          ),
        )
        .returning();

      return {
        resolved: true,
        finished: true,
        winner: next.winner,
        round: result.round.round,
        match: updated || settled,
        state: next,
      };
    }

    const [updated] = await tx
      .update(laneRushDuelMatches)
      .set({
        status: MATCH_STATUS.ACTIVE,
        gameState: next,
        gameStateVersion: LANE_RUSH_STATE_VERSION,
        p1Points: next.seats.player1.points,
        p2Points: next.seats.player2.points,
        roundDeadline: next.planningDeadline
          ? new Date(next.planningDeadline)
          : null,
        roundTimerSeconds: PLANNING_SECONDS,
        currentTurnUserId: null,
        actions: log,
      })
      .where(
        and(
          eq(laneRushDuelMatches.id, matchId),
          eq(laneRushDuelMatches.status, MATCH_STATUS.RESOLVING),
        ),
      )
      .returning();

    return {
      resolved: true,
      finished: false,
      winner: null,
      round: result.round.round,
      match: updated,
      state: next,
    };
  });
}

/**
 * Heal/resume the lifecycle for a race row: advance ready → planning, mark a
 * ready race as resolving, or finish a marker left behind by a crash. This is
 * called by every status read, so no background scheduler is required.
 */
export async function resolveRaceIfReady(matchId: number): Promise<RaceResolutionResult> {
  const row = await loadMatch(matchId);
  if (!row || !isRaceMatch(row)) return { resolved: false };
  if (row.status === MATCH_STATUS.RESOLVING) {
    return await resolveRaceRound(matchId);
  }
  if (row.status !== MATCH_STATUS.ACTIVE) return { resolved: false };
  if (isBotMatch(row) && (await isPracticePaused("lane-rush-duel", String(matchId)))) {
    return { resolved: false };
  }

  const decoded = decodeState(row.gameState);
  if (!decoded.ok || !decoded.state) return { resolved: false };
  if (!isReadyToResolve(syncPlanningDeadline(decoded.state, row), Date.now())) {
    return { resolved: false };
  }

  const marked = await markResolving(matchId);
  if (!marked) return { resolved: false };
  return await resolveRaceRound(matchId);
}

// ── Status read ──────────────────────────────────────────────────────

export async function fetchRaceMatchWithAutoResolve(
  userId: string,
  matchId: number,
): Promise<Record<string, any>> {
  const row = await loadMatch(matchId);
  if (!row) return fail("Match not found", 404, "not_found");
  if (!isRaceMatch(row)) return fail("Not a Lane Rush race", 409, "legacy_match");
  if (!seatOf(row, userId)) return fail("Forbidden", 403, "forbidden");

  if (isBotMatch(row) && (await isPracticePaused("lane-rush-duel", String(matchId)))) {
    return {
      match: raceMatchView(row, userId, decodeState(row.gameState)),
      advanced: false,
      resolved: false,
      paused: true,
    };
  }

  let advanced = false;
  if (row.status === MATCH_STATUS.READY) {
    advanced = await advanceRaceToPlanning(matchId);
  }
  const resolution = await resolveRaceIfReady(matchId);
  const fresh = (await loadMatch(matchId)) || row;

  return {
    match: raceMatchView(fresh, userId, decodeState(fresh.gameState)),
    advanced: advanced || Boolean(resolution.resolved),
    resolved: Boolean(resolution.resolved),
    resolvedRound: resolution.round ?? null,
    paused: false,
  };
}

// ── Planning actions ─────────────────────────────────────────────────

function normaliseAction(raw: unknown): LaneRushAction | null {
  if (!isPlainObject(raw)) return null;
  const type = String(raw.type ?? "");
  switch (type) {
    case "buy":
      return { type: "buy" };
    case "deploy": {
      if (!isRouteId(raw.route)) return null;
      return { type: "deploy", carId: String(raw.carId ?? ""), route: raw.route };
    }
    case "recall":
      return { type: "recall", carId: String(raw.carId ?? "") };
    case "setRoute": {
      if (!isRouteId(raw.route)) return null;
      return { type: "setRoute", carId: String(raw.carId ?? ""), route: raw.route };
    }
    case "merge":
      return {
        type: "merge",
        carId: String(raw.carId ?? ""),
        otherCarId: String(raw.otherCarId ?? ""),
      };
    case "repair":
      return { type: "repair", carId: String(raw.carId ?? "") };
    case "workshopRecovery":
      return { type: "workshopRecovery", carId: String(raw.carId ?? "") };
    default:
      return null;
  }
}

function isLockAction(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const type = String(raw.type ?? "");
  return type === "lockIn" || type === "lock";
}

/**
 * Apply a validated plan (one or more actions, optionally ending in a
 * lock-in) for one authenticated seat.
 *
 * Rejects: invalid/duplicate action ids, stale rounds or state versions,
 * expired deadlines, lock-in thereafter, legacy rows, and anything the engine
 * refuses. Nothing is persisted unless EVERY action in the request succeeds,
 * so a failed plan cannot leave a half-spent garage.
 */
export async function submitRacePlan({
  userId,
  matchId,
  actionId,
  actions,
  expectedRound,
  expectedStateVersion,
  now,
}: {
  userId: string;
  matchId: number;
  actionId?: unknown;
  actions?: unknown;
  expectedRound?: unknown;
  expectedStateVersion?: unknown;
  now?: number;
}): Promise<RaceMutationResult> {
  const id = actionId == null ? "" : String(actionId).trim();
  if (!id || id.length > 128) {
    return fail("A unique actionId is required", 400, "missing_action_id");
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return fail("No actions submitted", 400, "no_actions");
  }
  if (actions.length > 20) {
    return fail("Too many actions in one plan", 400, "too_many_actions");
  }

  const outcome = await db.transaction(async (tx: any) => {
    const match = await fetchForUpdate(tx, matchId);
    // Evaluate the server deadline AFTER the row lock: a request that queued
    // behind another transaction must not act on a deadline that has since
    // passed. A caller-supplied `now` is honoured for tests/lifecycle replay.
    const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
    if (!match) return fail("Match not found", 404, "not_found");
    if (!isRaceMatch(match)) return fail("Not a Lane Rush race", 409, "legacy_match");

    const seat = seatOf(match, userId);
    if (!seat) return fail("Forbidden", 403, "forbidden");

    if (isBotMatch(match) && (await isPracticePaused("lane-rush-duel", String(matchId)))) {
      return fail("Practice match is paused", 409, "paused");
    }

    const log = actionLog(match);
    // Idempotency comes FIRST so a retried request is safe even if the match
    // has moved on (or finished) since the first attempt landed.
    const existing = hasActionId(log, id);
    if (existing) {
      if (existing.seat !== seat) {
        return fail("That action id is already in use", 409, "action_id_conflict");
      }
      return { duplicate: true, match };
    }

    if (match.status === MATCH_STATUS.FINISHED || match.status === MATCH_STATUS.CANCELLED) {
      return fail("Match is already over", 409, "not_planning");
    }
    if (match.status !== MATCH_STATUS.ACTIVE) {
      return fail("Match is not in a planning phase", 409, "not_planning");
    }

    const decoded = decodeState(match.gameState);
    if (!decoded.ok || !decoded.state) {
      return fail(decoded.error ?? "Match state is unavailable", 409, "state_unavailable");
    }
    let state = syncPlanningDeadline(decoded.state, match);
    if (state.phase !== "planning") {
      return fail("The race is already over", 409, "not_planning");
    }

    if (
      expectedStateVersion != null &&
      Number(expectedStateVersion) !== LANE_RUSH_STATE_VERSION
    ) {
      return fail("Stale game state version — refresh", 409, "stale_state");
    }
    if (expectedRound != null && Number(expectedRound) !== state.round) {
      return fail("That round is already over — refresh", 409, "stale_round");
    }
    if (isPlanningExpired(state, at)) {
      return fail("Planning time is over", 409, "deadline_expired");
    }

    const applied: any[] = [];
    for (const raw of actions) {
      if (isLockAction(raw)) {
        const locked = lockIn(state, seat, { now: at });
        if ("error" in locked) {
          return fail(locked.error, codeStatus(locked.code), locked.code);
        }
        state = locked.state;
        applied.push({ type: "lockIn" });
        continue;
      }
      const action = normaliseAction(raw);
      if (!action) return fail("Unknown action", 400, "invalid_action");
      const result = applyAction(state, seat, action, { now: at });
      if ("error" in result) {
        return fail(result.error, codeStatus(result.code), result.code);
      }
      state = result.state;
      applied.push(action);
    }

    const entry = {
      actionId: id,
      seat,
      round: decoded.state.round,
      actions: applied,
      locked: state.seats[seat].locked,
      at: new Date(at).toISOString(),
    };

    const [updated] = await tx
      .update(laneRushDuelMatches)
      .set({
        gameState: state,
        gameStateVersion: LANE_RUSH_STATE_VERSION,
        actions: [...log, entry],
        roundDeadline: state.planningDeadline ? new Date(state.planningDeadline) : null,
        p1Points: state.seats.player1.points,
        p2Points: state.seats.player2.points,
      })
      .where(
        and(
          eq(laneRushDuelMatches.id, matchId),
          eq(laneRushDuelMatches.status, MATCH_STATUS.ACTIVE),
        ),
      )
      .returning();

    if (!updated) return fail("Match changed — refresh", 409, "stale_match");
    return { match: updated, state, locked: state.seats[seat].locked };
  });

  // The transaction's inferred union is wider than its runtime shape (and
  // strictNullChecks is off in this repo), so read the optional result fields
  // through one loose handle.
  const planned: any = outcome;
  if (planned.duplicate) return planned;
  if (planned.error) {
    // A request that arrived after the deadline still lets the match move on:
    // resolve the expired planning phase now instead of waiting for a poll.
    if (planned.code === "deadline_expired" || planned.code === "expired") {
      const resolution = await resolveRaceIfReady(matchId);
      return {
        ...planned,
        match: resolution.match ?? planned.match,
        resolution,
        resolved: Boolean(resolution.resolved),
      };
    }
    return planned;
  }

  // Both locked (or the clock ran out while this request was in flight) →
  // resolve immediately. Random values are generated inside the resolver.
  const resolution = await resolveRaceIfReady(matchId);
  return {
    ...planned,
    match: resolution.match ?? planned.match,
    resolution,
    resolved: Boolean(resolution.resolved),
  };
}

// ── Practice bot ─────────────────────────────────────────────────────

/**
 * The practice bot plans through the SAME validated actions a human submits.
 * It never sends a tile pick, a roll, a score or a result; the resolver above
 * decides the race.
 */
export async function botRaceAct({
  matchId,
  requesterId,
  actionId,
}: {
  matchId: number;
  requesterId: string;
  actionId?: unknown;
}): Promise<RaceMutationResult> {
  const id = actionId == null ? "" : String(actionId).trim();

  const outcome = await db.transaction(async (tx: any) => {
    const match = await fetchForUpdate(tx, matchId);
    if (!match) return fail("Match not found", 404, "not_found");
    if (!isRaceMatch(match)) return fail("Not a Lane Rush race", 409, "legacy_match");
    if (!isBotMatch(match) || match.player2Id !== BOT_USER_ID) {
      return fail("Not a bot match", 403, "not_bot_match");
    }
    if (requesterId !== match.player1Id) return fail("Forbidden", 403, "forbidden");
    if (await isPracticePaused("lane-rush-duel", String(matchId))) {
      return { match, paused: true };
    }

    const log = actionLog(match);
    if (id) {
      const existing = hasActionId(log, id);
      if (existing) return { duplicate: true, match };
    }

    if (match.status !== MATCH_STATUS.ACTIVE) return { match, noop: true };
    const decoded = decodeState(match.gameState);
    if (!decoded.ok || !decoded.state) {
      return fail(decoded.error ?? "Match state is unavailable", 409, "state_unavailable");
    }
    const state = syncPlanningDeadline(decoded.state, match);
    if (state.phase !== "planning" || state.seats.player2.locked) {
      return { match, noop: true };
    }
    if (isPlanningExpired(state, Date.now())) {
      // No planning on borrowed time: the deadline resolver takes over.
      return { match, expired: true };
    }

    const plan = planBotTurn({
      state,
      seat: "player2",
      difficulty: match.difficulty,
      now: Date.now(),
    });

    const entry = {
      actionId: id || null,
      seat: "player2",
      round: state.round,
      actions: plan.actions,
      locked: plan.locked,
      at: new Date().toISOString(),
    };

    const [updated] = await tx
      .update(laneRushDuelMatches)
      .set({
        gameState: plan.state,
        gameStateVersion: LANE_RUSH_STATE_VERSION,
        actions: [...log, entry],
        roundDeadline: plan.state.planningDeadline
          ? new Date(plan.state.planningDeadline)
          : null,
        p1Points: plan.state.seats.player1.points,
        p2Points: plan.state.seats.player2.points,
      })
      .where(
        and(
          eq(laneRushDuelMatches.id, matchId),
          eq(laneRushDuelMatches.status, MATCH_STATUS.ACTIVE),
        ),
      )
      .returning();

    if (!updated) return fail("Match changed — refresh", 409, "stale_match");
    return {
      match: updated,
      state: plan.state,
      planned: plan.actions.length,
      locked: plan.locked,
    };
  });

  const planned: any = outcome;
  if (planned.error || planned.duplicate) return planned;
  const resolution = await resolveRaceIfReady(matchId);
  return {
    ...planned,
    match: resolution.match ?? planned.match,
    resolution,
    resolved: Boolean(resolution.resolved),
  };
}

// ── Resignation ──────────────────────────────────────────────────────

export async function resignRaceMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: number;
}): Promise<RaceMutationResult> {
  return await db.transaction(async (tx: any) => {
    const match = await fetchForUpdate(tx, matchId);
    if (!match) return fail("Match not found", 404, "not_found");
    if (!isRaceMatch(match)) return fail("Not a Lane Rush race", 409, "legacy_match");

    const seat = seatOf(match, userId);
    if (!seat) return fail("Forbidden", 403, "forbidden");
    if (
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      return fail("Match already finished", 400, "already_finished");
    }
    if (match.status === MATCH_STATUS.WAITING) {
      return fail("Use cancel to leave a waiting match", 400, "still_waiting");
    }

    const winnerSeat = otherSeat(seat);
    const resultCode =
      winnerSeat === "player1" ? RESULT.PLAYER1 : RESULT.PLAYER2;
    const decoded = decodeState(match.gameState);
    let next: LaneRushState | null = null;
    if (decoded.ok && decoded.state) {
      next = JSON.parse(JSON.stringify(decoded.state)) as LaneRushState;
      next.phase = "finished";
      next.winner = winnerSeat;
      next.planningDeadline = null;
      for (const s of SEATS) {
        next.seats[s].locked = true;
        next.seats[s].actionPoints = 0;
      }
    }

    const log = [
      ...actionLog(match),
      {
        type: "resigned",
        seat,
        at: new Date().toISOString(),
        winner: winnerSeat,
      },
    ];

    const settled = await settleLaneRushMatch(
      tx,
      { ...match, actions: log },
      {
        result: resultCode,
        action: { type: "resign", seat, at: new Date().toISOString() },
        reason: "resigned",
      },
    );

    let finalRow = settled;
    if (next) {
      const [updated] = await tx
        .update(laneRushDuelMatches)
        .set({
          gameState: next,
          gameStateVersion: LANE_RUSH_STATE_VERSION,
          p1Points: next.seats.player1.points,
          p2Points: next.seats.player2.points,
          roundDeadline: null,
          currentTurnUserId: null,
        })
        .where(
          and(
            eq(laneRushDuelMatches.id, matchId),
            eq(laneRushDuelMatches.status, MATCH_STATUS.FINISHED),
          ),
        )
        .returning();
      finalRow = updated || settled;
    }

    return { match: finalRow, winner: winnerSeat, finished: true };
  });
}
