// src/lib/hillstrike/serverStore.ts
//
// The server-authoritative Hillstrike online 1v1 match store. Every state
// transition happens inside a row-locked `db.transaction` here; the API routes
// are thin wrappers around these functions.
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The ONLY player-authored values that reach this module are the AIM INPUT
// (`{ angleDeg, power }`) and the optimistic-concurrency token
// `expectedVersion`. The trajectory, the collision point and kind, the crater,
// both towers, both lives, whose turn it is, the shots remaining in the volley,
// the winner and the match result are ALL computed from the server's own
// authoritative state by the shared engine (`validateShot` → `applyShot` →
// `simulateShot`). A client cannot submit a board, a hit, a damage amount, a
// life count, a terrain height, a winner, a result or a completion flag — no
// such field is ever read.
//
// ── CONCURRENCY ──────────────────────────────────────────────────────────
//
//   1. every mutation takes the match row with `FOR UPDATE`, so two concurrent
//      shot requests on one match serialise; the second re-reads the row, sees
//      the ply/version the first one wrote, and is rejected as stale;
//   2. `submitShot()` additionally checks `expectedVersion` against the
//      authoritative `ply` INSIDE that lock, so a double-submitted or stale-tab
//      shot is a clean 409 rather than a second shot;
//   3. `hillstrike_shots` has a unique (match_id, action_index) index, the
//      storage-level backstop that makes "one persisted shot per action index"
//      impossible to violate even if a future code path forgets the check;
//   4. matchmaking runs under one per-game advisory lock
//      (`pg_advisory_xact_lock`) plus a conditional UPDATE, so two callers can
//      never both open a lobby and a caller can never join a lobby that is being
//      cancelled.
//
// ── SETTLEMENT ───────────────────────────────────────────────────────────
//
// A finished match is finalised EXACTLY ONCE: the terminal write is claimed with
// a conditional UPDATE (`status = 'playing'`), so the loser of a concurrent race
// is a no-op instead of a second settlement. The same transaction then settles
// competitive progression through the shared writers (`applyRatingResult` /
// `applyTrophyResult`), which are journal-keyed per (user, game, match) — so a
// retry, a reconnect or a duplicate completion event can never apply a reward
// twice. See `settleMatch`.
//
// Online Hillstrike is UNSTAKED: no wager is taken and no pot is paid. Only Elo,
// trophies and the account W/L counters move.
//
// AI PRACTICE IS A DIFFERENT PROGRAM. The vs-AI board
// (src/app/casino/hillstrike/play-ai) runs entirely in the browser against
// src/lib/hillstrike/ai.ts: it has no match row, no socket and no API call, so it
// can never reach `settleMatch` and can never move Elo or a trophy.

import { randomInt } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { hillstrikeMatches, hillstrikeShots, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import {
  END_REASONS,
  HILLSTRIKE_LOCK_NAMESPACE,
  MATCH_STATUS,
  REJECTION,
} from "./constants";
import { applyShot, createInitialState, otherSeat, validateShot } from "./rules";
import type { HillstrikeState, Seat, ShotInput, ShotRecord } from "./types";

/** The two seats of a row: `player2Id` is null while the row is an open lobby. */
export type Seats = { player1Id: string; player2Id: string | null };

type MatchRow = typeof hillstrikeMatches.$inferSelect;

/**
 * Structural view of the engine's verdict.
 *
 * The engine returns a discriminated union (`{ ok: true }` /
 * `{ ok: false, code, message }`), but this repo compiles with `strict: false`,
 * where narrowing that union on its boolean literal discriminant does not work —
 * so the store reads the verdict through this widened shape instead.
 */
type ShotVerdictWide = {
  ok: boolean;
  code?: string;
  message?: string;
};

export type StoreError = { error: string; status: number; code?: string };

/**
 * Result of resolving a disconnected participant.
 *
 * Spelled as an explicit union (like the Barricade store) rather than inferred:
 * the route narrows it with `"error" in result`, and this repo compiles with
 * `strict: false`, where an INFERRED union of structurally similar object
 * literals collapses and the narrowing branch becomes `never`.
 */
export type DisconnectResult =
  | { match: MatchRow; forfeited: boolean; cancelled: boolean }
  | StoreError;

/** Route-level guard so a non-UUID id can never reach a Postgres uuid cast. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMatchId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Postgres unique-violation, however the driver nested it. */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The match's battlefield seed, drawn once by the SERVER.
 *
 * `randomInt` is CSPRNG-backed, so a player cannot predict or steer the next
 * layout, and the 32-bit range is exactly what the engine's `assertSeed`
 * accepts. The seed is stored on the row, which is what makes the generated
 * battlefield reproducible forever.
 */
export function drawSeed(): number {
  return randomInt(0, 0x100000000);
}

/** Seat→user-id mapping from a row. */
export function seatsFromRow(match: {
  player1Id: string;
  player2Id?: string | null;
}): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}

