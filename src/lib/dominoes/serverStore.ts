// src/lib/dominoes/serverStore.ts
//
// The server-authoritative online Dominoes store. Every state transition
// happens inside a row-locked `db.transaction` here; the API routes are thin
// wrappers around these functions.
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The ONLY player-authored values that reach this module are the ACTION ADDRESS
// (`{ type: "play", tile, end }`, `{ type: "draw" }`, `{ type: "pass" }`) and
// the optimistic-concurrency token `expectedVersion`. The chain, both hands,
// the face-down pile, whose turn it is, whether an action is legal, the winner
// and the result are ALL derived from the server's own row by the shared rules
// engine (`validateAction` → `applyAction`). A client cannot submit a hand, a
// chain, an open end, a turn owner, a winner, a pips total or a rating change —
// no such field is ever read.
//
// ── HIDDEN INFORMATION ───────────────────────────────────────────────────
//
// The row keeps public state (`game_state`) apart from the secrets
// (`p1_hand`, `p2_hand`, `draw_pile`) — see the schema comment. `matchToDto`
// is the ONLY projection a client ever sees, and it publishes:
//
//   * the VIEWER's own hand,
//   * the OPPONENT's tile count (never the tiles),
//   * the public chain + both open ends,
//   * the draw-pile COUNT (never the pile),
//   * the turn, the deadline, and the public terminal result.
//
// Nothing else. A broadcast payload is a bare invalidation hint for the same
// reason (see ./rooms).
//
// ── CONCURRENCY ──────────────────────────────────────────────────────────
//
//   1. every mutation takes the match row with `FOR UPDATE`, so two concurrent
//      requests on one match serialise; the second re-reads the row the first
//      wrote and is rejected;
//   2. `move()` compares `expectedVersion` with the authoritative `ply` INSIDE
//      that lock. It is REQUIRED here (unlike Barricade, where a turn is
//      consumed by any action): a DRAW keeps the turn, so without a version a
//      retried draw request would silently consume two tiles;
//   3. the row write is ALSO conditional on the ply it read, and
//      `dominoes_moves` is unique on (match_id, ply) — the storage-level
//      backstop that makes "one persisted action per turn" impossible to
//      violate even if a future code path forgets the check;
//   4. matchmaking runs under one per-game advisory lock
//      (`pg_advisory_xact_lock`) plus a conditional UPDATE, so two callers can
//      never both open a lobby and a caller can never join a lobby that is
//      being cancelled.
//
// ── THE CLOCK ────────────────────────────────────────────────────────────
//
// `turn_deadline_at` is an absolute instant stamped from the SERVER's clock
// (`nowMs`, defaulting to `Date.now()`), never from a client timestamp. An
// expired turn is resolved by `resolveDueTurn`, which applies the engine's
// `applyTimeout` (draw one tile if the pile allows, otherwise pass) and stamps
// the next deadline. It runs:
//
//   * on the authoritative READ (`fetchMatch`) — the platform's documented
//     pattern for clocked games (src/lib/deadlineRead.ts: a deadline becomes a
//     transition inside a read, and no match page polls);
//   * at the START of every mutation, so a late action cannot be accepted
//     against the pre-timeout position: it is refused with a 409 and the clock
//     is advanced in the same transaction.
//
// It is idempotent: the ply-conditional UPDATE and the unique move row mean a
// second resolver — a reconnect, a duplicate read, the opponent's next action —
// finds the deadline already moved and applies nothing. At most ONE timeout is
// resolved per call, so a long-abandoned match catches up one turn per read
// instead of doing unbounded work, and the disconnect forfeit ends it anyway.
//
// ── SETTLEMENT ───────────────────────────────────────────────────────────
//
// A finished match is finalised EXACTLY ONCE: the terminal write is claimed by
// the same ply-conditional UPDATE that applies the action (or the conditional
// `status = playing` UPDATE for a resignation), so the loser of a concurrent
// race is a no-op rather than a second settlement. The shared writers
// (`applyRatingResult` / `applyTrophyResult`) are journal-keyed per
// (user, game, match), so a retry can never apply a reward twice. A blocked
// round on equal pips is a real DRAW and settles as one, with no W/L counters.
//
// ── UNSTAKED, DELIBERATELY ───────────────────────────────────────────────
//
// There is no escrow, pot, rake or payout path in this module, and the table
// has no stake columns. The game is free to play.
//
// COMPETITIVE REGISTRATION: settlement calls the shared writers with the
// literal key `"dominoes"`. Until that key is added to `RATED_GAMES`
// (src/lib/rating.js) the writers refuse it (`game-not-rated`) and nothing is
// mis-rated — `applyRatingResult` checks the registry BEFORE touching a row,
// unlike `normalizeRatingGameKey`, which only affects leaderboard READS. The
// account W/L counters below are platform counters, not Elo, and are updated
// regardless, exactly as every other duel does.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { dominoesMatches, dominoesMoves, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { markDailyRewardWin } from "../dailyRewardWin";
import { coerceAiDifficulty } from "../aiDifficulty";
import { chooseAiAction } from "./ai";
import {
  ACTION_TYPES,
  DOMINOES_AI_PLAYER_ID,
  DOMINOES_LOCK_NAMESPACE,
  END_REASONS,
  MATCH_STATUS,
  RESULT,
  REJECTION,
  TURN_WINDOW_MS,
} from "./constants";
import {
  applyAction,
  applyTimeout,
  isDominoesRuleError,
  otherSeat,
  validateAction,
} from "./rules";
import { dealMatch } from "./deal";
import type { DominoesAction, DominoesState, Seat, TileId } from "./types";

