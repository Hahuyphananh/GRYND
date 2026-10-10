// src/lib/barricade/serverStore.ts
//
// The server-authoritative Barricade online 1v1 match store. Every state
// transition happens inside a row-locked `db.transaction` here; the API routes
// are thin wrappers around these functions.
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The ONLY player-authored values that reach this module are the ACTION ADDRESS
// (`{ type: "move", to: { col, row } }` or
// `{ type: "wall", wall: { col, row, orientation } }`) and the
// optimistic-concurrency token `expectedVersion`. The position, both pawns, the
// barricades on the board, both reserves, whose turn it is, the winner and the
// match result are ALL computed from the server's own authoritative state by the
// shared rules engine (`validateAction` → `applyAction`). A client cannot submit
// a board, a winner, a turn owner, a legality verdict, a wall inventory, a
// result or a completion flag — no such field is ever read.
//
// ── CONCURRENCY ──────────────────────────────────────────────────────────
//
//   1. every mutation takes the match row with `FOR UPDATE`, so two concurrent
//      move requests on one match serialise; the second re-reads the row, sees
//      the ply/version the first one wrote, and is rejected as stale;
//   2. `move()` additionally checks `expectedVersion` against the authoritative
//      `ply` INSIDE that lock, so a double-submitted or stale-tab turn is a
//      clean 409 rather than a second action;
//   3. `barricade_moves` has a unique (match_id, ply) index, the storage-level
//      backstop that makes "one persisted action per turn number" impossible to
//      violate even if a future code path forgets the check;
//   4. matchmaking runs under one per-game advisory lock
//      (`pg_advisory_xact_lock`) plus a conditional UPDATE, so two callers can
//      never both open a lobby and a caller can never join a lobby that is being
//      cancelled.
//
// ── SETTLEMENT ───────────────────────────────────────────────────────────
//
// A finished match is finalised EXACTLY ONCE: the terminal write is claimed
// with a conditional UPDATE (`status <> 'finished'`), so the loser of a
// concurrent race is a no-op instead of a second settlement. See `settleMatch`
// for why rating/trophies are deliberately not wired (Barricade is not in the
// `RATED_GAMES` / trophy registries, and this phase must not enable competitive
// surfaces), and what a future rated ladder would change.
//
// There is no wager, stake, pot, payout or token path anywhere in this file.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { barricadeMatches, barricadeMoves } from "../../db/schema";
import {
  ACTION_TYPES,
  BARRICADE_LOCK_NAMESPACE,
  END_REASONS,
  MATCH_STATUS,
  REJECTION,
  WIN_REASON,
} from "./constants";
import { applyAction, createInitialState, otherSeat, validateAction } from "./rules";
import type { BarricadeAction, BarricadeState, Seat } from "./types";

/** The two seats of a row: `player2Id` is null while the row is an open lobby. */
export type Seats = { player1Id: string; player2Id: string | null };

type MatchRow = typeof barricadeMatches.$inferSelect;

/**
 * Structural view of the engine's verdict.
 *
 * The engine returns a discriminated union (`{ ok: true, kind }` /
 * `{ ok: false, code, message }`), but this repo compiles with `strict: false`,
 * where narrowing that union on its boolean literal discriminant does not work —
 * so the store reads the verdict through this widened shape instead of relying
 * on the narrowing (the same reason the sibling stores return plain objects).
 */
type ActionVerdict = {
  ok: boolean;
  kind?: string;
  code?: string;
  message?: string;
};

export type StoreError = { error: string; status: number };

/**
 * Result of resolving a disconnected participant.
 *
 * Spelled as an explicit union (like the Tic-Tac-Toe store) rather than
 * inferred: the route narrows it with `"error" in result`, and this repo
 * compiles with `strict: false`, where an INFERRED union of structurally
 * similar object literals collapses and the narrowing branch becomes `never`.
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
 * guest seat: an unrelated signed-in user resolves to no seat and gets a 403,
 * so one player can never act on another player's match.
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

/** The persisted authoritative position of a row. */
export function stateOf(match: MatchRow): BarricadeState {
  return match.gameState as BarricadeState;
}

/** The status a live row should carry, derived from the engine's own state. */
export function statusForState(state: BarricadeState): string {
  return state.status === MATCH_STATUS.FINISHED ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING;
}

/**
 * Client-facing snapshot for `viewerId`.
 *
 * Barricade is perfect information, so the whole position is published — both
 * pawns, every barricade and BOTH reserves (which is what lets a seat see how
 * many barricades the opponent has left). Nothing here is client-authoritative:
 * every field is read off the row the engine wrote.
 */
