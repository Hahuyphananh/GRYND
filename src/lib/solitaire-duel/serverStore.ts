// src/lib/solitaire-duel/serverStore.ts
//
// The server-authoritative Solitaire Duel match store. Every state transition
// happens inside a row-locked `db.transaction` here, and the API routes are thin
// wrappers around these functions.
//
// TRUST BOUNDARY: the ONLY player-authored value that reaches this module is a
// move — which cards, from where, to where. The board, the stock order, the
// face-up/face-down state, the progress figure, the completion, the completion
// instant, the winner, the match result, the rating change and the trophies are
// all derived by the server from its own state. A client cannot submit a winner,
// a result, a score, a progress value, a completion flag, an Elo value or a
// trophy — no such field is ever read, anywhere in this file.
//
// FAIRNESS: `createOrJoin` mints ONE server seed, commits its hash and derives
// ONE deal for the match row. Both `p1_state` and `p2_state` are created as
// copies of that single deal at ply 0, and joining NEVER regenerates anything —
// so the two seats provably start from the identical puzzle. Each seat's moves
// are written to that seat's own columns, so one board can never alter the
// other.
//
// Settlement reuses the platform's existing rating/trophy infrastructure
// (`applyRatingResult` / `applyTrophyResult`) inside the SAME transaction that
// finalises the match, exactly once — the guard is the `status` flip to
// `finished` under a `FOR UPDATE` lock, plus those helpers' own
// (user, game, match)-keyed idempotency journals. There is NO second Elo
// implementation and NO wager/token/payout path anywhere in this file.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { solitaireDuelMatches, solitaireDuelMoves, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import {
  MATCH_STATUS,
  MAX_MOVES_PER_SEAT,
  READY_COUNTDOWN_MS,
  MATCH_LIMIT_MS,
  RESOLUTION,
  RESULT,
  SEAT,
  SOLITAIRE_DUEL_LOCK_NAMESPACE,
  TERMINAL_STATUSES,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import { dealFromSeed } from "./deck";
import {
  cloneState,
  failureOf,
  initialStateFromDeal,
  isWellFormedState,
  normalizeMove,
  opponentProgressFor,
  otherSeat,
  progressOf,
  raceFromState,
  resolveRace,
  seatForUser,
  userIdForSeat,
  applyMove,
  viewForState,
} from "./rules";
import { deriveDealSeed, getServerSeedHash, randomHex } from "./seeds";
import type {
  Card,
  OpponentProgress,
  RaceOutcome,
  Seat,
  SeatProgress,
  SeatRace,
  Seats,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
  SolitaireView,
} from "./types";

// The rated/trophy game key, and the queue-mirror game key.
//
// Written as a string literal at every call site (rather than a shared
// constant) on purpose: the platform's settlement-wiring audits scan source for
// `gameKey: "<key>"` to prove every rated game is wired to a shared writer, and
// a constant reference would be invisible to that check.

type MatchRow = typeof solitaireDuelMatches.$inferSelect;

export type StoreError = { error: string; status: number };

/**
 * Result of resolving a disconnected participant.
 *
 * Spelled as an explicit union rather than inferred: the route narrows it with
 * `"error" in result`, and this repo compiles with `strict: false`, where an
 * INFERRED union of structurally-similar object literals collapses and the
 * narrowing branch becomes `never`.
 */
export type DisconnectResult =
  | { match: MatchRow; forfeited: boolean; cancelled: boolean }
  | StoreError;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Route-level guard so a non-UUID id can never reach a Postgres uuid cast. */
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

/** An instant column as epoch ms, or null. */
function instantMs(value: unknown): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function err(error: string, status: number): StoreError {
  return { error, status };
}

// ── Seats ─────────────────────────────────────────────────────────────────

export function seatsFromRow(match: {
  player1Id: string;
  player2Id?: string | null;
}): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}

/** True when `userId` occupies either seat. */
export function isParticipant(
  match: { player1Id: string; player2Id?: string | null },
  userId: string | null,
): boolean {
  return Boolean(seatForUser(seatsFromRow(match), userId));
}

/**
 * A seat's own authoritative board.
 *
 * Read per seat and never merged: this is the accessor that guarantees one
 * player's moves cannot reach the other player's state.
 */