/** The two seats of a row: `player2Id` is null while the row is an open lobby. */
export type Seats = { player1Id: string; player2Id: string | null };

/** A row of `dominoes_matches`. */
export type DominoesMatchRow = typeof dominoesMatches.$inferSelect;

type MatchRow = DominoesMatchRow;

export type StoreError = { error: string; status: number };

/**
 * Structural view of the engine's verdict.
 *
 * The engine returns a discriminated union, but this repo compiles with
 * `strict: false`, where narrowing on a boolean literal discriminant does not
 * work — so the store reads the verdict through this widened shape instead
 * (the same reason the sibling stores do).
 */
type ActionVerdict = { ok: boolean; kind?: string; code?: string; message?: string };

/**
 * Result of resolving a disconnected participant.
 *
 * Spelled as an explicit union (like the Barricade/Tic-Tac-Toe stores) rather
 * than inferred: the route narrows it with `"error" in result`, and under
 * `strict: false` an inferred union of structurally similar objects collapses.
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

/* -------------------------------------------------------------------------- *
 * Seats
 * -------------------------------------------------------------------------- */

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
 * so one player can never read or act on another player's match.
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
  return seat === "player1" ? seats.player1Id : (seats.player2Id ?? null);
}

/* -------------------------------------------------------------------------- *
 * The persisted state: public columns + secret columns
 * -------------------------------------------------------------------------- */

/**
 * The engine state WITHOUT the secrets — exactly what `game_state` stores.
 *
 * Written as an explicit field list (not a destructuring rest) so adding a
 * field to `DominoesState` forces a decision here: is it public, or does it
 * belong in its own secret column?
 */
export function publicStateOf(state: DominoesState): Record<string, unknown> {
  return {
    status: state.status,
    turn: state.turn,
    ply: state.ply,
    chain: state.chain,
    openEnds: state.openEnds,
    startingSeat: state.startingSeat,
    startingTile: state.startingTile,
    winner: state.winner,
    outcome: state.outcome,
    lastAction: state.lastAction,
  };
}

/**
 * Reassemble the engine state from a row: the public columns plus THIS row's
 * two hand columns and the pile. Returns null for a lobby that has no deal yet
 * (the deal is minted when the second seat lands).
 *
 * Reassembly is lossless — no re-shuffle, no re-deal — which is what makes a
 * reconnect (new tab, new device, a dropped socket) restore the identical
 * position, including both hands and the exact order of the pile.
 */
export function stateOf(match: Partial<MatchRow> | null | undefined): DominoesState | null {
  const publicState = match?.gameState as Partial<DominoesState> | null | undefined;
  if (!publicState || typeof publicState !== "object") return null;
  if (!Array.isArray(publicState.chain) || !publicState.openEnds) return null;
  return {
    ...(publicState as DominoesState),
    hands: {
      player1: [...((match?.p1Hand as string[] | null) ?? [])] as TileId[],
      player2: [...((match?.p2Hand as string[] | null) ?? [])] as TileId[],
    },
    drawPile: [...((match?.drawPile as string[] | null) ?? [])] as TileId[],
  };
}

/** The columns a state writes: public state plus the three secret columns. */
function stateColumns(state: DominoesState) {
  return {
    gameState: publicStateOf(state),
    p1Hand: state.hands.player1,
    p2Hand: state.hands.player2,
    drawPile: state.drawPile,
  };
}

/* -------------------------------------------------------------------------- *
 * The clock
 * -------------------------------------------------------------------------- */

/** The row's deadline as epoch milliseconds, or null when it has none. */
function deadlineMsOf(match: Partial<MatchRow> | null | undefined): number | null {
  const value = match?.turnDeadlineAt;
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Has this row's turn window elapsed?
 *
 * Pure and server-clock-only: `nowMs` is supplied by the caller (the routes let
 * it default to `Date.now()`), so the client's countdown is never evidence and
 * a test can step over a deadline deterministically.
 */
export function isTurnExpired(
  match: Partial<MatchRow> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!match || match.status !== MATCH_STATUS.PLAYING) return false;
  const deadline = deadlineMsOf(match);
  return deadline !== null && nowMs >= deadline;
}

/* -------------------------------------------------------------------------- *
 * The viewer projection
 * -------------------------------------------------------------------------- */

/**
 * Client-facing snapshot for `viewerId` — the ONLY shape a client receives.
 *
 * It publishes the viewer's own hand, the opponent's tile COUNT, the public
 * chain and its open ends, the draw-pile COUNT, the turn, the deadline and the
 * public result. It has no field for the opponent's hand or the pile's
 * contents, so a leak would require adding one — see the schema comment.
 *
 * A non-participant gets `viewerSeat: null` and an empty hand; the callers
 * (every route) refuse that request with a 403 before it is ever built.
 */
