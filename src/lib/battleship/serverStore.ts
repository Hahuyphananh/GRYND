// src/lib/battleship/serverStore.ts
//
// The server-authoritative Battleship online match store. Every transition runs
// inside a row-locked `db.transaction`; the API routes are thin wrappers.
//
// ── TRUST BOUNDARY ────────────────────────────────────────────────────────
//
// The only player-authored value that reaches this module is a FLEET PLACEMENT
// list on the confirm route. Both player ids come from the Clerk gate, the match
// phase comes from the row, the readiness flags are derived from the seats'
// confirmed fleet rows, and the result/winner columns are never written here at
// all (combat resolution is a later phase). A client cannot submit a phase, a
// seat, a player id, a ready flag or a winner — no such field is read.
//
// ── CONCURRENCY ───────────────────────────────────────────────────────────
//
//   1. matchmaking takes one per-game advisory lock
//      (`pg_advisory_xact_lock(BATTLESHIP_LOCK_NAMESPACE, 0)`) plus a
//      conditional UPDATE, so two callers can never both open a lobby and a
//      caller can never join a lobby that is being cancelled;
//   2. every mutation locks its match row with `FOR UPDATE`;
//   3. the fleet confirm is a conditional UPDATE on the phase it read, so two
//      concurrent confirms cannot both advance the match;
//   4. `battleship_fleets` is UNIQUE (match_id, seat): one fleet per seat, ever.
//
// ── PRIVATE FLEETS ────────────────────────────────────────────────────────
//
// Fleet placements live in `battleship_fleets`, a table this module only ever
// reads filtered by the VIEWER'S OWN SEAT. The match DTO (`matchDto`) has one
// fleet field and it is populated from that own-seat read; the opponent's fleet
// is never selected, so it cannot be leaked by a route or a serialiser.
//
// ── ECONOMY ───────────────────────────────────────────────────────────────
//
// Battleship is free to play. There is no stake parameter, no escrow call, no
// payout and no stake column — a match moves no coins by construction.

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  battleshipAttacks,
  battleshipFleets,
  battleshipMatches,
  users,
} from "../../db/schema";
import { createMatchLifecycle, transitionMatchLifecycle } from "../matchLifecycleStore";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { isGuestId } from "../guestIdentity";
import {
  GUEST_PRACTICE_BATTLESHIP_GAME_KEY,
  recordGuestPracticeResultSafely,
} from "../guest/practiceProgress";
import { deserializeFleet, generateRandomFleet, serializeFleet } from "./fleet";
import { chooseAiAttack } from "./ai";
import { DEFAULT_AI_DIFFICULTY, coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import {
  formatCoordinate,
  hasAttacked,
  inBounds,
  matchViewForSeat,
  otherSeat,
  parseCoordinate,
  resolveRound,
  validateFleet,
} from "./rules";
import {
  attackForRound,
  buildMatchState,
  expectedRound,
  resolvedRecords,
  roundLocked,
  type PersistedAttack,
} from "./combat";
import {
  BATTLESHIP_AI_PLAYER_ID,
  BATTLESHIP_LOCK_NAMESPACE,
  COLUMNS,
  MATCH_PHASE,
  PLACEMENT_SECONDS,
  ROWS,
  ROUND_SECONDS,
  SEATS,
  SHOT_RESULTS,
} from "./constants";
import {
  canCancelMatch,
  canConfirmFleet,
  canJoinLobby,
  canSubmitAttack,
  phaseForFleetReadiness,
  requireSeat,
  seatForUser,
} from "./seats";
import {
  placementTimeoutVerdict,
  pickTimeoutCoordinate,
  serverRandomInt,
  timeoutForfeitSeats,
  type RandomInt,
} from "./timeouts";
import type { Fleet, MatchView, Seat } from "./types";

type MatchRow = typeof battleshipMatches.$inferSelect;

export type StoreError = { error: string; status: number };

/** Explicit unions: this repo compiles with `strict: false`, where an INFERRED
 *  union of structurally similar literals is not narrowed by `"error" in …`. */
export type CreateOrJoinResult = { match: MatchRow; joined: boolean } | StoreError;
export type FetchMatchResult = { dto: MatchDto; events?: TimeoutEvent[] } | StoreError;
export type ConfirmFleetResult = { dto: MatchDto; confirmed: boolean } | StoreError;
export type CancelMatchResult = { dto: MatchDto } | StoreError;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Route-level guard so a non-UUID id can never reach a Postgres uuid cast. */
export function isMatchId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const GAME_KEY = "battleship";

/** The client-safe projection of a match. */
export interface PendingRound {
  readonly round: number;
  readonly youLocked: boolean;
  readonly opponentLocked: boolean;
  /** YOUR OWN locked cell, so the board can show it. Never the opponent's. */
  readonly yourCoordinate: string | null;
}

/**
 * It is a WHITELIST, never the row: no `player2Id`-shaped "which seat am I"
 * guessing, no internal columns, and exactly ONE fleet field, filled only from
 * the viewer's own seat. The opponent entry carries readiness/timeouts and
 * nothing else about their ships.
 *
 * `combat` is the engine's own per-seat projection (`matchViewForSeat`): public
 * boards, the viewer's fleet, sunk ships and the attack logs. It has no field
 * that can carry an opponent ship position.
 */
export interface MatchDto {
  readonly matchId: string;
  readonly phase: string;
  readonly round: number;
  readonly seats: { readonly player1Id: string; readonly player2Id: string | null };
  readonly you: { readonly seat: Seat; readonly ready: boolean; readonly timeouts: number };
  readonly opponent: {
    readonly seat: Seat;
    readonly ready: boolean;
    readonly timeouts: number;
    readonly joined: boolean;
  };
  readonly deadlines: { readonly placement: Date | null; readonly round: Date | null };
  readonly result: string | null;
  /** Free practice vs the built-in bot. Always unrated and never matchmade. */
  readonly isAi: boolean;
  /** The bot's tier, or null on a PvP row. */
  readonly aiDifficulty: AiDifficulty | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
  /** The VIEWER'S OWN fleet, or null until they confirm one. */
  readonly fleet: { readonly ships: Fleet["ships"] } | null;
  /** The combat projection, or null outside combat/finished. */
  readonly combat: MatchView | null;
  /** This round's lock state; the opponent's CELL is never included. */
  readonly pending: PendingRound | null;
}

/** Builds the projection. Exported so the "no opponent fleet" contract is testable. */
export function matchDto(
  row: MatchRow,
  seat: Seat,
  fleet: Fleet | null = null,
  combat: MatchView | null = null,
  pending: PendingRound | null = null,
): MatchDto {
  const opponent = otherSeat(seat);
  return {
    matchId: row.id,
    phase: row.phase,
    round: row.round,
    seats: { player1Id: row.player1Id, player2Id: row.player2Id ?? null },
    you: {
      seat,
      ready: seat === "player1" ? row.player1Ready : row.player2Ready,
      timeouts: seat === "player1" ? row.player1Timeouts : row.player2Timeouts,
    },
    opponent: {
      seat: opponent,
      ready: opponent === "player1" ? row.player1Ready : row.player2Ready,
      timeouts: opponent === "player1" ? row.player1Timeouts : row.player2Timeouts,
      joined: Boolean(row.player2Id),
    },
    deadlines: {
      placement: row.placementDeadline ?? null,
      round: row.roundDeadline ?? null,
    },
    result: row.result ?? null,
    isAi: row.isAi === true,
    aiDifficulty: row.aiDifficulty ? coerceAiDifficulty(row.aiDifficulty) : null,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    createdAt: row.createdAt,
    fleet: fleet ? { ships: fleet.ships } : null,
    combat,
    pending,
  };
}

/** The viewer's OWN fleet. Never called with the opponent's seat. */
async function ownFleet(matchId: string, seat: Seat, tx: any = db): Promise<Fleet | null> {
  const [row] = await tx
    .select({ placement: battleshipFleets.placement })
    .from(battleshipFleets)
    .where(and(eq(battleshipFleets.matchId, matchId), eq(battleshipFleets.seat, seat)))
    .limit(1);
  if (!row) return null;
  return deserializeFleet(row.placement);
}

// ── Matchmaking ───────────────────────────────────────────────────────────

/**
 * Seats the caller in the oldest open Battleship lobby, or opens a new one.
 * Free to play: no stake argument exists, so two callers can never be matched at
 * different prices.
 */
export async function createOrJoin({ userId }: { userId: string }): Promise<CreateOrJoinResult> {
  if (!userId) return { error: "Unauthenticated", status: 401 };

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BATTLESHIP_LOCK_NAMESPACE}, 0)`);

    const [open] = await tx
      .select()
      .from(battleshipMatches)
      .where(and(eq(battleshipMatches.phase, MATCH_PHASE.WAITING), isNull(battleshipMatches.player2Id)))
      .orderBy(sql`${battleshipMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      const joinable = canJoinLobby(open, userId);
      if (joinable.ok === false) {
        // The host's own lobby is handed back, never re-created and never
        // self-joined; any other refusal is a clean 409.
        if (joinable.reason === "self") return { match: open, joined: false };
        return { error: joinable.message, status: joinable.status };
      }
      return joinExistingMatch(tx, open.id, userId);
    }

    return createWaitingMatch(tx, userId);
  });
}