export function stateForSeat(match: MatchRow, seat: Seat): SolitaireState | null {
  const raw = seat === SEAT.PLAYER1 ? match.p1State : match.p2State;
  return (raw ?? null) as SolitaireState | null;
}

function plyForSeat(match: MatchRow, seat: Seat): number {
  return Number((seat === SEAT.PLAYER1 ? match.p1Ply : match.p2Ply) ?? 0);
}

function raceFor(match: MatchRow, seat: Seat, forfeited = false): SeatRace {
  return raceFromState({
    userId: userIdForSeat(seatsFromRow(match), seat),
    seat,
    state: stateForSeat(match, seat),
    forfeited,
  });
}

/**
 * The per-seat column write for one move.
 *
 * Written as an explicit branch rather than dynamic keys so the patch is
 * type-checked and readable — and so it is visible at a glance that a move
 * touches ONLY the acting seat's columns.
 */
function seatPatchFor(seat: Seat, state: SolitaireState, progress: SeatProgress) {
  if (seat === SEAT.PLAYER1) {
    return {
      p1State: state,
      p1Ply: state.ply,
      p1PeakFoundation: state.peakFoundation,
      p1Revealed: progress.revealedTableau,
    };
  }
  return {
    p2State: state,
    p2Ply: state.ply,
    p2PeakFoundation: state.peakFoundation,
    p2Revealed: progress.revealedTableau,
  };
}

function seatFinishedPatchFor(seat: Seat, nowMs: number) {
  return seat === SEAT.PLAYER1
    ? { p1FinishedAt: new Date(nowMs) }
    : { p2FinishedAt: new Date(nowMs) };
}

// ── DTOs ──────────────────────────────────────────────────────────────────

/**
 * Client-facing DTO for a match row, from `viewerId`'s perspective.
 *
 * Built field by field, never by spreading the row: the row holds BOTH seats'
 * boards, the stock order and the server seed, so a spread would leak the
 * opponent's board and the face-down identities in one line. The board here is
 * the viewer's OWN projected view, and the opponent appears only as the closed
 * `OpponentProgress` shape.
 *
 * The board is included only once the race is live (`playing`), so neither seat
 * can study the deal while waiting for an opponent — the deal is revealed to
 * both from the same server state, at the same moment.
 */
export function matchToDto(match: MatchRow, viewerId: string | null, nowMs = Date.now()) {
  const seats = seatsFromRow(match);
  const seat = seatForUser(seats, viewerId);
  const terminal = TERMINAL_STATUSES.includes(match.status);
  const revealed = match.status === MATCH_STATUS.PLAYING || terminal;
  const ownState = seat ? stateForSeat(match, seat) : null;
  const otherState = seat ? stateForSeat(match, otherSeat(seat)) : null;

  return {
    matchId: String(match.id),
    variant: match.variant,
    variantVersion: match.variantVersion,
    status: match.status,
    result: match.result ?? null,
    resolutionReason: match.resolutionReason ?? null,
    winnerId: match.winnerId ?? null,
    seat,
    isParticipant: Boolean(seat),
    // The commitment is public from creation; the seed itself is only revealed
    // once the match is terminal, so the deal can be verified after the fact.
    seedHash: match.serverSeedHash,
    serverSeed: terminal ? match.serverSeed : null,
    goAtMs: instantMs(match.goAt),
    deadlineAtMs: instantMs(match.deadlineAt),
    startedAtMs: instantMs(match.startedAt),
    endedAtMs: instantMs(match.endedAt),
    createdAtMs: instantMs(match.createdAt),
    /** Server clock, so a client can render an accurate timer without trusting its own. */
    serverNow: nowMs,
    view: revealed && ownState ? viewForState(ownState) : null,
    progress: ownState ? progressOf(ownState) : null,
    opponent:
      revealed && otherState && seat
        ? opponentProgressFor(otherSeat(seat), otherState)
        : null,
  };
}

/**
 * The public lobby entry for an open match.
 *
 * Deliberately narrower than the match DTO: an open lobby is visible to anyone,
 * so it must expose nothing but "a Solitaire Duel is waiting" — no deal, no
 * board, no seed, not even a player id.
 */