/**
 * Which seat (if any) a caller occupies.
 *
 * Seat resolution is by user id ONLY. There is no "first come" fallback and no
 * guest seat: an unrelated signed-in user resolves to no seat and gets a 403, so
 * one player can never act on another player's match.
 */
export function seatForUser(seats: Seats, userId: string | null | undefined): Seat | null {
  if (!userId) return null;
  if (seats.player1Id === userId) return "player1";
  if (seats.player2Id && seats.player2Id === userId) return "player2";
  return null;
}

/** True when `userId` occupies either seat. */
export function isParticipant(
  match: { player1Id: string; player2Id?: string | null },
  userId: string | null,
): boolean {
  return Boolean(seatForUser(seatsFromRow(match), userId));
}

/** Seat → user id, or null for an empty seat. */
export function userIdForSeat(seats: Seats, seat: Seat | null): string | null {
  if (!seat) return null;
  return seat === "player1" ? seats.player1Id : seats.player2Id ?? null;
}

/** The persisted authoritative position of a row. */
export function stateOf(match: MatchRow): HillstrikeState {
  return match.gameState as HillstrikeState;
}

/** The status a live row should carry, derived from the engine's own state. */
export function statusForState(state: HillstrikeState): string {
  return state.status === MATCH_STATUS.FINISHED
    ? MATCH_STATUS.FINISHED
    : MATCH_STATUS.PLAYING;
}

/**
 * Client-facing snapshot for `viewerId`.
 *
 * Hillstrike is perfect information, so the whole position is published — both
 * positions, both lives, the terrain, both towers, the volley counters and the
 * last resolved shot (which is what a client animates). Nothing here is
 * client-authoritative: every field is read off the row the engine wrote.
 */
export function matchToDto(match: MatchRow, viewerId: string | null) {
  const state = stateOf(match);
  const seats = seatsFromRow(match);
  const viewerSeat = seatForUser(seats, viewerId);
  // Nobody owns the turn until the match is actually live: an open lobby's state
  // already names the opening seat, but no shot can be fired against it.
  const activeSeat: Seat | null =
    match.status === MATCH_STATUS.PLAYING ? state.turn : null;
  const activeUserId = userIdForSeat(seats, activeSeat);

  return {
    matchId: match.id,
    status: match.status,
    // Monotonic accepted-shot count — the optimistic-concurrency version the
    // client echoes back as `expectedVersion`.
    version: match.ply,
    ply: match.ply,
    // The layout: what was dealt, and under which rules version.
    seed: Number(match.seed),
    fieldVersion: match.fieldVersion,
    openingSeat: match.openingSeat,
    initialBattlefield: match.initialBattlefield ?? null,
    /** The authoritative position (see src/lib/hillstrike/rules.ts). */
    gameState: state,
    turn: state.turn,
    turnUserId: activeUserId,
    turnIndex: state.turnIndex,
    shotsRemaining: state.shotsRemaining,
    openingShotPending: state.openingShotPending,
    lives: state.lives,
    // Viewer projection: whose seat the caller holds and whether it is theirs to
    // play. Derived on the server so the client never has to decide it.
    viewerSeat,
    opponentSeat: viewerSeat ? otherSeat(viewerSeat) : null,
    isViewerTurn:
      Boolean(viewerSeat) &&
      match.status === MATCH_STATUS.PLAYING &&
      state.turn === viewerSeat,
    isLive: match.status === MATCH_STATUS.PLAYING,
    // Terminal fields — the ONLY source of the result screen.
    result: match.result ?? null,
    winnerSeat: match.result ?? null,
    winnerId: match.winnerId ?? null,
    resultReason: match.resultReason ?? null,
    player1Id: match.player1Id,
    player2Id: match.player2Id ?? null,
    startedAt: match.startedAt ?? null,
    endedAt: match.endedAt ?? null,
  };
}