async function createWaitingMatch(tx: any, userId: string): Promise<CreateOrJoinResult> {
  const [match] = await tx
    .insert(battleshipMatches)
    .values({
      player1Id: userId,
      player2Id: null,
      phase: MATCH_PHASE.WAITING,
    })
    .returning();

  // Canonical queue lifecycle row, created atomically with the lobby.
  await createMatchLifecycle({
    matchId: match.id,
    gameKey: GAME_KEY,
    mode: "pvp",
    playerCount: 1,
    tx,
  });

  return { match, joined: false };
}

async function joinExistingMatch(
  tx: any,
  candidateId: string,
  userId: string,
): Promise<CreateOrJoinResult> {
  const [match] = await tx
    .select()
    .from(battleshipMatches)
    .where(eq(battleshipMatches.id, candidateId))
    .for("update");

  if (!match) return { error: "Match is no longer available", status: 409 };

  const joinable = canJoinLobby(match, userId);
  if (joinable.ok === false) {
    return { error: joinable.message, status: joinable.status };
  }

  const now = new Date();
  const [updated] = await tx
    .update(battleshipMatches)
    .set({
      player2Id: userId,
      phase: MATCH_PHASE.PLACEMENT,
      // Both seats now have a placement window; the store owns the clock.
      placementDeadline: new Date(now.getTime() + PLACEMENT_SECONDS * 1000),
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(battleshipMatches.id, candidateId),
        eq(battleshipMatches.phase, MATCH_PHASE.WAITING),
        isNull(battleshipMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) return { error: "Match is no longer available", status: 409 };

  // Canonical lifecycle: queued → forming → ready → started, in this same
  // transaction, so a failed seat claim cannot leave a started lifecycle row.
  await transitionMatchLifecycle({ matchId: candidateId, to: "forming", playerCount: 2, at: now, tx });
  await transitionMatchLifecycle({ matchId: candidateId, to: "ready", playerCount: 2, at: now, tx });
  await transitionMatchLifecycle({ matchId: candidateId, to: "started", playerCount: 2, at: now, tx });

  return { match: updated, joined: true };
}

/** The open lobby list for the lobby screen. */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return db
    .select({
      id: battleshipMatches.id,
      player1Id: battleshipMatches.player1Id,
      phase: battleshipMatches.phase,
      createdAt: battleshipMatches.createdAt,
    })
    .from(battleshipMatches)
    .where(and(eq(battleshipMatches.phase, MATCH_PHASE.WAITING), isNull(battleshipMatches.player2Id)))
    .orderBy(sql`${battleshipMatches.createdAt} DESC`)
    .limit(Math.max(1, Math.min(limit, 50)));
}

/** The caller's own open lobby, so the lobby can offer "resume". */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select({
      id: battleshipMatches.id,
      player1Id: battleshipMatches.player1Id,
      phase: battleshipMatches.phase,
      createdAt: battleshipMatches.createdAt,
    })
    .from(battleshipMatches)
    .where(
      and(
        eq(battleshipMatches.phase, MATCH_PHASE.WAITING),
        eq(battleshipMatches.player1Id, userId),
        isNull(battleshipMatches.player2Id),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * The authoritative snapshot for the calling participant. A non-participant gets
 * 403 — there is no spectator mode — and the opponent's fleet is never read.
 * Pure projection: a read can never change the match.
 */
export async function fetchMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}): Promise<FetchMatchResult> {
  const [row] = await db
    .select()
    .from(battleshipMatches)
    .where(eq(battleshipMatches.id, matchId))
    .limit(1);

  if (!row) return { error: "Match not found", status: 404 };

  const access = requireSeat(row, userId);
  if (access.ok === false) return { error: access.message, status: access.status };

  // LAZY RECOVERY: a deadline that passed while this process (or the whole
  // service) was down is settled here, before the snapshot is built. The browser
  // countdown is display-only; this read is what makes recovery automatic.
  const events = await settleIfOverdue(row);
  const current = events.length > 0 ? await readMatchRow(matchId) : row;
  if (!current) return { error: "Match not found", status: 404 };

  const fleet = await ownFleet(matchId, access.seat);
  const dto = await buildDto(current, access.seat);
  return { dto: dto ?? matchDto(current, access.seat, fleet), events };
}

// ── Fleet confirmation ────────────────────────────────────────────────────

/**
 * Confirms the caller's fleet. The fleet is validated by the pure engine, then
 * written once (UNIQUE match+seat) and the seat's readiness flag is set in the
 * same transaction. When BOTH seats are ready the match moves to COMBAT and the
 * first round clock starts — that is the only transition into combat, so no
 * attack can exist before both fleets are validated.
 *
 * A repeat confirmation is idempotent: it returns the current snapshot instead
 * of replacing the fleet or re-running the transition.
 */
export async function confirmFleet({
  userId,
  matchId,
  ships,
}: {
  userId: string;
  matchId: string;
  ships: unknown;
}): Promise<ConfirmFleetResult> {
  const verdict = validateFleet({ ships: ships as Fleet["ships"] });
  if (verdict.ok === false) return { error: verdict.message, status: 400 };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(battleshipMatches)
      .where(eq(battleshipMatches.id, matchId))
      .for("update");

    if (!row) return { error: "Match not found", status: 404 };

    // A late fleet cannot be accepted: the 60 s clock is the server's, and the
    // sweep/lazy recovery settles the seat that missed it (never a dealt fleet).
    if (
      row.phase === MATCH_PHASE.PLACEMENT &&
      row.placementDeadline &&
      row.placementDeadline <= new Date()
    ) {
      return { error: "The placement clock expired", status: 409 };
    }

    const can = canConfirmFleet({ phase: row.phase, seats: row, userId });
    if (can.ok === false) return { error: can.message, status: can.status };

    const seat = can.seat;
    const alreadyReady = seat === "player1" ? row.player1Ready : row.player2Ready;
    if (alreadyReady) {
      return { dto: await buildDto(row, seat, tx), confirmed: true };
    }

    const now = new Date();
    const fleet: Fleet = { ships: ships as Fleet["ships"] };

    await tx
      .insert(battleshipFleets)
      .values({
        matchId,
        seat,
        placement: serializeFleet(fleet),
        confirmedAt: now,
      })
      // One fleet per seat, ever. A concurrent confirmation on the same seat
      // loses here and is reported by the row lock above.
      .onConflictDoNothing();

    const player1Ready = seat === "player1" ? true : row.player1Ready;
    const player2Ready = seat === "player2" ? true : row.player2Ready;
    const phase = phaseForFleetReadiness(player1Ready, player2Ready);

    const [updated] = await tx
      .update(battleshipMatches)
      .set({
        player1Ready,
        player2Ready,
        phase,
        round: phase === MATCH_PHASE.COMBAT ? Math.max(row.round, 1) : row.round,
        roundDeadline:
          phase === MATCH_PHASE.COMBAT
            ? new Date(now.getTime() + ROUND_SECONDS * 1000)
            : row.roundDeadline,
        updatedAt: now,
      })
      .where(and(eq(battleshipMatches.id, matchId), eq(battleshipMatches.phase, row.phase)))
      .returning();

    if (!updated) {
      return { error: "Match changed concurrently; retry the request", status: 409 };
    }

    // PRACTICE: the bot's fleet was ready at creation, so this confirmation is
    // what opens combat — and the bot must lock its first shot BEFORE the human
    // can submit one. Committing here is what makes the bot's choice independent
    // of the human's coordinate for the round.
    if (updated.isAi && updated.phase === MATCH_PHASE.COMBAT) {
      await commitAiAttackTx(tx, updated);
    }

    return { dto: await buildDto(updated, seat, tx), confirmed: false };
  });
}