export function lobbyEntry(match: MatchRow, nowMs = Date.now()) {
  return {
    matchId: String(match.id),
    variant: match.variant,
    status: match.status,
    open: match.status === MATCH_STATUS.WAITING && !match.player2Id,
    seedHash: match.serverSeedHash,
    createdAtMs: instantMs(match.createdAt),
    serverNow: nowMs,
  };
}

// ── Lobby / matchmaking ───────────────────────────────────────────────────

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(solitaireDuelMatches)
    .where(
      and(
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
      ),
    )
    .orderBy(sql`${solitaireDuelMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any. */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(solitaireDuelMatches)
    .where(
      and(
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
        eq(solitaireDuelMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${solitaireDuelMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * Match the caller into an open lobby, or open a new one.
 *
 * The whole operation runs under a single advisory lock (per-game namespace) so
 * two concurrent callers can never both see "no open lobby" and each create
 * one, and so a caller can never join a lobby that is being cancelled.
 */
export async function createOrJoin({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SOLITAIRE_DUEL_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(
        and(
          eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
          isNull(solitaireDuelMatches.player2Id),
        ),
      )
      .orderBy(sql`${solitaireDuelMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // The caller's own lobby — return it rather than creating a second.
      if (open.player1Id === userId) return { match: open, joined: false } as const;
      return await joinExistingMatch(tx, open.id, userId, nowMs);
    }

    return await createWaitingMatch(tx, userId, nowMs);
  });
}

/**
 * Open a lobby, seeding the match.
 *
 * The seed, its commitment, the derived deal seed and the deal are all minted
 * here, once. BOTH boards are written from that one deal in the same INSERT, so
 * "both players receive the exact same initial puzzle" is a structural property
 * of the row rather than something a join path has to remember to do.
 */
async function createWaitingMatch(tx: any, userId: string, nowMs: number) {
  // Server-generated entropy only. Never client-supplied, never Math.random().
  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const dealSeed = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  const deal: SolitaireDeal = dealFromSeed(dealSeed);

  // The SAME deal initialises both seats — two independent copies of one
  // opening position, so neither seat's board can ever alias the other's (or
  // the deal's) objects.
  const opening = initialStateFromDeal(deal);
  const openingProgress = progressOf(opening);

  const [match] = await tx
    .insert(solitaireDuelMatches)
    .values({
      variant: VARIANT,
      variantVersion: VARIANT_VERSION,
      player1Id: userId,
      status: MATCH_STATUS.WAITING,
      serverSeed,
      serverSeedHash,
      dealSeed,
      deal,
      p1State: opening,
      p2State: cloneState(opening),
      // Both seats begin at ply 0 on the same board.
      p1Ply: 0,
      p2Ply: 0,
      p1PeakFoundation: opening.peakFoundation,
      p2PeakFoundation: opening.peakFoundation,
      p1Revealed: openingProgress.revealedTableau,
      p2Revealed: openingProgress.revealedTableau,
    })
    .returning();

  mirrorQueueCreated({
    gameKey: "solitaire-duel",
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });

  return { match, joined: false } as const;
}

/**
 * Fill the open lobby and start the race.
 *
 * NOTHING about the puzzle is touched here: seat 2's board already holds its
 * copy of the shared deal, so joining cannot introduce a second deal. The only
 * work is the synchronized clock — an absolute GO instant plus a deadline, both
 * on the server's clock.
 *
 * The match goes straight to `playing` (there is no ready banner), but moves
 * before `go_at` are refused, so the countdown is a shared planning window
 * rather than dead time.
 */