// ── Lobby / matchmaking ──────────────────────────────────────────────────

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(hillstrikeMatches)
    .where(
      and(
        eq(hillstrikeMatches.status, MATCH_STATUS.WAITING),
        isNull(hillstrikeMatches.player2Id),
      ),
    )
    .orderBy(sql`${hillstrikeMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any (the lobby's "resume" row). */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(hillstrikeMatches)
    .where(
      and(
        eq(hillstrikeMatches.status, MATCH_STATUS.WAITING),
        isNull(hillstrikeMatches.player2Id),
        eq(hillstrikeMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${hillstrikeMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * Match the caller into the oldest open lobby, or open a new one.
 *
 * Runs entirely under one advisory lock (per-game namespace), so two concurrent
 * callers can never both see "no open lobby" and each create one, and a caller
 * can never join a lobby that is being cancelled at the same moment.
 *
 * Hillstrike is unstaked, so there is no stake matching here: every open lobby is
 * joinable. The seed (and therefore the battlefield and the opening seat) is
 * drawn when the LOBBY is created, so both seats see the same ground from the
 * moment the second one arrives, and the host is not left staring at a blank
 * board.
 */
export async function createOrJoin({ userId }: { userId: string }) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${HILLSTRIKE_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(hillstrikeMatches)
      .where(
        and(
          eq(hillstrikeMatches.status, MATCH_STATUS.WAITING),
          isNull(hillstrikeMatches.player2Id),
        ),
      )
      .orderBy(sql`${hillstrikeMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // Already the caller's own lobby — hand it back instead of opening a
      // second one (and never seat the creator against themselves).
      if (open.player1Id === userId) return { match: open, joined: false } as const;
      return await joinExistingMatch(tx, open.id, userId);
    }

    return await createWaitingMatch(tx, userId);
  });
}

async function createWaitingMatch(tx: any, userId: string) {
  // The battlefield is generated here, once, from a server-drawn seed: both
  // seats play the same layout no matter when the second one joins, and the
  // opening seat is the seed's deterministic draw (recorded on the state).
  const seed = drawSeed();
  const state = createInitialState({ seed });

  const [match] = await tx
    .insert(hillstrikeMatches)
    .values({
      player1Id: userId,
      // No opponent yet: the row IS the open lobby.
      player2Id: null,
      status: MATCH_STATUS.WAITING,
      ply: 0,
      seed,
      fieldVersion: state.fieldVersion,
      openingSeat: state.openingSeat,
      initialBattlefield: state.battlefield,
      gameState: state,
      // Nobody can act yet, so no turn owner is named.
      currentTurnUserId: null,
    })
    .returning();

  return { match, joined: false } as const;
}