// ── Cancellation ──────────────────────────────────────────────────────────

/**
 * Cancels the caller's WAITING lobby. Only the host may cancel and only before
 * an opponent arrives; a live match is ended by its own rules, not by a cancel
 * route. The canonical lifecycle row moves to `cancelled` with a reason.
 */
export async function cancelMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}): Promise<CancelMatchResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(battleshipMatches)
      .where(eq(battleshipMatches.id, matchId))
      .for("update");

    if (!row) return { error: "Match not found", status: 404 };

    const can = canCancelMatch({ phase: row.phase, seats: row, userId });
    if (can.ok === false) return { error: can.message, status: can.status };

    const now = new Date();
    const [updated] = await tx
      .update(battleshipMatches)
      .set({ phase: MATCH_PHASE.CANCELLED, endedAt: now, updatedAt: now })
      .where(and(eq(battleshipMatches.id, matchId), eq(battleshipMatches.phase, MATCH_PHASE.WAITING)))
      .returning();

    if (!updated) return { error: "Match is no longer cancellable", status: 409 };

    await transitionMatchLifecycle({
      matchId,
      to: "cancelled",
      cancelReason: "user_cancelled",
      at: now,
      tx,
    });

    const seat = seatForUser(updated, userId);
    return { dto: matchDto(updated, seat ?? "player1", null) };
  });
}

// ── Combat ────────────────────────────────────────────────────────────────

/** One seat's resolved shot, as published after the round commits. */
export interface ServerAttackResolution {
  readonly coordinate: string;
  readonly result: string;
  readonly ship: string | null;
}

/** Everything one resolved round produced. Published only after COMMIT. */
export interface ServerRoundResult {
  readonly round: number;
  readonly attacks: Record<Seat, ServerAttackResolution>;
  readonly destroyed: Record<Seat, boolean>;
  /** Ships DESTROYED by this round's two shots (identities only). */
  readonly sunkShips: string[];
  /** Seats whose shot this round was chosen by the server (timeout). */
  readonly automaticSeats: Seat[];
  readonly outcome: string | null;
  readonly status: string;
  /** The round that opened next, or null when the match ended. */
  readonly nextRound: number | null;
  readonly roundDeadline: string | null;
}

export type AttackSubmitResult =
  | { status: "waiting"; dto: MatchDto }
  | { status: "resolved"; dto: MatchDto; round: ServerRoundResult }
  | StoreError;

const asWaiting = (dto: MatchDto): AttackSubmitResult => ({ status: "waiting", dto });
const asResolved = (dto: MatchDto, round: ServerRoundResult): AttackSubmitResult => ({
  status: "resolved",
  dto,
  round,
});

async function attackRows(matchId: string, tx: any = db): Promise<PersistedAttack[]> {
  return tx
    .select()
    .from(battleshipAttacks)
    .where(eq(battleshipAttacks.matchId, matchId))
    .orderBy(asc(battleshipAttacks.round));
}

/**
 * BOTH fleets, server-side only.
 *
 * Resolution needs the defender's layout to judge a shot, so combat must read
 * both rows — but these values never leave the module: what a client receives is
 * the engine's per-seat projection, which has no field for an opponent fleet.
 */
async function bothFleets(matchId: string, tx: any = db): Promise<Record<Seat, Fleet> | null> {
  const rows = await tx
    .select({ seat: battleshipFleets.seat, placement: battleshipFleets.placement })
    .from(battleshipFleets)
    .where(eq(battleshipFleets.matchId, matchId));

  const bySeat: Partial<Record<Seat, Fleet>> = {};
  for (const row of rows) {
    if (row.seat !== "player1" && row.seat !== "player2") continue;
    const fleet = deserializeFleet(row.placement);
    if (fleet) bySeat[row.seat] = fleet;
  }
  if (!bySeat.player1 || !bySeat.player2) return null;
  return { player1: bySeat.player1, player2: bySeat.player2 };
}

function pendingFor(
  row: MatchRow,
  seat: Seat,
  attacks: readonly PersistedAttack[],
): PendingRound | null {
  if (row.phase !== MATCH_PHASE.COMBAT) return null;
  const locked = roundLocked(attacks, row.round);
  const own = attackForRound(attacks, row.round, seat);
  return {
    round: row.round,
    youLocked: Boolean(own),
    opponentLocked: seat === "player1" ? locked.player2 : locked.player1,
    yourCoordinate: own?.coordinate ?? null,
  };
}