async function joinExistingMatch(tx: any, candidateId: string, userId: string, nowMs: number) {
  const [match] = await tx
    .select()
    .from(solitaireDuelMatches)
    .where(eq(solitaireDuelMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }

  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  const [updated] = await tx
    .update(solitaireDuelMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.PLAYING,
      goAt: new Date(goAtMs),
      deadlineAt: new Date(goAtMs + MATCH_LIMIT_MS),
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(solitaireDuelMatches.id, candidateId),
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  mirrorQueueCreated({
    gameKey: "solitaire-duel",
    matchId: updated.id,
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
  });

  return { match: updated, joined: true } as const;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * The authoritative snapshot for the calling participant.
 *
 * A match past its deadline is resolved on READ, so a match can never be left
 * live just because nobody happened to move — the same lazy-resolution pattern
 * Speed Typing uses. Non-participants get a 403; there is no spectator mode.
 */
export async function fetchMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  let [match] = await db
    .select()
    .from(solitaireDuelMatches)
    .where(eq(solitaireDuelMatches.id, matchId));

  if (!match) return err("Match not found", 404);

  const seats = seatsFromRow(match);
  if (!seatForUser(seats, userId)) {
    return err("Not a participant of this match", 403);
  }

  if (isDeadlineDue(match, nowMs)) {
    await resolveDueMatch({ matchId, nowMs });
    [match] = await db
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId));
  }

  return { match, dto: matchToDto(match, userId, nowMs) } as const;
}

/** The append-only move log for one seat, oldest first. */
export async function fetchSeatMoves(matchId: string, seat: Seat) {
  return await db
    .select({
      ply: solitaireDuelMoves.ply,
      kind: solitaireDuelMoves.kind,
      move: solitaireDuelMoves.move,
      createdAt: solitaireDuelMoves.createdAt,
    })
    .from(solitaireDuelMoves)
    .where(
      and(
        eq(solitaireDuelMoves.matchId, matchId),
        eq(solitaireDuelMoves.seat, seat),
      ),
    )
    .orderBy(sql`${solitaireDuelMoves.ply} ASC`);
}

/** True when a live match has passed its limit and must be resolved. */
function isDeadlineDue(match: MatchRow, nowMs: number): boolean {
  if (match.status !== MATCH_STATUS.PLAYING || !match.player2Id) return false;
  const deadlineAtMs = instantMs(match.deadlineAt);
  return deadlineAtMs != null && nowMs >= deadlineAtMs;
}

// ── Move (the only player-authored mutation) ──────────────────────────────

export type MoveResult =
  | {
      match: MatchRow;
      view: SolitaireView;
      progress: SeatProgress;
      ply: number;
      revealed: Card[];
      completed: boolean;
      raceResolved: boolean;
    }
  | StoreError;

/**
 * Take one move.
 *
 * The request carries ONLY { move, expectedPly }. Anything else a client might
 * send — a board, a progress figure, a completion flag, a winner, a score, an
 * Elo delta, a trophy — is not read: the sequence
 *   normalizeMove → applyMove → progressOf
 * runs entirely inside the row-locked transaction below, against the server's
 * own board.
 *
 * WHY A ROW LOCK (and not a lock-free compare-and-set): the two seats never
 * share a board, so contention between them is nil at the ~1 write/second a
 * human produces — and the lock is what makes a COMPLETING move atomic with the
 * cross-seat transition it triggers (finishing the match, settling it). One
 * lock, one guarantee, instead of two mechanisms to keep in step.
 *
 * Rejections, in order:
 *   400 the move is not even the right shape
 *   404 match not found
 *   403 caller holds no seat              (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   409 the race has not started yet      (before `go_at`)
 *   409 the match limit has passed        (and the match resolves)
 *   409 the seat has already finished
 *   400 malformed `expectedPly`
 *   409 stale `expectedPly` — refetch
 *   409 the per-seat move cap is reached
 *   422 the move is well-formed but illegal in Klondike
 */