async function joinExistingMatch(tx: any, candidateId: string, userId: string) {
  const [match] = await tx
    .select()
    .from(hillstrikeMatches)
    .where(eq(hillstrikeMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }
  if (match.player1Id === userId) {
    return { error: "You already host this lobby", status: 409 } as const;
  }

  // The lobby's state never advances (a waiting match accepts no shots), so the
  // persisted position is already the opening one the engine generated.
  const state = stateOf(match);
  const seats: Seats = { player1Id: match.player1Id, player2Id: userId };

  // Straight to `playing`: the opening seat can fire the moment the second seat
  // lands, exactly as the engine's volley state machine describes.
  const [updated] = await tx
    .update(hillstrikeMatches)
    .set({
      player2Id: userId,
      status: statusForState(state),
      ply: state.turnIndex,
      gameState: state,
      currentTurnUserId: userIdForSeat(seats, state.turn),
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(hillstrikeMatches.id, candidateId),
        eq(hillstrikeMatches.status, MATCH_STATUS.WAITING),
        isNull(hillstrikeMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  return { match: updated, joined: true } as const;
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * The authoritative snapshot for the calling participant.
 *
 * A non-participant gets a 403 — Hillstrike online has no spectator mode, so one
 * player can never read (or act on) another player's match. There is no clock and
 * no deadline to resolve, so a read can never change the state; this is also the
 * RECONNECT path.
 */
export async function fetchMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  const [match] = await db
    .select()
    .from(hillstrikeMatches)
    .where(eq(hillstrikeMatches.id, matchId));

  if (!match) return { error: "Match not found", status: 404 } as const;

  const seats = seatsFromRow(match);
  if (!seatForUser(seats, userId)) {
    return { error: "Not a participant of this match", status: 403 } as const;
  }

  return { match, dto: matchToDto(match, userId) } as const;
}

/** The append-only shot log for a match, oldest first. */
export async function fetchMatchShots(matchId: string) {
  return await db
    .select({
      actionIndex: hillstrikeShots.actionIndex,
      playerId: hillstrikeShots.playerId,
      seat: hillstrikeShots.seat,
      angleDeg: hillstrikeShots.angleDeg,
      power: hillstrikeShots.power,
      impactKind: hillstrikeShots.impactKind,
      impactX: hillstrikeShots.impactX,
      impactY: hillstrikeShots.impactY,
      targetSeat: hillstrikeShots.targetSeat,
      livesLost: hillstrikeShots.livesLost,
      createdAt: hillstrikeShots.createdAt,
    })
    .from(hillstrikeShots)
    .where(eq(hillstrikeShots.matchId, matchId))
    .orderBy(sql`${hillstrikeShots.actionIndex} ASC`);
}

// ── The shot (the only gameplay mutation) ────────────────────────────────

export type ShotResult =
  | {
      match: MatchRow;
      state: HillstrikeState;
      /** The server-resolved shot, exactly as recorded on the state. */
      shot: ShotRecord;
      /** The action index (the ply) this shot consumed. */
      actionIndex: number;
      matchCompleted: boolean;
      winnerSeat: Seat | null;
      reason: string | null;
    }
  | StoreError;

/**
 * Rejection code → HTTP status.
 *
 * Shape/bounds errors are 400 (the client sent something that is not a shot);
 * everything the engine refuses about the POSITION or the turn is a 409 (the
 * caller's view is stale).
 */
function statusForRejection(code: string): number {
  switch (code) {
    case REJECTION.INVALID_SHOT:
    case REJECTION.INVALID_SEAT:
    case REJECTION.ANGLE_INVALID:
    case REJECTION.POWER_INVALID:
      return 400;
    default:
      return 409;
  }
}

/**
 * Fire one shot.
 *
 * The request carries ONLY the aim plus `expectedVersion`. Rejections, in order:
 *
 *   404 match not found
 *   403 caller holds no seat                (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   400 a missing / unusable `expectedVersion`
 *   409 stale `expectedVersion` (double submit / stale tab)
 *   409 it is not the caller's turn
 *   409 no shots left in this volley
 *   400 malformed aim (angle not in [0, 360), power not an integer 0…100)
 *   409 the engine refuses the shot
 *
 * `validateShot` then `applyShot` run inside the same row-locked transaction as
 * the write, so nothing about the shot's outcome is trusted from the request and
 * no two requests can consume the same action index.
 */
export async function submitShot({
  userId,
  matchId,
  shot,
  expectedVersion,
}: {
  userId: string;
  matchId: string;
  shot: unknown;
  expectedVersion: unknown;
}): Promise<ShotResult> {
  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(hillstrikeMatches)
        .where(eq(hillstrikeMatches.id, matchId))
        .for("update");

      if (!match) return { error: "Match not found", status: 404 } as const;

      const seats = seatsFromRow(match);
      const seat = seatForUser(seats, userId);
      if (!seat) {
        return { error: "Not a participant of this match", status: 403 } as const;
      }
      if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
        return { error: "Waiting for an opponent", status: 409 } as const;
      }
      if (
        match.status === MATCH_STATUS.FINISHED ||
        match.status === MATCH_STATUS.CANCELLED
      ) {
        return { error: "Match is no longer active", status: 409 } as const;
      }

      // Optimistic concurrency. Unlike an address-shaped action, a shot cannot be
      // re-derived from the board, so the version is REQUIRED: a request that
      // omits it is malformed (400) rather than silently accepted.
      if (expectedVersion === undefined || expectedVersion === null) {
        return {
          error: "expectedVersion is required",
          status: 400,
          code: REJECTION.INVALID_SHOT,
        } as const;
      }
      // A version is a NUMBER: a boolean, a numeric string or a fraction is a
      // malformed request, not a stale view, so it is refused as a 400.
      if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
        return {
          error: "expectedVersion must be an integer",
          status: 400,
          code: REJECTION.INVALID_SHOT,
        } as const;
      }
      if (expectedVersion !== match.ply) {
        return {
          error: "Stale match state — this shot was resolved against an older position",
          status: 409,
        } as const;
      }

      const state = stateOf(match);

      // The engine's own verdict: seat, lifecycle, turn, volley budget, and the
      // aim's shape. A malformed aim is refused, never repaired.
      const verdict = validateShot(state, seat, shot) as ShotVerdictWide;
      if (!verdict.ok) {
        const code = verdict.code ?? REJECTION.INVALID_SHOT;
        return {
          error: verdict.message ?? "That shot is not legal here",
          status: statusForRejection(code),
          code,
        } as StoreError;
      }

      // The engine resolves the whole shot (trajectory, collision, crater,
      // collapse, life). It re-validates internally, so the verdict above and
      // this call can never disagree.
      const applied = applyShot(state, seat, shot as ShotInput);
      const next = applied.state;
      const record = next.lastShot as ShotRecord;
      const actionIndex = state.turnIndex;

      // Append-only log: the exact aim the server validated plus the outcome it
      // resolved. The unique (match_id, action_index) index rejects a duplicate
      // action index structurally.
      await tx.insert(hillstrikeShots).values({
        matchId: match.id,
        actionIndex,
        playerId: userId,
        seat,
        angleDeg: record.shot.angleDeg,
        power: record.shot.power,
        impactKind: record.impact.kind,
        impactX: record.impact.x,
        impactY: record.impact.y,
        targetSeat: record.impact.target,
        livesLost: record.livesLost,
        outcome: {
          impact: record.impact,
          livesLost: record.livesLost,
          lives: next.lives,
          status: next.status,
          winner: next.winner,
          terminationReason: next.terminationReason,
          turn: next.turn,
          shotsRemaining: next.shotsRemaining,
          openingShotPending: next.openingShotPending,
          turnIndex: next.turnIndex,
        },
      });

      const finished = next.status === MATCH_STATUS.FINISHED;
      const winnerSeat: Seat | null = next.winner ?? null;

      const updates: Partial<typeof hillstrikeMatches.$inferInsert> = {
        gameState: next,
        ply: next.turnIndex,
        currentTurnUserId: userIdForSeat(seats, next.turn),
        status: finished ? MATCH_STATUS.FINISHED : statusForState(next),
        updatedAt: new Date(),
      };

      if (finished) {
        updates.result = winnerSeat;
        updates.winnerId = winnerSeat ? userIdForSeat(seats, winnerSeat) : null;
        updates.resultReason = next.terminationReason ?? END_REASONS.LIVES_EXHAUSTED;
        updates.endedAt = new Date();
      }

      // The version guard: with the row lock this is belt-and-braces, and it
      // documents that exactly one transaction may consume action index `ply`.
      const [updated] = await tx
        .update(hillstrikeMatches)
        .set(updates)
        .where(
          and(
            eq(hillstrikeMatches.id, match.id),
            eq(hillstrikeMatches.ply, match.ply),
          ),
        )
        .returning();

      if (!updated) {
        return { error: "Match state changed — please retry", status: 409 } as const;
      }

      if (finished) {
        await settleMatch(tx, match, {
          result: winnerSeat,
          reason: next.terminationReason ?? END_REASONS.LIVES_EXHAUSTED,
        });
      }

      return {
        match: updated,
        state: next,
        shot: record,
        actionIndex,
        matchCompleted: finished,
        winnerSeat,
        reason: next.terminationReason ?? null,
      } as const;
    });
  } catch (error) {
    // A replayed action index lost the race and was rejected by the unique
    // index. The transaction has already rolled back, so report a clean 409.
    if (isUniqueViolation(error)) {
      return { error: "That shot was already recorded", status: 409 } as const;
    }
    throw error;
  }
}