/** The full per-viewer snapshot: row + own fleet + engine projection + locks. */
async function buildDto(row: MatchRow, seat: Seat, tx: any = db): Promise<MatchDto> {
  const attacks = await attackRows(row.id, tx);
  const fleets = await bothFleets(row.id, tx);
  const own = fleets ? fleets[seat] : await ownFleet(row.id, seat, tx);

  let combat: MatchView | null = null;
  if (fleets && (row.phase === MATCH_PHASE.COMBAT || row.phase === MATCH_PHASE.FINISHED)) {
    const state = buildMatchState({ round: row.round, fleets, attacks });
    if (state) combat = matchViewForSeat(state, seat);
  }

  return matchDto(row, seat, own, combat, pendingFor(row, seat, attacks));
}

/**
 * Locks one attack for the open round, and — when the OTHER seat is already
 * locked — resolves both shots simultaneously and commits the round.
 *
 * The transaction is the authority:
 *   1. `FOR UPDATE` on the match row serialises everything for this match;
 *   2. a live seat check (403 for anyone else);
 *   3. the phase and the round come from the row, not the request;
 *   4. the cell must be legal and not already fired by this seat;
 *   5. the lock row is inserted `ON CONFLICT DO NOTHING` under
 *      UNIQUE (match_id, round, seat), so a duplicate submission cannot create a
 *      second lock;
 *   6. if only one lock exists, the round stays open and NOTHING is published;
 *   7. otherwise both shots are judged against the same pre-round state by
 *      `resolveRound`, both rows are completed, the row moves to the next round
 *      (or finishes), and a conditional UPDATE on round + phase makes a second
 *      concurrent resolution impossible.
 */
export async function submitAttack({
  userId,
  matchId,
  coordinate,
}: {
  userId: string;
  matchId: string;
  coordinate: unknown;
}): Promise<AttackSubmitResult> {
  const parsed = parseCoordinate(typeof coordinate === "string" ? coordinate : null);
  if (!parsed || !inBounds(parsed)) {
    const lastCell = `${COLUMNS[COLUMNS.length - 1]}${ROWS[ROWS.length - 1]}`;
    return { error: `Pick a coordinate inside the board (A1-${lastCell})`, status: 400 };
  }
  const label = formatCoordinate(parsed);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(battleshipMatches)
      .where(eq(battleshipMatches.id, matchId))
      .for("update");

    if (!row) return { error: "Match not found", status: 404 };

    const access = requireSeat(row, userId);
    if (access.ok === false) return { error: access.message, status: access.status };
    const seat = access.seat;

    let attacks = await attackRows(matchId, tx);

    // The 15 s deadline is the server's. If it has already passed, the seat that
    // is NOT calling gets its automatic attack materialised now — and if that
    // reaches the forfeit threshold, the match is settled before this manual
    // shot is stored.
    if (
      row.phase === MATCH_PHASE.COMBAT &&
      row.roundDeadline &&
      row.roundDeadline <= new Date()
    ) {
      const auto = await applyAutoAttacksTx(
        tx,
        row,
        attacks,
        new Date(),
        serverRandomInt,
        otherSeat(seat),
      );
      if (auto.seats.length > 0) {
        const consecutive = {
          player1:
            row.player1ConsecutiveTimeouts + (auto.seats.includes("player1") ? 1 : 0),
          player2:
            row.player2ConsecutiveTimeouts + (auto.seats.includes("player2") ? 1 : 0),
        };
        const forfeiting = timeoutForfeitSeats(consecutive);
        if (forfeiting.length === 2) {
          await drawMatchTx(tx, row, "timeout_forfeit", new Date());
          return { error: "Both players timed out", status: 409 };
        }
        if (forfeiting.length === 1) {
          await finishMatchTx(tx, row, otherSeat(forfeiting[0]), "timeout_forfeit", new Date());
          return { error: "The round timed out", status: 409 };
        }
      }
      attacks = await attackRows(matchId, tx);
    }

    // Idempotency: repeating the SAME coordinate is a successful no-op, so a
    // retried request can never consume two rounds. A DIFFERENT coordinate after
    // locking is refused — the lock is final and the client cannot change it.
    const existing = attackForRound(attacks, row.round, seat);
    if (existing) {
      if (existing.coordinate.toUpperCase() === label) {
        return asWaiting(await buildDto(row, seat, tx));
      }
      return { error: "Your attack is locked for this round", status: 409 };
    }

    const can = canSubmitAttack({
      phase: row.phase,
      seats: row,
      userId,
      round: row.round,
      locked: roundLocked(attacks, row.round),
    });
    if (can.ok === false) return { error: can.message, status: can.status };
    if (can.seat !== seat) return { error: "Seat mismatch", status: 403 };

    if (hasAttacked(resolvedRecords(attacks, seat), parsed)) {
      return { error: `${label} has already been attacked`, status: 409 };
    }
    // The row and the logs must agree on the open round; a stale row can never
    // record a shot into a round that already resolved.
    if (row.round !== expectedRound(attacks)) {
      return { error: "This round is out of sync; reload the match", status: 409 };
    }

    const [inserted] = await tx
      .insert(battleshipAttacks)
      .values({ matchId, round: row.round, seat, coordinate: label })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return { error: "Your attack is locked for this round", status: 409 };

    // A MANUAL attack resets the consecutive-timeout counter. The lifetime total
    // (`playerNTimeouts`) is deliberately left alone: it is history.
    if (seat === "player1" && row.player1ConsecutiveTimeouts !== 0) {
      await tx
        .update(battleshipMatches)
        .set({ player1ConsecutiveTimeouts: 0, updatedAt: new Date() })
        .where(eq(battleshipMatches.id, matchId));
    } else if (seat === "player2" && row.player2ConsecutiveTimeouts !== 0) {
      await tx
        .update(battleshipMatches)
        .set({ player2ConsecutiveTimeouts: 0, updatedAt: new Date() })
        .where(eq(battleshipMatches.id, matchId));
    }

    // PRACTICE: a bot round is pre-committed, so this is normally a no-op. It
    // exists for a row created before that rule, and for a crash between the
    // human's insert and the bot's: the bot must still have locked BEFORE the
    // round can resolve — and it chooses only from its own resolved history.
    let merged = [...attacks, inserted];
    if (row.isAi) {
      await ensureAiAttackTx(tx, row, row.round);
      merged = await attackRows(matchId, tx);
    }
    const locked = roundLocked(merged, row.round);
    if (!locked.player1 || !locked.player2) {
      // One lock. The round is NOT resolved and NOTHING is published: the other
      // player cannot learn this coordinate or its result.
      return asWaiting(await buildDto(row, seat, tx));
    }

    // ONE shared resolution path for a manual lock, an automatic lock and the
    // durable sweep — the engine call below is the only place a round resolves.
    const resolved = await resolveLockedRoundTx(tx, row, new Date());
    if ("error" in resolved) return resolved;
    return asResolved(await buildDto(resolved.updated, seat, tx), resolved.round);
  });
}

// ── Shared resolution core ────────────────────────────────────────────────