export async function submitMove({
  userId,
  matchId,
  move,
  expectedPly,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  move: unknown;
  expectedPly?: unknown;
  nowMs?: number;
}): Promise<MoveResult> {
  // Shape-check BEFORE any database work, so a malformed payload is rejected
  // without a transaction and can never reach the board.
  const parsed = normalizeMove(move);
  const malformed = failureOf(parsed);
  if (malformed) return err(malformed.error, 400);
  // Narrowed once, explicitly: `strict: false` does not narrow on `parsed.ok`.
  const normalized = parsed as { ok: true; move: SolitaireMove };

  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(solitaireDuelMatches)
        .where(eq(solitaireDuelMatches.id, matchId))
        .for("update");

      if (!match) return err("Match not found", 404);

      const seats = seatsFromRow(match);
      const seat = seatForUser(seats, userId);
      if (!seat) return err("Not a participant of this match", 403);
      if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
        return err("Waiting for an opponent", 409);
      }
      if (TERMINAL_STATUSES.includes(match.status)) {
        return err("Match is no longer active", 409);
      }

      // Timing is decided from the server's clock against server-written
      // instants. A client cannot move early, and cannot move past the limit.
      const goAtMs = instantMs(match.goAt);
      if (goAtMs == null || nowMs < goAtMs) {
        return err("The race has not started", 409);
      }
      if (isDeadlineDue(match, nowMs)) {
        await resolveDueMatchInTx(tx, match, nowMs);
        return err("The match limit has passed", 409);
      }

      const state = stateForSeat(match, seat);
      if (!state || !isWellFormedState(state)) {
        return err("The match state is not playable", 409);
      }
      if (state.completed) {
        return err("You have already completed the puzzle", 409);
      }

      // Strict, uncoerced staleness guard: the same idempotency contract that
      // makes a retried POST a no-op instead of a second accepted move.
      if (expectedPly !== undefined && expectedPly !== null) {
        if (
          typeof expectedPly !== "number" ||
          !Number.isInteger(expectedPly) ||
          expectedPly < 0
        ) {
          return err("Invalid expectedPly", 400);
        }
        if (expectedPly !== state.ply) {
          return err("Stale move — refetch the match", 409);
        }
      }
      if (state.ply >= MAX_MOVES_PER_SEAT) {
        return err("Move limit reached", 409);
      }

      const applied = applyMove({ state, move: normalized.move });
      const rejection = failureOf(applied);
      if (rejection) {
        // A board that is already solved is a lifecycle conflict; anything else
        // is a well-formed but illegal Klondike move.
        return err(rejection.error, rejection.code === "ALREADY_COMPLETE" ? 409 : 422);
      }

      const nextState = applied.state as SolitaireState;
      const completedNow = nextState.completed && !state.completed;
      if (completedNow) {
        // The completion INSTANT is stamped here, on the server's clock — it is
        // what decides a photo finish, so it is never a client value.
        nextState.completedAtMs = nowMs;
      }
      const progress = progressOf(nextState);

      // Append-only log: the validated input, at the ply it was played. The
      // (match_id, seat, ply) unique index is the structural anti-replay.
      await tx.insert(solitaireDuelMoves).values({
        matchId: match.id,
        seat,
        ply: state.ply,
        kind: normalized.move.kind,
        move: normalized.move,
      });

      const [updated] = await tx
        .update(solitaireDuelMatches)
        .set({
          ...seatPatchFor(seat, nextState, progress),
          ...(completedNow ? seatFinishedPatchFor(seat, nowMs) : {}),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitaireDuelMatches.id, match.id))
        .returning();

      const changed = updated ?? match;

      // Only a completion (or a forfeit) can end the race mid-flight, so this
      // is where "first to solve it wins IMMEDIATELY" is enforced.
      let finalRow = changed;
      const outcome = resolveRace({
        player1: raceFor(changed, SEAT.PLAYER1),
        player2: raceFor(changed, SEAT.PLAYER2),
      });
      if (outcome) finalRow = await finalizeMatch(tx, changed, outcome, nowMs);

      return {
        match: finalRow,
        view: viewForState(nextState),
        progress,
        ply: state.ply,
        revealed: applied.revealed ?? [],
        completed: Boolean(nextState.completed),
        raceResolved: Boolean(outcome),
      } as const;
    });
  } catch (error) {
    // A replayed ply lost the race and was rejected by the storage-layer unique
    // index. The transaction has already rolled back, so report a clean 409
    // rather than a 500.
    if (isUniqueViolation(error)) {
      return err("Move already recorded", 409);
    }
    throw error;
  }
}

// ── Deadline resolution ───────────────────────────────────────────────────

export type DueResolution =
  | { match: MatchRow; resolved: boolean }
  | StoreError;

/**
 * Resolve a live match whose limit has passed.
 *
 * Safe to call at any time and from any path: it re-checks the status under the
 * row lock and does nothing unless the match is genuinely live and genuinely
 * due. That is what lets every caller below be a plain "just in case" call with
 * no coordination.
 */