// ── Forfeit / cancel / disconnect ────────────────────────────────────────

/**
 * Resign: the opponent wins the match, with the same settlement path.
 *
 * The position is left EXACTLY as the engine last wrote it — resigning ends the
 * match, it does not fabricate a final shot.
 */
export async function forfeitMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(hillstrikeMatches)
      .where(eq(hillstrikeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.PLAYING || !seats.player2Id) {
      return { error: "Only an active match can be resigned", status: 409 } as const;
    }

    const winnerSeat = otherSeat(seat);
    const [updated] = await tx
      .update(hillstrikeMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        resultReason: END_REASONS.RESIGNED,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hillstrikeMatches.id, match.id),
          eq(hillstrikeMatches.status, MATCH_STATUS.PLAYING),
        ),
      )
      .returning();

    if (!updated) {
      return { error: "Match is no longer active", status: 409 } as const;
    }

    await settleMatch(tx, match, {
      result: winnerSeat,
      reason: END_REASONS.RESIGNED,
    });

    return { match: updated } as const;
  });
}

/** Cancel an open lobby. Only the creator, and only while still waiting. */
export async function cancelMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(hillstrikeMatches)
      .where(eq(hillstrikeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.player1Id !== userId) {
      return { error: "Only the lobby creator can cancel it", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return { error: "Only a waiting lobby can be cancelled", status: 409 } as const;
    }

    const [updated] = await tx
      .update(hillstrikeMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        resultReason: END_REASONS.ABANDONED,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hillstrikeMatches.id, match.id),
          eq(hillstrikeMatches.status, MATCH_STATUS.WAITING),
        ),
      )
      .returning();

    if (!updated) {
      return { error: "Lobby is no longer open", status: 409 } as const;
    }

    // A cancelled lobby never settled: no result is recorded and nothing is
    // awarded (settleMatch is deliberately not called).
    return { match: updated } as const;
  });
}