export function matchToDto(match: MatchRow, viewerId: string | null) {
  const state = stateOf(match);
  const seats = seatsFromRow(match);
  const viewerSeat = seatForUser(seats, viewerId);
  const activeSeat = seats.player2Id ? state.turn : seats.player1Id ? "player1" : null;
  const activeUserId =
    activeSeat === "player1"
      ? seats.player1Id
      : activeSeat === "player2"
        ? seats.player2Id
        : null;

  return {
    matchId: match.id,
    status: match.status,
    // Monotonic accepted-action count — the optimistic-concurrency version the
    // client echoes back as `expectedVersion`.
    version: match.ply,
    ply: match.ply,
    /** The authoritative position (see src/lib/barricade/rules.ts). */
    gameState: state,
    turn: state.turn,
    turnUserId: activeUserId,
    wallsRemaining: state.wallsRemaining,
    // Viewer projection: whose seat the caller holds and whether it is theirs to
    // play. Derived on the server so the client never has to decide it.
    viewerSeat,
    opponentSeat: viewerSeat ? otherSeat(viewerSeat) : null,
    isViewerTurn: Boolean(viewerSeat) && state.turn === viewerSeat,
    isLive: match.status === MATCH_STATUS.PLAYING,
    // Terminal fields — the ONLY source of the result screen.
    result: match.result ?? null,
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
    .from(barricadeMatches)
    .where(
      and(
        eq(barricadeMatches.status, MATCH_STATUS.WAITING),
        isNull(barricadeMatches.player2Id),
      ),
    )
    .orderBy(sql`${barricadeMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any (the lobby's "resume" row). */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(barricadeMatches)
    .where(
      and(
        eq(barricadeMatches.status, MATCH_STATUS.WAITING),
        isNull(barricadeMatches.player2Id),
        eq(barricadeMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${barricadeMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * Match the caller into the oldest open lobby, or open a new one.
 *
 * Runs entirely under one advisory lock (per-game namespace), so two concurrent
 * callers can never both see "no open lobby" and each create one, and a caller
 * can never join a lobby that is being cancelled at the same moment.
 */
export async function createOrJoin({ userId }: { userId: string }) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${BARRICADE_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(barricadeMatches)
      .where(
        and(
          eq(barricadeMatches.status, MATCH_STATUS.WAITING),
          isNull(barricadeMatches.player2Id),
        ),
      )
      .orderBy(sql`${barricadeMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // Already the caller's own lobby — hand it back instead of opening a
      // second one (and never seat the creator against themselves).
      if (open.player1Id === userId) return { match: open, joined: false };
      return await joinExistingMatch(tx, open.id, userId);
    }

    return await createWaitingMatch(tx, userId);
  });
}

async function createWaitingMatch(tx: any, userId: string) {
  const state = createInitialState();
  const [match] = await tx
    .insert(barricadeMatches)
    .values({
      player1Id: userId,
      // No opponent yet: the row IS the open lobby.
      player2Id: null,
      status: MATCH_STATUS.WAITING,
      ply: state.ply,
      // Nobody can act yet, but the column stays consistent with the state.
      currentTurnUserId: userId,
      gameState: state,
    })
    .returning();

  return { match, joined: false } as const;
}