export function matchToDto(match: MatchRow, viewerId: string | null) {
  const seats = seatsFromRow(match);
  const viewerSeat = seatForUser(seats, viewerId);
  const opponentSeat = viewerSeat ? otherSeat(viewerSeat) : null;
  const state = stateOf(match);

  const viewerHand = viewerSeat && state ? [...state.hands[viewerSeat]] : [];
  const opponentTileCount =
    opponentSeat && state ? state.hands[opponentSeat].length : 0;

  return {
    matchId: match.id,
    status: match.status,
    // Monotonic accepted-action count — the optimistic-concurrency version the
    // client echoes back as `expectedVersion`.
    version: match.ply,
    ply: match.ply,
    viewerSeat,
    opponentSeat,
    isLive: match.status === MATCH_STATUS.PLAYING,
    isViewerTurn: Boolean(viewerSeat && state && state.turn === viewerSeat),
    // ── The viewer's own information ────────────────────────────────────
    hand: viewerHand,
    // ── Public information ──────────────────────────────────────────────
    chain: state?.chain ?? [],
    openEnds: state?.openEnds ?? { left: null, right: null },
    turn: state?.turn ?? null,
    turnUserId: match.currentTurnUserId ?? null,
    turnDeadlineAt: match.turnDeadlineAt ?? null,
    startingSeat: state?.startingSeat ?? null,
    // `startingTile` is deliberately NOT projected. It is the tile that won the
    // opening bid, and until the opening play lands it is still sitting in the
    // starting seat's hand — publishing it would hand the opponent one of its
    // seven tiles. `startingSeat` is public (it is who moves at ply 0).
    // Counts only — never the tiles themselves.
    opponentTileCount,
    drawPileCount: state ? state.drawPile.length : 0,
    // ── Practice ────────────────────────────────────────────────────────
    // A bot seat is declared on the row, so the view never has to guess from
    // an id. It also never appears in the open-lobby pool: the second seat is
    // occupied from creation.
    isAi: Boolean(match.isAi),
    aiDifficulty: match.aiDifficulty ?? null,
    // ── The public result ───────────────────────────────────────────────
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    resultReason: match.resultReason ?? null,
    pips: state?.outcome?.pips ?? null,
    player1Id: match.player1Id,
    player2Id: match.player2Id ?? null,
    startedAt: match.startedAt ?? null,
    endedAt: match.endedAt ?? null,
  };
}

/* -------------------------------------------------------------------------- *
 * Lobby / matchmaking
 * -------------------------------------------------------------------------- */

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(dominoesMatches)
    .where(
      and(
        eq(dominoesMatches.status, MATCH_STATUS.WAITING),
        isNull(dominoesMatches.player2Id),
      ),
    )
    .orderBy(sql`${dominoesMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any (the lobby's "resume" row). */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(dominoesMatches)
    .where(
      and(
        eq(dominoesMatches.status, MATCH_STATUS.WAITING),
        isNull(dominoesMatches.player2Id),
        eq(dominoesMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${dominoesMatches.createdAt} ASC`)
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
 * The DEAL IS MINTED HERE, in the transaction that seats the second player —
 * never when the lobby is opened. A deal created at lobby creation would let a
 * host look at seven tiles, cancel, and re-open until the hand suited them.
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
      sql`SELECT pg_advisory_xact_lock(${DOMINOES_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(dominoesMatches)
      .where(
        and(
          eq(dominoesMatches.status, MATCH_STATUS.WAITING),
          isNull(dominoesMatches.player2Id),
        ),
      )
      .orderBy(sql`${dominoesMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // Already the caller's own lobby — hand it back instead of opening a
      // second one (and never seat the creator against themselves).
      if (open.player1Id === userId) return { match: open, joined: false } as const;
      return await joinExistingMatch(tx, open.id, userId, nowMs);
    }

    return await createWaitingMatch(tx, userId, nowMs);
  });
}