/**
 * Resolves the round whose two locks are both present. Called INSIDE a
 * transaction that already holds the match row lock, from the manual attack path
 * and from the timeout sweep alike, so a timeout round and a played round can
 * never diverge.
 */
async function resolveLockedRoundTx(
  tx: any,
  row: MatchRow,
  now: Date,
): Promise<{ updated: MatchRow; round: ServerRoundResult } | StoreError> {
  const attacks = await attackRows(row.id, tx);
  const fleets = await bothFleets(row.id, tx);
  if (!fleets) return { error: "Both fleets must be confirmed first", status: 409 };

  const state = buildMatchState({ round: row.round, fleets, attacks });
  if (!state) return { error: "The match state is unreadable", status: 409 };

  const submissions = {
    player1: String(attackForRound(attacks, row.round, "player1")?.coordinate),
    player2: String(attackForRound(attacks, row.round, "player2")?.coordinate),
  };
  const resolution = resolveRound(state, submissions);
  if (resolution.ok === false) {
    return { error: resolution.message, status: 409 };
  }

  // Both results are written in this same transaction — never one before the
  // other, never outside it.
  for (const shotSeat of SEATS) {
    const attack = resolution.round.attacks[shotSeat];
    await tx
      .update(battleshipAttacks)
      .set({ result: attack.result, ship: attack.ship })
      .where(
        and(
          eq(battleshipAttacks.matchId, row.id),
          eq(battleshipAttacks.round, row.round),
          eq(battleshipAttacks.seat, shotSeat),
        ),
      );
  }

  const finished = resolution.round.outcome !== null;
  const winnerId =
    resolution.state.winner === "player1"
      ? row.player1Id
      : resolution.state.winner === "player2"
        ? row.player2Id
        : null;

  const [updated] = await tx
    .update(battleshipMatches)
    .set({
      phase: finished ? MATCH_PHASE.FINISHED : MATCH_PHASE.COMBAT,
      round: resolution.state.round,
      roundDeadline: finished ? null : new Date(now.getTime() + ROUND_SECONDS * 1000),
      // Result and winner are the ENGINE's, never a client's.
      result: resolution.round.outcome ?? null,
      winnerId,
      endedAt: finished ? now : null,
      updatedAt: now,
    })
    // Conditional on the round AND the phase: a concurrent resolution of the
    // same round can never land twice, and a finished match cannot be revived.
    .where(
      and(
        eq(battleshipMatches.id, row.id),
        eq(battleshipMatches.round, row.round),
        eq(battleshipMatches.phase, MATCH_PHASE.COMBAT),
      ),
    )
    .returning();

  if (!updated) {
    return { error: "The round changed concurrently; retry the request", status: 409 };
  }

  if (finished) {
    await transitionMatchLifecycle({
      matchId: row.id,
      to: "completed",
      at: now,
      metadata: { result: resolution.round.outcome, rounds: resolution.round.round },
      tx,
    });
  }

  // A fleet destroyed by the engine ends the match HERE (not through the
  // timeout/disconnect path), so this is the other ranked-settlement entry
  // point. `settleRatedMatchTx` is idempotent and skips practice.
  if (finished) {
    await settleRatedMatchTx(tx, updated, resolution.state.winner);
  }

  // PRACTICE: the bot commits the NEXT round's shot as soon as this one is
  // stored, so its choice for that round predates the human's submission.
  if (row.isAi && !finished) {
    await commitAiAttackTx(tx, updated);
  }

  const sunkShips = SEATS.flatMap((shotSeat) => {
    const attack = resolution.round.attacks[shotSeat];
    return attack.result === SHOT_RESULTS.SUNK && attack.ship ? [String(attack.ship)] : [];
  });

  const automaticSeats = SEATS.filter(
    (shotSeat) => attackForRound(attacks, row.round, shotSeat)?.automatic === true,
  );

  return {
    updated,
    round: {
      round: resolution.round.round,
      attacks: resolution.round.attacks,
      destroyed: resolution.round.destroyed,
      sunkShips,
      automaticSeats,
      outcome: resolution.round.outcome,
      status: resolution.round.status,
      nextRound: finished ? null : resolution.state.round,
      roundDeadline: updated.roundDeadline ? updated.roundDeadline.toISOString() : null,
    },
  };
}

// ── Timeouts and recovery ─────────────────────────────────────────────────

/** One thing the timeout/disconnect paths did, for the caller to publish. */
export type TimeoutEvent =
  | { kind: "attack_timeout"; matchId: string; round: number; seats: Seat[] }
  | { kind: "round_resolved"; matchId: string; round: ServerRoundResult }
  | {
      kind: "forfeited";
      matchId: string;
      seat: Seat | null;
      reason: "placement_timeout" | "timeout_forfeit";
      cancelled: boolean;
    };

export interface SweepResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly resolved: number;
  readonly failed: number;
  readonly events: TimeoutEvent[];
}

/**
 * Gives every seat without a lock an automatic attack: one uniformly random cell
 * it has never fired at, chosen by `crypto.randomInt` inside
 * `pickTimeoutCoordinate`. The row is inserted with `automatic: true` and the
 * seat's total and consecutive counters move together.
 *
 * `onlySeat` restricts it to one seat (used by a late manual submission, which
 * materialises the ABSENT opponent's shot but keeps its own shot manual).
 */
async function applyAutoAttacksTx(
  tx: any,
  row: MatchRow,
  attacks: readonly PersistedAttack[],
  now: Date,
  randomInt: RandomInt,
  onlySeat?: Seat,
): Promise<{ seats: Seat[] }> {
  const seats: Seat[] = [];
  for (const seat of SEATS) {
    if (onlySeat && seat !== onlySeat) continue;
    if (attackForRound(attacks, row.round, seat)) continue;

    const attacked = resolvedRecords(attacks, seat).map((record) => record.coordinate);
    const coordinate = pickTimeoutCoordinate(attacked, randomInt);
    if (!coordinate) continue; // the board is exhausted — nothing legal to pick

    const [inserted] = await tx
      .insert(battleshipAttacks)
      .values({ matchId: row.id, round: row.round, seat, coordinate, automatic: true })
      .onConflictDoNothing()
      .returning();
    if (inserted) seats.push(seat);
  }

  if (seats.length > 0) {
    const set: Record<string, unknown> = { updatedAt: now };
    for (const seat of seats) {
      const isFirst = seat === "player1";
      set[isFirst ? "player1Timeouts" : "player2Timeouts"] =
        (isFirst ? row.player1Timeouts : row.player2Timeouts) + 1;
      set[isFirst ? "player1ConsecutiveTimeouts" : "player2ConsecutiveTimeouts"] =
        (isFirst ? row.player1ConsecutiveTimeouts : row.player2ConsecutiveTimeouts) + 1;
    }
    await tx.update(battleshipMatches).set(set as any).where(eq(battleshipMatches.id, row.id));
  }

  return { seats };
}

// ── Guest progression ─────────────────────────────────────────────────────
//
// Phase 2D. A signed-out visitor plays the bot as a `guest_<hex>` id
// (src/lib/auth/guestSession.ts) that owns no `users` row. Their finished
// practice match is recorded in the shared guest tables by the shared writer —
// never a local table, and never through the rated path below.