export async function resolveDueMatch({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}): Promise<DueResolution> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    return await resolveDueMatchInTx(tx, match, nowMs);
  });
}

async function resolveDueMatchInTx(
  tx: any,
  match: MatchRow,
  nowMs: number,
): Promise<{ match: MatchRow; resolved: boolean }> {
  if (!isDeadlineDue(match, nowMs)) return { match, resolved: false };

  const outcome = resolveRace({
    player1: raceFor(match, SEAT.PLAYER1),
    player2: raceFor(match, SEAT.PLAYER2),
    deadlineReached: true,
  });
  if (!outcome) return { match, resolved: false };

  const finalRow = await finalizeMatch(tx, match, outcome, nowMs);
  return { match: finalRow, resolved: true };
}

// ── Forfeit / cancel ──────────────────────────────────────────────────────

/** Concede: the opponent wins the match, with the same settlement path. */
export async function forfeitMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) return err("Not a participant of this match", 403);
    if (TERMINAL_STATUSES.includes(match.status)) {
      return err("Match is no longer active", 409);
    }
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      return err("Only an active match can be forfeited", 409);
    }

    // The conceding seat is the forfeiting one; `resolveRace` awards the win to
    // the other seat. Nothing about the result came from the request.
    const outcome = resolveRace({
      player1: raceFor(match, SEAT.PLAYER1, seat === SEAT.PLAYER1),
      player2: raceFor(match, SEAT.PLAYER2, seat === SEAT.PLAYER2),
      // A concession is a loss regardless of the clock.
      deadlineReached: true,
    });

    const finalRow = await finalizeMatch(
      tx,
      match,
      outcome ?? ({ result: "draw", resolution: RESOLUTION.DRAW } as RaceOutcome),
      nowMs,
    );

    return { match: finalRow } as const;
  });
}

/** Cancel an open lobby. Only the creator, and only while still waiting. */
export async function cancelMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (match.player1Id !== userId) {
      return err("Only the lobby creator can cancel it", 403);
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return err("Only a waiting lobby can be cancelled", 409);
    }

    const [updated] = await tx
      .update(solitaireDuelMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(solitaireDuelMatches.id, match.id))
      .returning();

    mirrorQueueTransition({
      gameKey: "solitaire-duel",
      matchId: match.id,
      status: "cancelled",
      playerCount: 1,
      cancelReason: "cancelled_by_player",
      at: new Date(nowMs),
    });

    // A cancelled lobby never settled, so no rating, trophy or win counter
    // moves — settleSolitaireDuelMatch is deliberately not called here.
    return { match: updated ?? match } as const;
  });
}

/**
 * Resolve a match whose participant stayed disconnected past the realtime
 * grace window.
 *
 *   • active match → the opponent is awarded the win (standard settlement)
 *   • open lobby   → cancelled, so an abandoned lobby never lingers
 *   • terminal     → no-op, reported (not an error) so the realtime retry loop
 *                    stops instead of hammering the endpoint
 */
export async function forfeitMatchOnDisconnect({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}): Promise<DisconnectResult> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) return err("Not a participant of this match", 403);

    if (TERMINAL_STATUSES.includes(match.status)) {
      return { match, forfeited: false, cancelled: false } as const;
    }

    // Still an open lobby: release it. There is no opponent to award a win to,
    // and a cancelled lobby never settles, so no rating or stat is touched.
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      const [updated] = await tx
        .update(solitaireDuelMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          endedAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitaireDuelMatches.id, match.id))
        .returning();

      mirrorQueueTransition({
        gameKey: "solitaire-duel",
        matchId: match.id,
        status: "cancelled",
        playerCount: 1,
        cancelReason: "disconnected",
        at: new Date(nowMs),
      });

      return { match: updated ?? match, forfeited: false, cancelled: true } as const;
    }

    // Active match: award the opponent the win, with the standard settlement.
    const outcome = resolveRace({
      player1: raceFor(match, SEAT.PLAYER1, seat === SEAT.PLAYER1),
      player2: raceFor(match, SEAT.PLAYER2, seat === SEAT.PLAYER2),
      deadlineReached: true,
    });

    const finalRow = await finalizeMatch(
      tx,
      match,
      outcome ?? ({ result: "draw", resolution: RESOLUTION.DRAW } as RaceOutcome),
      nowMs,
    );

    return { match: finalRow, forfeited: true, cancelled: false } as const;
  });
}