/**
 * Resolve a match whose participant stayed disconnected past the realtime grace
 * window (the realtime server calls this after verifying that seat's Clerk
 * token, so it can only ever act on the caller's OWN match).
 *
 *   • active match → the opponent is awarded the win
 *   • open lobby   → cancelled, so an abandoned lobby never lingers
 *   • terminal     → no-op, reported (not an error) so the retry loop stops
 */
export async function forfeitMatchOnDisconnect({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}): Promise<DisconnectResult> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(hillstrikeMatches)
      .where(eq(hillstrikeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }

    // Terminal — nothing to resolve (idempotent by design).
    if (
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      return { match, forfeited: false, cancelled: false } as const;
    }

    // Still an open lobby: release it. There is no opponent to award a win to.
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      const [released] = await tx
        .update(hillstrikeMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          resultReason: END_REASONS.ABANDONED,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hillstrikeMatches.id, match.id),
            eq(hillstrikeMatches.status, MATCH_STATUS.WAITING),
          ),
        )
        .returning();

      return {
        match: released ?? match,
        forfeited: false,
        cancelled: true,
      } as const;
    }

    // Active match: award the opponent the win.
    const winnerSeat = otherSeat(seat);
    const [updated] = await tx
      .update(hillstrikeMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        resultReason: END_REASONS.ABANDONED,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hillstrikeMatches.id, match.id),
          eq(hillstrikeMatches.status, MATCH_STATUS.PLAYING),
        ),
      )
      .returning();

    if (!updated) {
      // A shot or resignation settled it first — that result stands.
      const [current] = await tx
        .select()
        .from(hillstrikeMatches)
        .where(eq(hillstrikeMatches.id, match.id));
      return { match: current ?? match, forfeited: false, cancelled: false } as const;
    }

    await settleMatch(tx, match, {
      result: winnerSeat,
      reason: END_REASONS.ABANDONED,
    });

    return { match: updated, forfeited: true, cancelled: false } as const;
  });
}