async function joinExistingMatch(tx: any, candidateId: string, userId: string) {
  const [match] = await tx
    .select()
    .from(barricadeMatches)
    .where(eq(barricadeMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }
  if (match.player1Id === userId) {
    return { error: "You already host this lobby", status: 409 } as const;
  }

  const state = stateOf(match);

  // Straight to `playing`: Barricade has no ready banner and no countdown, so
  // player1's first turn is available the moment the second seat lands.
  const [updated] = await tx
    .update(barricadeMatches)
    .set({
      player2Id: userId,
      status: statusForState(state),
      ply: state.ply,
      currentTurnUserId: match.player1Id,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(barricadeMatches.id, candidateId),
        eq(barricadeMatches.status, MATCH_STATUS.WAITING),
        isNull(barricadeMatches.player2Id),
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
 * A non-participant gets a 403 — Barricade online has no spectator mode, so one
 * player can never read (or act on) another player's match. There is no clock
 * and no deadline to resolve, so a read can never change the state.
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
    .from(barricadeMatches)
    .where(eq(barricadeMatches.id, matchId));

  if (!match) return { error: "Match not found", status: 404 } as const;

  const seats = seatsFromRow(match);
  if (!seatForUser(seats, userId)) {
    return { error: "Not a participant of this match", status: 403 } as const;
  }

  return { match, dto: matchToDto(match, userId) } as const;
}

/** The append-only action log for a match, oldest first. */
export async function fetchMatchMoves(matchId: string) {
  return await db
    .select({
      ply: barricadeMoves.ply,
      playerId: barricadeMoves.playerId,
      actionType: barricadeMoves.actionType,
      col: barricadeMoves.col,
      row: barricadeMoves.row,
      orientation: barricadeMoves.orientation,
      createdAt: barricadeMoves.createdAt,
    })
    .from(barricadeMoves)
    .where(eq(barricadeMoves.matchId, matchId))
    .orderBy(sql`${barricadeMoves.ply} ASC`);
}

// ── The action (the only gameplay mutation) ──────────────────────────────

export type MoveResult =
  | {
      match: MatchRow;
      state: BarricadeState;
      /** The move kind the ENGINE derived (step / jump-straight / jump-diagonal). */
      kind: string | null;
      ply: number;
      matchCompleted: boolean;
      winnerSeat: Seat | null;
      reason: string | null;
    }
  | StoreError;

/** Rejection code → HTTP status. Shape/bounds errors are 400; everything the
 *  engine refuses about the POSITION is a 409 (the caller's view is stale). */
function statusForRejection(code: string): number {
  switch (code) {
    case REJECTION.INVALID_ACTION:
    case REJECTION.INVALID_SEAT:
    case REJECTION.OUT_OF_BOUNDS:
    case REJECTION.INVALID_ORIENTATION:
    case REJECTION.ACTION_MISMATCH:
      return 400;
    default:
      return 409;
  }
}

/**
 * Take one action — a pawn move or a barricade placement.
 *
 * The request carries ONLY the action address plus `expectedVersion`. Rejections,
 * in order:
 *
 *   404 match not found
 *   403 caller holds no seat                (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   409 not your turn
 *   409 stale `expectedVersion` (double submit / stale tab)
 *   400 malformed action address
 *   409 the engine refuses the action (occupied square, blocked knife-edge,
 *       jump not available, no barricades left, overlap, crossing, sealed path)
 *
 * `validateAction` then `applyAction` run inside the same row-locked transaction
 * as the write, so nothing about the position is trusted from the request and no
 * two requests can consume the same turn.
 */
export async function move({
  userId,
  matchId,
  action,
  expectedVersion,
}: {
  userId: string;
  matchId: string;
  action: unknown;
  expectedVersion?: unknown;
}): Promise<MoveResult> {
  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(barricadeMatches)
        .where(eq(barricadeMatches.id, matchId))
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

      const state = stateOf(match);

      // Optimistic concurrency: the caller must be acting on the position it
      // was shown. Omitted is tolerated (the turn + ply checks below still
      // hold), but the client always sends it.
      if (expectedVersion !== undefined && expectedVersion !== null) {
        const expected = Number(expectedVersion);
        if (!Number.isInteger(expected) || expected !== match.ply) {
          return {
            error: "Stale match state — it is not your turn to act on this position",
            status: 409,
          } as const;
        }
      }

      const validation = validateAction(state, seat, action as BarricadeAction) as ActionVerdict;
      if (!validation.ok) {
        const code = validation.code ?? "invalid-action";
        return {
          error: validation.message ?? "That action is not legal here",
          status: statusForRejection(code),
        } as StoreError;
      }

      // The engine decides the next position. It also re-validates, so a
      // mismatch between the verdict above and this call is impossible.
      const next = applyAction(state, seat, action as BarricadeAction);
      const played = next.lastAction?.action ?? null;

      // Append-only log: the exact address the server validated. The unique
      // (match_id, ply) index rejects a duplicate turn structurally.
      await tx.insert(barricadeMoves).values({
        matchId: match.id,
        ply: state.ply,
        playerId: userId,
        actionType: played?.type === ACTION_TYPES.WALL ? ACTION_TYPES.WALL : ACTION_TYPES.MOVE,
        col: played?.type === ACTION_TYPES.WALL ? played.wall.col : (played?.to.col ?? 0),
        row: played?.type === ACTION_TYPES.WALL ? played.wall.row : (played?.to.row ?? 0),
        orientation: played?.type === ACTION_TYPES.WALL ? played.wall.orientation : null,
      });

      const finished = next.status === MATCH_STATUS.FINISHED;
      const winnerSeat = next.outcome?.winner ?? null;

      const updates: Partial<typeof barricadeMatches.$inferInsert> = {
        gameState: next,
        ply: next.ply,
        currentTurnUserId: userIdForSeat(seats, next.turn),
        status: finished ? MATCH_STATUS.FINISHED : statusForState(next),
        updatedAt: new Date(),
      };

      if (finished) {
        updates.result = winnerSeat;
        updates.winnerId = winnerSeat ? userIdForSeat(seats, winnerSeat) : null;
        updates.resultReason = next.outcome?.reason ?? WIN_REASON;
        updates.endedAt = new Date();
      }

      const [updated] = await tx
        .update(barricadeMatches)
        .set(updates)
        // The version guard: with the row lock this is belt-and-braces, and it
        // documents that exactly one transaction may consume turn `ply`.
        .where(
          and(
            eq(barricadeMatches.id, match.id),
            eq(barricadeMatches.ply, match.ply),
          ),
        )
        .returning();

      if (!updated) {
        return { error: "Match state changed — please retry", status: 409 } as const;
      }

      if (finished) {
        await settleMatch(tx, match, {
          result: winnerSeat,
          reason: next.outcome?.reason ?? WIN_REASON,
        });
      }

      return {
        match: updated,
        state: next,
        kind: played?.type === ACTION_TYPES.MOVE ? played.kind : null,
        ply: state.ply,
        matchCompleted: finished,
        winnerSeat,
        reason: next.outcome?.reason ?? null,
      } as const;
    });
  } catch (error) {
    // A replayed ply lost the race and was rejected by the unique index. The
    // transaction has already rolled back, so report a clean 409, not a 500.
    if (isUniqueViolation(error)) {
      return { error: "That action was already recorded", status: 409 } as const;
    }
    throw error;
  }
}