/**
 * A settled PRACTICE result, seen from the guest's own seat.
 *
 * Pure and exported so the mapping is tested directly instead of by grep. The
 * caller passes the winner the STORE resolved — the engine's `winner`, or the
 * seat named by a timeout/abandonment forfeit. `null` is the store's draw (both
 * fleets destroyed in one round, or both seats timing out); an unrecognised seat
 * maps to `null`, so an unknown outcome is never recorded as a draw.
 */
export function practiceOutcomeForSeat(
  winnerSeat: Seat | null,
  guestSeat: Seat,
): "win" | "loss" | "draw" | null {
  if (winnerSeat === null) return "draw";
  if (winnerSeat !== SEATS[0] && winnerSeat !== SEATS[1]) return null;
  return winnerSeat === guestSeat ? "win" : "loss";
}

/** The columns settlement reads. A locked match row always satisfies this. */
type PracticeSettlementRow = Pick<
  MatchRow,
  "id" | "player1Id" | "player2Id" | "aiDifficulty"
>;

/**
 * Records ONE guest practice result inside the caller's transaction.
 *
 * Every terminal path funnels through `settleRatedMatchTx`, so this runs exactly
 * once per completed practice match — after the match row and its result are
 * already written to FINISHED. Both inputs are server-side: the row was locked by
 * the caller and `winnerSeat` is the store's own verdict, so a client can never
 * submit a winner, a board or an outcome.
 *
 * Writes nothing unless a seat holds a guest id: a signed-in player's practice
 * match and a bot-vs-bot row both leave the table untouched, which is what keeps
 * account-based Battleship behaviour unchanged. The SAFE writer contains a
 * database failure, so progression can never un-finish a decided match.
 */
export async function settleGuestPracticeTx(
  tx: any,
  row: PracticeSettlementRow,
  winnerSeat: Seat | null,
): Promise<void> {
  // The identity comes from the ROW's seats, never from the caller.
  const guestId = [row.player1Id, row.player2Id].find(
    (id): id is string => Boolean(id) && isGuestId(id),
  );
  if (!guestId) return;

  const guestSeat: Seat = row.player1Id === guestId ? SEATS[0] : SEATS[1];
  const practiceResult = practiceOutcomeForSeat(winnerSeat, guestSeat);
  if (!practiceResult) return;

  await recordGuestPracticeResultSafely(tx, {
    guestId,
    // Canonical key from the guest writer's closed list — a constant, so the
    // guest vocabulary cannot drift from the game key this store settles under.
    gameKey: GUEST_PRACTICE_BATTLESHIP_GAME_KEY,
    matchId: String(row.id),
    result: practiceResult,
    aiDifficulty: row.aiDifficulty,
  });
}

/**
 * Terminal settlement for a COMPLETED match — the shared Elo and trophy writers,
 * inside the transaction that finalises the match. Never a second
 * implementation, and never for practice:
 *
 *   * `is_ai` rows record only the Phase 2D GUEST practice result (no rating, no
 *     trophy, no win counter) and return, so AI practice cannot touch a ladder;
 *   * a lobby with no second seat has no opponent to rate against;
 *   * `result: "draw"` uses the writers' own draw path (it moves Elo, awards no
 *     trophies, and is the deterministic outcome when both fleets are destroyed
 *     in one round or both seats time out);
 *   * both writers are (user, game, match)-keyed, so a retried or concurrent
 *     finalisation is a guaranteed no-op rather than a second rating change.
 *
 * Errors are swallowed exactly as every other game's `settleMatch` does: the
 * authoritative result is already committed, and a settlement failure must not
 * roll back or reject the match.
 */
async function settleRatedMatchTx(
  tx: any,
  row: MatchRow,
  winnerSeat: Seat | null,
): Promise<void> {
  // PRACTICE — and therefore the only place a guest can sit. One private
  // practice record, then the ranked path below is never entered.
  if (row.isAi) {
    await settleGuestPracticeTx(tx, row, winnerSeat);
    return;
  }
  if (!row.player2Id) return;
  const player1 = row.player1Id;
  const player2 = row.player2Id;
  const draw = winnerSeat === null;
  const winnerClerkId = draw || winnerSeat === "player1" ? player1 : player2;
  const loserClerkId = draw || winnerSeat === "player1" ? player2 : player1;
  const result = draw ? "draw" : "win";

  // The account W/L counters the profile and the classement page read. A draw
  // touches neither — the platform's own rule (`applyLeaderboardCounters` has no
  // draw branch), and the same one Dominoes and Tic-Tac-Toe follow.
  if (!draw) {
    await tx
      .update(users)
      .set({ gamesWon: sql`${users.gamesWon} + 1` })
      .where(eq(users.clerkId, winnerClerkId));
    await tx
      .update(users)
      .set({ gamesLost: sql`${users.gamesLost} + 1` })
      .where(eq(users.clerkId, loserClerkId));
  }

  await applyRatingResult({
    tx,
    gameKey: "battleship",
    matchId: row.id,
    winnerClerkId,
    loserClerkId,
    result,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "battleship",
    matchId: row.id,
    winnerClerkId,
    loserClerkId,
    result,
  }).catch(() => {});
}

/** Ends a match in favour of `winnerSeat`. Idempotent: null when it was already over. */
async function finishMatchTx(
  tx: any,
  row: MatchRow,
  winnerSeat: Seat,
  reason: "placement_timeout" | "timeout_forfeit" | "abandoned",
  now: Date,
): Promise<MatchRow | null> {
  const [updated] = await tx
    .update(battleshipMatches)
    .set({
      phase: MATCH_PHASE.FINISHED,
      result: winnerSeat,
      winnerId: winnerSeat === "player1" ? row.player1Id : row.player2Id,
      roundDeadline: null,
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(battleshipMatches.id, row.id),
        inArray(battleshipMatches.phase, [MATCH_PHASE.PLACEMENT, MATCH_PHASE.COMBAT]),
      ),
    )
    .returning();
  if (!updated) return null;

  await transitionMatchLifecycle({
    matchId: row.id,
    to: "completed",
    at: now,
    metadata: { reason, result: winnerSeat },
    tx,
  });
  // Ranked settlement (practice and lobbies are excluded inside the helper).
  await settleRatedMatchTx(tx, updated, winnerSeat);
  return updated;
}

/** Both seats timed out: a deterministic draw, never an invented winner. */
async function drawMatchTx(
  tx: any,
  row: MatchRow,
  reason: "timeout_forfeit",
  now: Date,
): Promise<MatchRow | null> {
  const [updated] = await tx
    .update(battleshipMatches)
    .set({
      phase: MATCH_PHASE.FINISHED,
      result: "draw",
      winnerId: null,
      roundDeadline: null,
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(battleshipMatches.id, row.id),
        inArray(battleshipMatches.phase, [MATCH_PHASE.PLACEMENT, MATCH_PHASE.COMBAT]),
      ),
    )
    .returning();
  if (!updated) return null;

  await transitionMatchLifecycle({
    matchId: row.id,
    to: "completed",
    at: now,
    metadata: { reason, result: "draw" },
    tx,
  });
  // A draw still settles through the shared writers (0 trophies, Elo draw).
  await settleRatedMatchTx(tx, updated, null);
  return updated;
}