// ── Settlement ───────────────────────────────────────────────────────────

export type SettlementOutcome = {
  result: Seat | null;
  reason: string;
};

/**
 * Finalise a finished match — the ONE place the terminal result is recorded.
 *
 * Called only from the transaction that already claimed the match (the
 * conditional `status` UPDATE inside each mutation), so it runs exactly once per
 * match: a second concurrent request finds the row already terminal and never
 * reaches here. That claim is what makes settlement idempotent at the match
 * level; the shared writers add their own (user, game, match) journal on top.
 *
 * RATED, through the platform's existing progression helpers and no maths of its
 * own:
 *
 *   * `applyRatingResult`  — per-game Elo (src/lib/rating.js). `hillstrike` is
 *                            registered in `RATED_GAMES`, so the writer accepts
 *                            the key rather than refusing it as unrated.
 *   * `applyTrophyResult`  — per-game trophies (src/lib/trophyStore.js), whose
 *                            registry IS `RATED_GAMES` (TROPHY_GAMES).
 *   * `users.gamesWon` / `users.gamesLost` — the account W/L counters the profile
 *                            and the classement page read.
 *
 * The two calls spell the game key as the LITERAL `"hillstrike"` rather than
 * through a constant, because that is the platform's convention for every
 * settlement site: tests audit settlement wiring by scanning the sources for
 * `gameKey: "<key>"` to prove that each rated game is settled by exactly one
 * writer, and an indirected key would be invisible to that audit.
 *
 * Both writers are called with THIS transaction, so the terminal result and the
 * progression commit atomically, and both are best-effort (`catch(() => {})`)
 * exactly like every other duel: a progression failure must never un-finish a
 * decided match.
 *
 * UNSTAKED: no pot, no rake, no escrow. Nothing here moves coins.
 *
 * PRACTICE IS EXCLUDED BY CONSTRUCTION. The vs-AI board is a browser-only game
 * with no match row, so it can never reach this function. A match with no second
 * seat is an open lobby, not a result, and returns above.
 *
 * Hillstrike cannot draw — the engine's only terminal reason is
 * `lives-exhausted`, and a resignation or a disconnect forfeit names a winner —
 * so there is no draw branch here.
 */
async function settleMatch(
  tx: any,
  match: MatchRow,
  outcome: SettlementOutcome,
): Promise<void> {
  // Both seats must be real accounts: a lobby with no opponent never settles.
  if (!match.player2Id) return;
  // Every caller passes the seat that won. A null/unknown result is never a
  // settlement — awarding the second seat by default would be a silent theft of
  // a match, so it is refused instead.
  if (outcome.result !== "player1" && outcome.result !== "player2") return;

  const winnerId =
    outcome.result === "player1" ? match.player1Id : match.player2Id;
  const loserId =
    outcome.result === "player1" ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId || winnerId === loserId) return;

  // Account W/L counters — the same two columns every other duel increments.
  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, loserId));

  await applyRatingResult({
    tx,
    gameKey: "hillstrike",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "hillstrike",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}