// ── Finalisation + settlement (existing platform infrastructure only) ─────

/**
 * Flip a match terminal, exactly once, and settle it.
 *
 * The single write path for `status`, `result`, `winnerId`, `resolution_reason`
 * and `ended_at` — reached by completion, by the deadline, and by a forfeit, so
 * there is one place a result can ever come from. The `TERMINAL_STATUSES` guard
 * plus the caller's `FOR UPDATE` read is what makes a second attempt a no-op
 * rather than a second settlement.
 */
async function finalizeMatch(
  tx: any,
  match: MatchRow,
  outcome: RaceOutcome,
  nowMs: number,
): Promise<MatchRow> {
  if (TERMINAL_STATUSES.includes(match.status)) return match;

  const seats = seatsFromRow(match);
  const winnerId =
    outcome.result === RESULT.DRAW ? null : userIdForSeat(seats, outcome.result);

  const [updated] = await tx
    .update(solitaireDuelMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      result: outcome.result,
      winnerId,
      resolutionReason: outcome.resolution,
      endedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitaireDuelMatches.id, match.id))
    .returning();

  const finalRow = updated ?? match;

  await settleSolitaireDuelMatch(tx, finalRow, outcome);

  mirrorQueueTransition({
    gameKey: "solitaire-duel",
    matchId: finalRow.id,
    status: "completed",
    playerCount: 2,
    cancelReason: null,
    at: new Date(nowMs),
  });

  return finalRow;
}

/**
 * Record the outcome of a finished Solitaire Duel match.
 *
 * Reuses the platform's Elo (`applyRatingResult`) and trophy
 * (`applyTrophyResult`) helpers — there is deliberately no Solitaire-specific
 * rating maths and no custom scoring. Both are called with the store's
 * transaction so the match finalisation and the rating change commit atomically,
 * and both are idempotent per (user, game, match) via their own event journals.
 *
 * No wager, no token, no payout: the game is unstaked, so the only account stats
 * touched are `users.gamesWon` / `users.gamesLost`. The leaderboard counters are
 * deliberately NOT called because `applyLeaderboardCounters` is wager-gated
 * (`bet <= 0` returns early) and this game has no wager — calling it would be a
 * no-op that reads like a bug.
 *
 * A DRAW is journaled by both helpers (with `result: "draw"`, which moves both
 * ratings by K × (0.5 − expected)) but changes neither win counter, exactly as
 * Tic-Tac-Toe and Mini Golf do.
 *
 * NOTE ON THE GAME KEY: the writers are called with the literal
 * `gameKey: "solitaire-duel"`. Until that key is added to `RATED_GAMES`
 * (`src/lib/rating.js`), `applyRatingResult` returns
 * `{ applied: false, reason: "game-not-rated" }` — it REFUSES an unregistered
 * key rather than falling back to another game's ladder, so this seam is inert
 * (never mis-rating, e.g. as chess) until the platform registration lands, and
 * it turns itself on with no change here.
 */
async function settleSolitaireDuelMatch(
  tx: any,
  match: MatchRow,
  outcome: RaceOutcome,
) {
  if (!match.player2Id) return;

  const matchId = String(match.id);

  if (outcome.result === RESULT.DRAW) {
    await applyRatingResult({
      tx,
      gameKey: "solitaire-duel",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: "solitaire-duel",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    return;
  }

  const winnerId =
    outcome.result === RESULT.PLAYER1 ? match.player1Id : match.player2Id;
  const loserId =
    outcome.result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId || winnerId === loserId) return;

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
    gameKey: "solitaire-duel",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "solitaire-duel",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// Re-exported so the routes can assert shape without importing the rules module
// directly, and so the derivability invariant stays discoverable.
export { isWellFormedState, viewForState, progressOf };
export type { SolitaireDeal, SolitaireState, SolitaireView, Seats, SeatProgress, OpponentProgress };