/** Releases a lobby nobody is waiting in. */
async function cancelLobbyTx(
  tx: any,
  row: MatchRow,
  cancelReason: "timeout" | "player_disconnected",
  now: Date,
): Promise<MatchRow | null> {
  const [updated] = await tx
    .update(battleshipMatches)
    .set({ phase: MATCH_PHASE.CANCELLED, endedAt: now, updatedAt: now })
    .where(
      and(eq(battleshipMatches.id, row.id), eq(battleshipMatches.phase, MATCH_PHASE.WAITING)),
    )
    .returning();
  if (!updated) return null;

  await transitionMatchLifecycle({ matchId: row.id, to: "cancelled", cancelReason, at: now, tx });
  return updated;
}

/**
 * Settles ONE match whose deadline passed. Takes the row lock first and
 * RE-CHECKS the deadline inside it, so a sweep and a live request can never both
 * apply the same timeout, and a restart merely means the next call does the work.
 *
 * Placement: a missing fleet forfeits; two missing fleets cancel the match.
 * Combat: every missing lock becomes an automatic attack; two consecutive
 * automatic attacks forfeit (both seats at the threshold is a draw); otherwise
 * the round resolves through the shared engine path.
 */
export async function resolveDueTimeouts({
  matchId,
  now = new Date(),
  randomInt = serverRandomInt,
}: {
  matchId: string;
  now?: Date;
  randomInt?: RandomInt;
}): Promise<{ events: TimeoutEvent[] } | StoreError> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(battleshipMatches)
      .where(eq(battleshipMatches.id, matchId))
      .for("update");
    if (!row) return { error: "Match not found", status: 404 };

    const events: TimeoutEvent[] = [];

    if (row.phase === MATCH_PHASE.PLACEMENT) {
      if (!row.placementDeadline || row.placementDeadline > now) return { events };
      const verdict = placementTimeoutVerdict({
        player1: row.player1Ready,
        player2: row.player2Ready,
      });
      if (verdict.action === "none") return { events };

      if (verdict.action === "cancel") {
        const cancelled = await cancelLobbyTx(tx, row, "timeout", now);
        if (cancelled) {
          events.push({
            kind: "forfeited",
            matchId,
            seat: null,
            reason: "placement_timeout",
            cancelled: true,
          });
        }
        return { events };
      }

      const winner = otherSeat(verdict.seat);
      const updated = await finishMatchTx(tx, row, winner, "placement_timeout", now);
      if (updated) {
        events.push({
          kind: "forfeited",
          matchId,
          seat: winner,
          reason: "placement_timeout",
          cancelled: false,
        });
      }
      return { events };
    }

    if (row.phase !== MATCH_PHASE.COMBAT) return { events };
    if (!row.roundDeadline || row.roundDeadline > now) return { events };

    const attacks = await attackRows(matchId, tx);
    const auto = await applyAutoAttacksTx(tx, row, attacks, now, randomInt);
    if (auto.seats.length > 0) {
      events.push({ kind: "attack_timeout", matchId, round: row.round, seats: auto.seats });
    }

    const consecutive = {
      player1: row.player1ConsecutiveTimeouts + (auto.seats.includes("player1") ? 1 : 0),
      player2: row.player2ConsecutiveTimeouts + (auto.seats.includes("player2") ? 1 : 0),
    };
    const forfeiting = timeoutForfeitSeats(consecutive);

    if (forfeiting.length === 2) {
      const updated = await drawMatchTx(tx, row, "timeout_forfeit", now);
      if (updated) {
        events.push({
          kind: "forfeited",
          matchId,
          seat: null,
          reason: "timeout_forfeit",
          cancelled: false,
        });
      }
      return { events };
    }
    if (forfeiting.length === 1) {
      const winner = otherSeat(forfeiting[0]);
      const updated = await finishMatchTx(tx, row, winner, "timeout_forfeit", now);
      if (updated) {
        events.push({
          kind: "forfeited",
          matchId,
          seat: winner,
          reason: "timeout_forfeit",
          cancelled: false,
        });
      }
      return { events };
    }

    const resolved = await resolveLockedRoundTx(tx, row, now);
    if ("error" in resolved) return { events };
    events.push({ kind: "round_resolved", matchId, round: resolved.round });
    return { events };
  });
}

/**
 * DURABLE sweep: the scheduled job calls this, and it is entirely database
 * driven — no in-memory timer, no per-match scheduler. Every overdue row it
 * finds is settled under its own row lock, so a restart between two runs simply
 * means the next run finishes the work.
 */
export async function sweepBattleshipTimeouts({
  now = new Date(),
}: { now?: Date } = {}): Promise<SweepResult> {
  const due = await db
    .select({ id: battleshipMatches.id })
    .from(battleshipMatches)
    .where(
      and(
        inArray(battleshipMatches.phase, [MATCH_PHASE.PLACEMENT, MATCH_PHASE.COMBAT]),
        or(
          and(
            eq(battleshipMatches.phase, MATCH_PHASE.PLACEMENT),
            isNotNull(battleshipMatches.placementDeadline),
            lte(battleshipMatches.placementDeadline, now),
          ),
          and(
            eq(battleshipMatches.phase, MATCH_PHASE.COMBAT),
            isNotNull(battleshipMatches.roundDeadline),
            lte(battleshipMatches.roundDeadline, now),
          ),
        ),
      ),
    )
    .orderBy(asc(battleshipMatches.createdAt))
    .limit(200);

  const events: TimeoutEvent[] = [];
  let resolved = 0;
  let failed = 0;

  for (const candidate of due) {
    try {
      const outcome = await resolveDueTimeouts({ matchId: candidate.id, now });
      if ("error" in outcome) {
        failed += 1;
        continue;
      }
      if (outcome.events.length > 0) resolved += 1;
      events.push(...outcome.events);
    } catch (error) {
      failed += 1;
      console.warn(
        "[battleship] timeout sweep failed:",
        candidate.id,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { ok: failed === 0, checked: due.length, resolved, failed, events };
}

/** Lazy recovery on a read: settle this match if a deadline passed while down. */
async function settleIfOverdue(row: MatchRow): Promise<TimeoutEvent[]> {
  const now = new Date();
  const placementDue =
    row.phase === MATCH_PHASE.PLACEMENT &&
    row.placementDeadline !== null &&
    row.placementDeadline <= now;
  const combatDue =
    row.phase === MATCH_PHASE.COMBAT &&
    row.roundDeadline !== null &&
    row.roundDeadline <= now;
  if (!placementDue && !combatDue) return [];

  const outcome = await resolveDueTimeouts({ matchId: row.id, now });
  return "error" in outcome ? [] : outcome.events;
}

/** Re-read one row (after a lazy settlement changed it). */
async function readMatchRow(matchId: string): Promise<MatchRow | null> {
  const [row] = await db
    .select()
    .from(battleshipMatches)
    .where(eq(battleshipMatches.id, matchId))
    .limit(1);
  return row ?? null;
}

// ── Disconnect ────────────────────────────────────────────────────────────

export type DisconnectResult =
  | { match: MatchRow; forfeited: boolean; cancelled: boolean }
  | StoreError;

/**
 * Resolves a participant who stayed away past the realtime grace window.
 *
 * The route verifies that player's Clerk token first, so this can only ever act
 * on the caller's OWN match. Conventions are the platform's: an open lobby is
 * cancelled, a live match is forfeited to the seat still present, and a terminal
 * match is a reported no-op so the realtime retry loop stops.
 *
 * NOTHING about the match state is rewritten: the round, both fleets and the
 * resolved attack log stay exactly as they were, so a reconnect inside the
 * window finds the same board.
 */
export async function forfeitMatchOnDisconnect({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}): Promise<DisconnectResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(battleshipMatches)
      .where(eq(battleshipMatches.id, matchId))
      .for("update");
    if (!row) return { error: "Match not found", status: 404 };

    const access = requireSeat(row, userId);
    if (access.ok === false) return { error: access.message, status: access.status };

    if (row.phase === MATCH_PHASE.FINISHED || row.phase === MATCH_PHASE.CANCELLED) {
      return { match: row, forfeited: false, cancelled: false };
    }

    const now = new Date();
    if (row.phase === MATCH_PHASE.WAITING || !row.player2Id) {
      const cancelled = await cancelLobbyTx(tx, row, "player_disconnected", now);
      return { match: cancelled ?? row, forfeited: false, cancelled: true };
    }

    const winner = otherSeat(access.seat);
    const updated = await finishMatchTx(tx, row, winner, "abandoned", now);
    return { match: updated ?? row, forfeited: updated !== null, cancelled: false };
  });
}