async function createWaitingMatch(tx: any, userId: string, nowMs: number) {
  const [match] = await tx
    .insert(dominoesMatches)
    .values({
      player1Id: userId,
      // No opponent yet: the row IS the open lobby.
      player2Id: null,
      status: MATCH_STATUS.WAITING,
      ply: 0,
      // No deal and no clock until somebody can actually play.
      gameState: null,
      p1Hand: [],
      p2Hand: [],
      drawPile: [],
      currentTurnUserId: null,
      turnDeadlineAt: null,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .returning();

  return { match, joined: false } as const;
}

async function joinExistingMatch(
  tx: any,
  candidateId: string,
  userId: string,
  nowMs: number,
) {
  const [match] = await tx
    .select()
    .from(dominoesMatches)
    .where(eq(dominoesMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }
  if (match.player1Id === userId) {
    return { error: "You already host this lobby", status: 409 } as const;
  }

  // The deal: a fresh 28-tile shuffle. `dealMatch` is the engine's own deal
  // (Web Crypto, injectable in tests) and derives the starting seat from the
  // hands, so the joiner cannot choose who opens.
  const state = dealMatchSafely();
  if (!state) {
    return { error: "Unable to deal the match", status: 500 } as const;
  }

  const seats: Seats = { player1Id: match.player1Id, player2Id: userId };
  const now = new Date(nowMs);
  const [updated] = await tx
    .update(dominoesMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.PLAYING,
      ply: state.ply,
      ...stateColumns(state),
      currentTurnUserId: userIdForSeat(seats, state.turn),
      // The first turn starts now, with the full window.
      turnDeadlineAt: new Date(nowMs + TURN_WINDOW_MS),
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(dominoesMatches.id, candidateId),
        eq(dominoesMatches.status, MATCH_STATUS.WAITING),
        isNull(dominoesMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  return { match: updated, joined: true } as const;
}

/** The pair primitive's result. Plain object — see `DisconnectResult` above for
 *  why a union of structurally similar shapes is not used under `strict: false`. */
export type PairMatchResult =
  | { ok: true; matchId: string }
  | { ok: false; status: number; message: string };

/**
 * PRIVATE ROOMS / FRIEND CHALLENGES — seat two NAMED players in one transaction.
 *
 * This is the primitive the room adapter registry requires
 * (src/lib/rooms/games.ts): the public `createOrJoin` deliberately pairs the
 * caller with ANY waiting row, which cannot express "these two, nobody else".
 *
 * WHAT IT DOES NOT DO: it does not mint a second kind of match. It opens the
 * SAME waiting row the lobby flow opens and seats the second player with the
 * SAME `joinExistingMatch` the public joiner uses — so the deal (minted at join,
 * never at lobby creation), the starting seat, the first deadline, the clock,
 * the move log and the settlement path are byte-for-byte the public ones. A
 * room is therefore never a second source of truth for a Dominoes match.
 *
 * UNOBSERVABLE, DELIBERATELY: both writes happen inside ONE transaction, so
 * `status = 'waiting'` is never visible to another session. The public
 * matchmaker cannot seat a stranger into the room, `listOpenMatches` never
 * lists it, and a crash mid-way leaves no row at all rather than a stale
 * lobby. The per-game advisory lock keeps it serialised with matchmaking, so a
 * concurrent `createOrJoin` cannot interleave with the pair.
 *
 * UNSTAKED: there is no stake argument and no way to pass one — the table has
 * no stake column and the room catalog caps Dominoes at 0
 * (src/lib/rooms/catalog.ts), so a staked room is refused before this is called.
 *
 * Both ids come from the authenticated route, never from a request body's idea
 * of who the players are.
 */
export async function createDominoesMatchForPair({
  hostUserId,
  opponentUserId,
  nowMs = Date.now(),
}: {
  hostUserId: string;
  opponentUserId: string;
  nowMs?: number;
}): Promise<PairMatchResult> {
  const host = typeof hostUserId === "string" ? hostUserId.trim() : "";
  const opponent =
    typeof opponentUserId === "string" ? opponentUserId.trim() : "";
  if (!host || !opponent) {
    return { ok: false, status: 400, message: "Both seats need a player" };
  }
  if (host === opponent) {
    return { ok: false, status: 400, message: "A match needs two different players" };
  }

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${DOMINOES_LOCK_NAMESPACE}, 0)`,
    );

    // Seat 1: the room's host, exactly as the lobby flow seats a creator.
    const created = await createWaitingMatch(tx, host, nowMs);
    const matchId = String(created.match.id);

    // Seat 2: the invited player, through the SAME join path the public
    // matchmaker uses — so the deal is minted here, once, for a pair that is
    // already known.
    const seated = await joinExistingMatch(tx, matchId, opponent, nowMs);
    if ("error" in seated) {
      // Rolls the waiting row back with it: a room that could not seat both
      // players must not leave a lobby behind.
      return {
        ok: false,
        status: seated.status,
        message: seated.error,
      } as const;
    }

    return { ok: true, matchId } as const;
  });
}

/**
 * The engine's deal, isolated so a crypto failure becomes a 500 rather than an
 * unhandled rejection. `dealMatch` uses Web Crypto by default and derives the
 * starting seat from the hands, so nothing here chooses who opens.
 */
function dealMatchSafely(random?: () => number): DominoesState | null {
  try {
    return random ? dealMatch(random) : dealMatch();
  } catch (error) {
    console.error(
      "[dominoes] deal failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * PRACTICE — seat the caller against the Dominoes bot.
 *
 * One row, both seats occupied from creation: the bot is a NAMED id on
 * `player2_id`, never a queue entry, so `listOpenMatches` can never offer it to
 * a stranger and the public matchmaker can never pair two humans into it.
 *
 * UNRATED: the row is `is_ai`, so settlement skips ratings, trophies and the W/L
 * counters (see `settleMatch`). The daily reward still unlocks on a human win,
 * which is the one progression signal free practice is allowed to move.
 *
 * The deal is the SAME engine deal the public match uses, so the opening seat
 * is decided by the tiles, not by the caller — and if the bot won the opening
 * bid, its turn is played inside this transaction. The caller therefore never
 * receives a practice row that is waiting on the bot.
 */
export type AiMatchResult =
  | { match: MatchRow; state: DominoesState }
  | StoreError;

export async function createAiMatch({
  userId,
  difficulty,
  nowMs = Date.now(),
  random = Math.random,
}: {
  userId: string;
  difficulty?: unknown;
  nowMs?: number;
  random?: () => number;
}): Promise<AiMatchResult> {
  if (!userId) return { error: "Not signed in", status: 401 } as const;

  const tier = coerceAiDifficulty(difficulty);
  const state = dealMatchSafely(random);
  if (!state) {
    return { error: "Unable to deal the match", status: 500 } as const;
  }

  const seats: Seats = {
    player1Id: userId,
    player2Id: DOMINOES_AI_PLAYER_ID,
  };
  const now = new Date(nowMs);

  return await db.transaction(async (tx) => {
    const [match] = await tx
      .insert(dominoesMatches)
      .values({
        player1Id: seats.player1Id,
        player2Id: seats.player2Id,
        status: MATCH_STATUS.PLAYING,
        ply: state.ply,
        ...stateColumns(state),
        currentTurnUserId: userIdForSeat(seats, state.turn),
        turnDeadlineAt: new Date(nowMs + TURN_WINDOW_MS),
        isAi: true,
        aiDifficulty: tier,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .returning();

    // The bot may have won the opening bid. Play it now, in the same
    // transaction, so the returned row is never "waiting on the bot".
    const afterBot = await playAiTurns(tx, match, state);
    if (afterBot === state) return { match, state } as const;

    const finished = afterBot.status === MATCH_STATUS.FINISHED;
    const [updated] = await tx
      .update(dominoesMatches)
      .set({
        ...stateColumns(afterBot),
        ply: afterBot.ply,
        status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING,
        currentTurnUserId: finished ? null : userIdForSeat(seats, afterBot.turn),
        turnDeadlineAt: finished ? null : new Date(nowMs + TURN_WINDOW_MS),
        updatedAt: new Date(nowMs),
        ...(finished ? terminalColumns(afterBot, seats, now) : {}),
      })
      .where(eq(dominoesMatches.id, match.id))
      .returning();

    if (finished) {
      await settleMatch(tx, updated ?? match, {
        result: updated?.result ?? afterBot.winner ?? RESULT.DRAW,
        reason: updated?.resultReason ?? afterBot.outcome?.reason ?? null,
      });
    }

    return { match: updated ?? match, state: afterBot } as const;
  });
}

/**
 * Play the bot's turns from `state` until it is the human's turn again or the
 * match is decided, logging each accepted action like a human move.
 *
 * Runs INSIDE the caller's transaction, so a practice turn can never be skipped
 * by a client that forgets to poll: the snapshot the caller gets back already
 * contains the bot's answer. A draw keeps the bot on turn (the engine's rule),
 * which is why this is a loop — the guard only exists so a future engine change
 * cannot spin here forever.
 */
async function playAiTurns(
  tx: any,
  match: MatchRow,
  state: DominoesState,
): Promise<DominoesState> {
  const aiSeat = seatForUser(seatsFromRow(match), DOMINOES_AI_PLAYER_ID);
  if (!aiSeat) return state;

  let current = state;
  let guard = 0;
  while (
    current.status === MATCH_STATUS.PLAYING &&
    current.turn === aiSeat &&
    guard < 64
  ) {
    guard += 1;
    const action = chooseAiAction({
      state: current,
      seat: aiSeat,
      difficulty: match.aiDifficulty,
    });
    if (!action) break;

    const next = applyAction(current, aiSeat, action);
    await tx.insert(dominoesMoves).values({
      matchId: match.id,
      ply: current.ply,
      playerId: DOMINOES_AI_PLAYER_ID,
      ...logValuesFrom(next, false),
    });
    current = next;
  }
  return current;
}

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

/**
 * The authoritative snapshot for the calling participant.
 *
 * This is a READ THAT CAN ADVANCE THE CLOCK: an elapsed turn is resolved here,
 * inside the same row lock, exactly like every other clocked game on the
 * platform (src/lib/deadlineRead.ts). It is also the reconnect path — a
 * refreshed tab or a new device re-reads the same row, and the deal is restored
 * from the columns rather than re-minted.
 *
 * A non-participant gets a 403 — Dominoes online has no spectator mode, which is
 * also what keeps the hidden hands hidden.
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
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(dominoesMatches)
      .where(eq(dominoesMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seat = seatForUser(seatsFromRow(match), userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }

    const resolved = await resolveDueTurn(tx, match, nowMs);
    const current = resolved.match;

    return {
      match: current,
      dto: matchToDto(current, userId),
      /** True when this read itself advanced the clock (the route may push). */
      timedOut: resolved.timedOut,
    } as const;
  });
}

/** The append-only action log for a match, oldest first. */
export async function fetchMatchMoves(matchId: string) {
  return await db
    .select({
      ply: dominoesMoves.ply,
      playerId: dominoesMoves.playerId,
      action: dominoesMoves.action,
      tile: dominoesMoves.tile,
      chainEnd: dominoesMoves.chainEnd,
      timedOut: dominoesMoves.timedOut,
      createdAt: dominoesMoves.createdAt,
    })
    .from(dominoesMoves)
    .where(eq(dominoesMoves.matchId, matchId))
    .orderBy(sql`${dominoesMoves.ply} ASC`);
}

/* -------------------------------------------------------------------------- *
 * The clock resolution
 * -------------------------------------------------------------------------- */

/** Terminal columns for a state the engine has just finished. */
function terminalColumns(state: DominoesState, seats: Seats, now: Date) {
  // A blocked round on equal pips has no winner and is a DRAW; every other
  // terminal state names one. `RESULT.DRAW` is the column's own vocabulary.
  const result = state.winner ?? RESULT.DRAW;
  return {
    status: MATCH_STATUS.FINISHED,
    result,
    winnerId: state.winner ? userIdForSeat(seats, state.winner) : null,
    resultReason: state.outcome?.reason ?? null,
    endedAt: now,
    // A decided match has no clock and no seat on turn.
    turnDeadlineAt: null,
    currentTurnUserId: null,
  };
}

/** The resolved action, as the move log records it. */
function logValuesFrom(state: DominoesState, timedOut: boolean) {
  const action = state.lastAction?.action;
  const isPlay = action?.type === ACTION_TYPES.PLAY;
  return {
    action: action?.type ?? ACTION_TYPES.PASS,
    tile: isPlay ? (action as { tile?: string }).tile ?? null : null,
    chainEnd: isPlay ? (action as { end?: string }).end ?? null : null,
    timedOut,
  };
}

/**
 * Resolve ONE elapsed turn, if the row has one.
 *
 * The engine's `applyTimeout` decides what the clock does (draw one tile when
 * the pile allows, otherwise pass) and whether the round is now over; this
 * function only persists the consequence. `nowMs` is the server's clock.
 *
 * IDEMPOTENCE, in layers:
 *   * the caller already holds the row lock, so two resolvers serialise;
 *   * the UPDATE is conditional on the `ply` this call read, so the second
 *     resolver writes nothing and reports `timedOut: false`;
 *   * the move log's unique (match_id, ply) is the storage backstop.
 *
 * Exactly one turn is resolved per call: a long-abandoned match then catches up
 * one turn per read rather than doing unbounded work in a request.
 */
async function resolveDueTurn(
  tx: any,
  match: MatchRow,
  nowMs: number,
): Promise<{ match: MatchRow; timedOut: boolean }> {
  if (!isTurnExpired(match, nowMs)) return { match, timedOut: false };

  const state = stateOf(match);
  if (!state) return { match, timedOut: false };

  const seats = seatsFromRow(match);
  const seat = state.turn;

  let timedOutState: DominoesState;
  try {
    timedOutState = applyTimeout(state, seat);
  } catch (error) {
    // A terminal/corrupt row: nothing the clock can do. The match keeps its
    // authoritative state; the next action or settlement resolves it.
    if (isDominoesRuleError(error)) return { match, timedOut: false };
    throw error;
  }

  // In practice a timeout can hand the turn to the bot (a pass advances the
  // turn); it answers here, in the same transaction, exactly as it does after a
  // human action.
  const afterBot =
    match.isAi && timedOutState.status === MATCH_STATUS.PLAYING
      ? await playAiTurns(tx, match, timedOutState)
      : timedOutState;

  const finished = afterBot.status === MATCH_STATUS.FINISHED;
  const now = new Date(nowMs);
  const [updated] = await tx
    .update(dominoesMatches)
    .set({
      ...stateColumns(afterBot),
      ply: afterBot.ply,
      status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING,
      currentTurnUserId: finished ? null : userIdForSeat(seats, afterBot.turn),
      turnDeadlineAt: finished ? null : new Date(nowMs + TURN_WINDOW_MS),
      updatedAt: now,
      ...(finished ? terminalColumns(afterBot, seats, now) : {}),
    })
    // The claim: only the transaction that still sees this ply may resolve it.
    .where(
      and(
        eq(dominoesMatches.id, match.id),
        eq(dominoesMatches.ply, match.ply),
      ),
    )
    .returning();

  if (!updated) {
    // Another writer advanced the row first; that outcome stands.
    const [current] = await tx
      .select()
      .from(dominoesMatches)
      .where(eq(dominoesMatches.id, match.id));
    return { match: current ?? match, timedOut: false };
  }

  // The clock's own log row. A duplicate here means this exact turn was already
  // logged; the state write above is authoritative, so it is not an error.
  try {
    await tx.insert(dominoesMoves).values({
      matchId: match.id,
      ply: match.ply,
      playerId: userIdForSeat(seats, seat) ?? "",
      ...logValuesFrom(timedOutState, true),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  if (finished) {
    await settleMatch(tx, updated, {
      result: updated.result ?? null,
      reason: updated.resultReason ?? null,
    });
  }

  return { match: updated, timedOut: true };
}

/* -------------------------------------------------------------------------- *
 * The action (the only gameplay mutation)
 * -------------------------------------------------------------------------- */

export type MoveResult =
  | {
      match: MatchRow;
      state: DominoesState;
      /** The ply the action was taken at (the version the caller echoed). */
      ply: number;
      matchCompleted: boolean;
      winnerSeat: Seat | null;
      result: string | null;
      reason: string | null;
    }
  | StoreError;

/**
 * Parse the client's `expectedVersion`.
 *
 * Accepts a non-negative integer or its exact decimal-string form (`"7"`), and
 * nothing else. Deliberately NOT `Number(value)`, whose empty-string / blank /
 * empty-array coercions all collapse to 0 and would let a malformed request look
 * like the opening position.
 */
function parseVersion(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** Rejection code → HTTP status. Shape errors are 400; position conflicts 409. */
function statusForRejection(code: string): number {
  switch (code) {
    case REJECTION.INVALID_ACTION:
    case REJECTION.INVALID_SEAT:
    case REJECTION.INVALID_TILE:
    case REJECTION.INVALID_END:
      return 400;
    default:
      return 409;
  }
}

/**
 * Take one action: play a tile, draw, or pass.
 *
 * The request carries ONLY the action plus `expectedVersion`. Rejections, in
 * order:
 *
 *   404 match not found
 *   403 caller holds no seat                (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   409 missing / stale `expectedVersion`   (double submit, stale tab, retry)
 *       — and, if this turn's window has already elapsed, the clock is advanced
 *         in this transaction and the action is refused
 *   400 malformed action / unknown tile / bad end
 *   409 the engine refuses the action (not your turn, tile not in hand, does not
 *       match that end, must play, pile empty, pile not empty)
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
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  action: unknown;
  expectedVersion?: unknown;
  nowMs?: number;
}): Promise<MoveResult> {
  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(dominoesMatches)
        .where(eq(dominoesMatches.id, matchId))
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

      // Optimistic concurrency. REQUIRED: a draw keeps the turn, so an
      // unversioned retried draw would consume a second tile.
      //
      // Parsed strictly, never with bare `Number()`: `Number("")`, `Number(" ")`
      // and `Number([])` are all 0, so coercion would silently turn garbage into
      // "this is the opening position". Only a non-negative integer, or its exact
      // decimal string, is a version.
      const expected = parseVersion(expectedVersion);
      if (expected === null) {
        return {
          error: "expectedVersion is required — re-read the match and retry",
          status: 409,
        } as const;
      }
      if (expected !== match.ply) {
        return {
          error: "Stale match state — it is not your turn to act on this position",
          status: 409,
        } as const;
      }

      // A late action is refused, and the clock is advanced for the row so the
      // next read already shows what happened.
      if (isTurnExpired(match, nowMs)) {
        await resolveDueTurn(tx, match, nowMs);
        return {
          error: "That turn has expired — the clock acted for you",
          status: 409,
        } as const;
      }

      const state = stateOf(match);
      if (!state) {
        return { error: "Match has no active position", status: 409 } as const;
      }

      const validation = validateAction(state, seat, action as DominoesAction) as ActionVerdict;
      if (!validation.ok) {
        const code = validation.code ?? REJECTION.INVALID_ACTION;
        return {
          error: validation.message ?? "That action is not legal here",
          status: statusForRejection(code),
        } as StoreError;
      }

      // The engine decides the next position. It re-validates, so a mismatch
      // between the verdict above and this call is impossible.
      const next = applyAction(state, seat, action as DominoesAction);

      // Log FIRST: the unique (match_id, ply) index is what turns a duplicated
      // or racing submission into a clean 409 without a second state write.
      await tx.insert(dominoesMoves).values({
        matchId: match.id,
        ply: match.ply,
        playerId: userId,
        ...logValuesFrom(next, false),
      });

      // Free practice: the bot answers INSIDE this same transaction, so its turn
      // can never be skipped by a client that forgets to poll, and the snapshot
      // the caller gets back already reflects it.
      const finalState =
        match.isAi && next.status === MATCH_STATUS.PLAYING
          ? await playAiTurns(tx, match, next)
          : next;

      const finished = finalState.status === MATCH_STATUS.FINISHED;
      const now = new Date(nowMs);
      const [updated] = await tx
        .update(dominoesMatches)
        .set({
          ...stateColumns(finalState),
          ply: finalState.ply,
          status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.PLAYING,
          currentTurnUserId: finished ? null : userIdForSeat(seats, finalState.turn),
          // Every accepted action starts a fresh window for whoever is next —
          // including a draw, which keeps the same seat on turn.
          turnDeadlineAt: finished ? null : new Date(nowMs + TURN_WINDOW_MS),
          updatedAt: now,
          ...(finished ? terminalColumns(finalState, seats, now) : {}),
        })
        // Belt-and-braces version guard: with the row lock this can only fail
        // if a future code path writes the row without locking it.
        .where(
          and(
            eq(dominoesMatches.id, match.id),
            eq(dominoesMatches.ply, match.ply),
          ),
        )
        .returning();

      if (!updated) {
        return { error: "Match state changed — please retry", status: 409 } as const;
      }

      if (finished) {
        await settleMatch(tx, updated, {
          result: updated.result ?? null,
          reason: updated.resultReason ?? null,
        });
      }

      return {
        match: updated,
        state: finalState,
        ply: match.ply,
        matchCompleted: finished,
        winnerSeat: finalState.winner,
        result: updated.result ?? null,
        reason: updated.resultReason ?? null,
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

/* -------------------------------------------------------------------------- *
 * Forfeit / cancel / disconnect
 * -------------------------------------------------------------------------- */

/** Resign: the opponent wins the match, with the same settlement path. */
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
      .from(dominoesMatches)
      .where(eq(dominoesMatches.id, matchId))
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
    const now = new Date(nowMs);
    const [updated] = await tx
      .update(dominoesMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        resultReason: END_REASONS.RESIGNED,
        turnDeadlineAt: null,
        currentTurnUserId: null,
        // The position is left EXACTLY as the engine last wrote it: resigning
        // ends the match, it does not draw or play a tile.
        endedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(dominoesMatches.id, match.id),
          eq(dominoesMatches.status, MATCH_STATUS.PLAYING),
        ),
      )
      .returning();

    if (!updated) {
      return { error: "Match is no longer active", status: 409 } as const;
    }

    await settleMatch(tx, updated, {
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
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(dominoesMatches)
      .where(eq(dominoesMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.player1Id !== userId) {
      return { error: "Only the lobby creator can cancel it", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return { error: "Only a waiting lobby can be cancelled", status: 409 } as const;
    }

    const now = new Date(nowMs);
    const [updated] = await tx
      .update(dominoesMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        resultReason: END_REASONS.ABANDONED,
        endedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(dominoesMatches.id, match.id),
          eq(dominoesMatches.status, MATCH_STATUS.WAITING),
        ),
      )
      .returning();

    if (!updated) {
      return { error: "Lobby is no longer open", status: 409 } as const;
    }

    // A cancelled lobby never settled: no result is recorded and nothing is
    // awarded (`settleMatch` is deliberately not called).
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
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}): Promise<DisconnectResult> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(dominoesMatches)
      .where(eq(dominoesMatches.id, matchId))
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

    const now = new Date(nowMs);

    // Still an open lobby: release it. There is no opponent to award a win to.
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      const [released] = await tx
        .update(dominoesMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          resultReason: END_REASONS.ABANDONED,
          endedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dominoesMatches.id, match.id),
            eq(dominoesMatches.status, MATCH_STATUS.WAITING),
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
      .update(dominoesMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        resultReason: END_REASONS.ABANDONED,
        turnDeadlineAt: null,
        currentTurnUserId: null,
        endedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(dominoesMatches.id, match.id),
          eq(dominoesMatches.status, MATCH_STATUS.PLAYING),
        ),
      )
      .returning();

    if (!updated) {
      // An action or a resignation settled it first — that result stands.
      const [current] = await tx
        .select()
        .from(dominoesMatches)
        .where(eq(dominoesMatches.id, match.id));
      return { match: current ?? match, forfeited: false, cancelled: false } as const;
    }

    await settleMatch(tx, updated, {
      result: winnerSeat,
      reason: END_REASONS.ABANDONED,
    });

    return { match: updated, forfeited: true, cancelled: false } as const;
  });
}

/* -------------------------------------------------------------------------- *
 * Settlement
 * -------------------------------------------------------------------------- */

/**
 * Finalise a finished match — the ONE place the terminal result is recorded.
 *
 * Called only from the transaction that already claimed the match (the
 * ply-conditional action write, or the `status = playing` conditional UPDATE for
 * a resignation), so it runs exactly once per match: a second concurrent request
 * finds the row already terminal and never reaches here. That claim is what
 * makes settlement idempotent at the match level; the shared writers add their
 * own (user, game, match) journal on top.
 *
 * RATED, through the platform's existing progression helpers and no maths of
 * its own:
 *
 *   * `applyRatingResult`  — per-game Elo (src/lib/rating.js, maths in
 *                            src/lib/elo.js). The key must be registered in
 *                            `RATED_GAMES` before the writer accepts it; until
 *                            then it answers `game-not-rated` and changes
 *                            nothing, which is the safe direction.
 *   * `applyTrophyResult`  — per-game trophies (src/lib/trophyStore.js), whose
 *                            registry IS `RATED_GAMES` (TROPHY_GAMES).
 *   * `users.gamesWon` / `users.gamesLost` — the account W/L counters the
 *                            profile and the classement page read.
 *
 * A DRAW (blocked on equal pips) settles with `result: "draw"` and touches no
 * W/L counter — the Tic-Tac-Toe precedent. Resignation and disconnect forfeit
 * name a winner and settle like a played-out victory.
 *
 * Both writers are called with THIS transaction, so the terminal result and the
 * progression commit atomically, and both are best-effort (`catch(() => {})`)
 * exactly like every other duel: a progression failure must never un-finish a
 * decided match.
 */
async function settleMatch(
  tx: any,
  match: MatchRow,
  outcome: { result: string | null; reason: string | null },
): Promise<void> {
  // Both seats must be real accounts: a lobby with no opponent never settles.
  if (!match.player2Id) return;

  // PRACTICE IS UNRATED. A bot seat is not an account, so ratings, trophies and
  // the W/L counters stay untouched; a human win still unlocks the daily reward.
  if (match.isAi) {
    const winnerId =
      outcome.result === RESULT.PLAYER1
        ? match.player1Id
        : outcome.result === RESULT.PLAYER2
          ? match.player2Id
          : null;
    if (
      outcome.result !== RESULT.DRAW &&
      winnerId &&
      winnerId !== DOMINOES_AI_PLAYER_ID
    ) {
      await markDailyRewardWin(tx, winnerId).catch(() => {});
    }
    return;
  }

  const player1 = match.player1Id;
  const player2 = match.player2Id;
  if (String(player1) === String(player2)) return;

  const matchId = String(match.id);

  if (outcome.result === RESULT.DRAW) {
    await applyRatingResult({
      tx,
      gameKey: "dominoes",
      matchId,
      winnerClerkId: player1,
      loserClerkId: player2,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: "dominoes",
      matchId,
      winnerClerkId: player1,
      loserClerkId: player2,
      result: "draw",
    }).catch(() => {});
    return;
  }

  const winnerId =
    outcome.result === RESULT.PLAYER1
      ? player1
      : outcome.result === RESULT.PLAYER2
        ? player2
        : null;
  const loserId =
    winnerId === player1 ? player2 : winnerId === player2 ? player1 : null;
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
    gameKey: "dominoes",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "dominoes",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}