/** Seat → user id, or null for an empty seat. */
export function userIdForSeat(seats: Seats, seat: Seat | null): string | null {
  if (!seat) return null;
  return seat === "player1" ? seats.player1Id : seats.player2Id ?? null;
}

// ── Forfeit / cancel / disconnect ────────────────────────────────────────

/** Resign: the opponent wins the match, with the same settlement path. */
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
      .from(barricadeMatches)
      .where(eq(barricadeMatches.id, matchId))
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
      .update(barricadeMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        resultReason: END_REASONS.RESIGNED,
        // The position is left EXACTLY as the engine last wrote it: a
        // resignation ends the match, it does not move a pawn.
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(barricadeMatches.id, match.id),
          eq(barricadeMatches.status, MATCH_STATUS.PLAYING),
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
      .from(barricadeMatches)
      .where(eq(barricadeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.player1Id !== userId) {
      return { error: "Only the lobby creator can cancel it", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return { error: "Only a waiting lobby can be cancelled", status: 409 } as const;
    }

    const [updated] = await tx
      .update(barricadeMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        resultReason: END_REASONS.ABANDONED,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(barricadeMatches.id, match.id),
          eq(barricadeMatches.status, MATCH_STATUS.WAITING),
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
      .from(barricadeMatches)
      .where(eq(barricadeMatches.id, matchId))
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
        .update(barricadeMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          resultReason: END_REASONS.ABANDONED,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(barricadeMatches.id, match.id),
            eq(barricadeMatches.status, MATCH_STATUS.WAITING),
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
      .update(barricadeMatches)
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
          eq(barricadeMatches.id, match.id),
          eq(barricadeMatches.status, MATCH_STATUS.PLAYING),
        ),
      )
      .returning();

    if (!updated) {
      // A move or resignation settled it first — that result stands.
      const [current] = await tx
        .select()
        .from(barricadeMatches)
        .where(eq(barricadeMatches.id, match.id));
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
 * reaches here.
 *
 * DELIBERATELY NOT RATED. The platform's progression helpers
 * (`applyRatingResult` / `applyTrophyResult`) accept only games listed in
 * `RATED_GAMES` / the trophy registry (src/lib/rating.js, src/lib/trophies.js),
 * and adding "barricade" is a platform-level decision with visible consequences
 * (a rated ladder, per-game leaderboards, trophy pages). This phase explicitly
 * must not enable competitive surfaces before direct matchmaking is proven, and
 * Barricade's free-practice phase was unchallenged by competitive rewards — so
 * the outcome lives on the match row (`result`, `winnerId`, `result_reason`,
 * `ended_at`) and nothing else moves. A future rated ladder adds exactly two
 * registry entries and an `applyRatingResult`/`applyTrophyResult` pair here.
 *
 * No wager/token/payout path exists in this file, so there is nothing to pay
 * out either way.
 */
async function settleMatch(
  tx: any,
  match: MatchRow,
  outcome: SettlementOutcome,
): Promise<void> {
  // Both seats must be real accounts: this store is fed only by the
  // age-verified matchmaking routes, and a lobby with no opponent never settles.
  if (!match.player2Id) return;

  const winnerId =
    outcome.result === "player1" ? match.player1Id : match.player2Id;
  const loserId =
    outcome.result === "player1" ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId || winnerId === loserId) return;

  // Unrated by design (see the note above). Nothing to write here yet — the
  // terminal columns were written by the claiming transaction.
  void tx;
  void outcome;
}

// Re-exported so the routes can present the engine's own vocabulary without
// importing the rules module directly.
export { WIN_REASON };