// ── Practice vs the built-in bot ──────────────────────────────────────────
//
// A practice match is an ordinary match row with the bot in seat 2 (`is_ai`),
// not a second game mode. That is what lets it reuse EVERY rule Phase 3–5
// established: the same fleet validation, the same simultaneous round
// resolution, the same timeout sweep and the same per-seat privacy projection.
//
// It differs in exactly three places, each of them visible below:
//   1. creation seats the bot and deals its fleet server-side, so the row never
//      waits in the lobby pool and can never be joined or matched;
//   2. the bot LOCK-PRECOMMITS its next shot as soon as a round resolves (and at
//      combat start), which is how its choice precedes the human's;
//   3. it carries no ranked lifecycle: mode `practice`, and nothing on this path
//      touches ratings, trophies, win counters or matchmaking.

/** How a practice match is created: the caller plus the validated tier. */
export type CreateAiMatchResult =
  | { match: MatchRow; difficulty: AiDifficulty }
  | StoreError;

/**
 * Opens a free practice match against the bot.
 *
 * UNRATED BY CONSTRUCTION: this module imports no rating, trophy, payout or
 * queue writer, so there is no code path from an `is_ai` row to a ranked
 * settlement. The bot's fleet comes from the SAME engine dealer humans use
 * (`generateRandomFleet`) and is stored like any other fleet — which means the
 * existing projection (own seat only) hides it from the human for free.
 *
 * There is deliberately no placement deadline: practice forfeits nothing, so the
 * human may take as long as they like over their fleet.
 */
export async function createAiMatch({
  userId,
  difficulty,
  random = Math.random,
}: {
  userId: string;
  difficulty?: unknown;
  random?: () => number;
}): Promise<CreateAiMatchResult> {
  if (!userId) return { error: "Unauthenticated", status: 401 };
  const tier = coerceAiDifficulty(difficulty ?? DEFAULT_AI_DIFFICULTY);

  return db.transaction(async (tx) => {
    const now = new Date();
    const fleet = generateRandomFleet(random);

    const [match] = await tx
      .insert(battleshipMatches)
      .values({
        player1Id: userId,
        player2Id: BATTLESHIP_AI_PLAYER_ID,
        phase: MATCH_PHASE.PLACEMENT,
        isAi: true,
        aiDifficulty: tier,
        // The bot's fleet is already confirmed, so only the human places ships.
        player2Ready: true,
        startedAt: now,
        updatedAt: now,
      })
      .returning();

    if (!match) return { error: "Could not create the practice match", status: 500 };

    await tx.insert(battleshipFleets).values({
      matchId: match.id,
      seat: "player2",
      placement: serializeFleet(fleet),
      confirmedAt: now,
    });

    // Canonical lifecycle, marked `practice` so nothing can mistake it for a
    // ranked queue entry. The bot is present immediately, so the row starts.
    //
    // `queuedAt: now` is REQUIRED, not cosmetic: the helper defaults it to
    // `new Date()`, which is LATER than the `now` captured above — so the
    // `forming`/`ready`/`started` transitions below would carry an earlier
    // `started_at` than `queued_at`. The canonical lifecycle rejects that
    // ordering (`calculateQueueWaitMs` throws "Queue lifecycle timestamps are
    // out of order"), which rolled the whole practice match back as a 500.
    await createMatchLifecycle({
      matchId: match.id,
      gameKey: GAME_KEY,
      mode: "practice",
      playerCount: 2,
      queuedAt: now,
      tx,
    });
    await transitionMatchLifecycle({ matchId: match.id, to: "forming", playerCount: 2, at: now, tx });
    await transitionMatchLifecycle({ matchId: match.id, to: "ready", playerCount: 2, at: now, tx });
    await transitionMatchLifecycle({ matchId: match.id, to: "started", playerCount: 2, at: now, tx });

    return { match, difficulty: tier };
  });
}

/**
 * Locks the bot's shot for `round` if it has not locked one yet.
 *
 * THE bot gets NO extra information: `chooseAiAttack` receives only the bot's own
 * resolved attack log (what a player in that seat can see), plus injectable
 * randomness. Its row is an ordinary `battleship_attacks` entry with `result`
 * NULL, so the human snapshot exposes nothing but "opponent locked".
 */
async function commitAiAttackForRoundTx(
  tx: any,
  row: MatchRow,
  round: number,
): Promise<boolean> {
  const attacks = await attackRows(row.id, tx);
  if (attackForRound(attacks, round, "player2")) return true;

  const coordinate = chooseAiAttack({
    difficulty: row.aiDifficulty ?? DEFAULT_AI_DIFFICULTY,
    attacks: resolvedRecords(attacks, "player2"),
  });
  if (!coordinate) return false;

  const [inserted] = await tx
    .insert(battleshipAttacks)
    .values({ matchId: row.id, round, seat: "player2", coordinate })
    .onConflictDoNothing()
    .returning();
  return Boolean(inserted);
}

/** Commits the bot's shot for the row's currently open round. */
async function commitAiAttackTx(tx: any, row: MatchRow): Promise<boolean> {
  return commitAiAttackForRoundTx(tx, row, row.round);
}

/** Safety net: makes sure the bot is locked for `round` before resolution. */
async function ensureAiAttackTx(tx: any, row: MatchRow, round: number): Promise<void> {
  const attacks = await attackRows(row.id, tx);
  if (attackForRound(attacks, round, "player2")) return;
  await commitAiAttackForRoundTx(tx, row, round);
}

