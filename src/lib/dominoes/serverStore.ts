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
import {
  dominoesMatches,
  dominoesMoves,
  dominoesRounds,
  users,
} from "../../db/schema";
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
  MATCH_TARGET_POINTS,
  RESULT,
  REJECTION,
  SEATS,
  STARTING_RULES,
  TURN_WINDOW_MS,
} from "./constants";
import {
  applyAction,
  applyTimeout,
  cloneState,
  isDominoesRuleError,
  otherSeat,
  validateAction,
} from "./rules";
import { matchVerdict } from "./match";
import { dealMatch, dealNextRound } from "./deal";
import type {
  DominoesAction,
  DominoesState,
  Seat,
  StartingRule,
  TileId,
} from "./types";

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
/** The public record of one completed round (never a hand). */
export type RoundSnapshot = {
  roundNumber: number;
  player1Pips: number;
  player2Pips: number;
  player1Points: number;
  player2Points: number;
  winnerSeat: string | null;
  endReason: string;
  completedAt: Date | null;
};

export function matchToDto(
  match: MatchRow,
  viewerId: string | null,
  lastRound: RoundSnapshot | null = null,
) {
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
    // `startingTile` is deliberately NOT projected. When the deal opened with a
    // double it is on the chain and the chain already says so; when it did not
    // (no double anywhere), the tile is still in the starting seat's hand and
    // publishing it would hand the opponent one of its tiles. `startingSeat` is
    // public, and so is the chain: between them a client can read the whole
    // opening without the engine's internal label being on the wire.
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
    // ── The MATCH scoreboard (points, never tiles) ──────────────────────
    // Cumulative points carried across rounds, the round in progress and the
    // target to reach. `result`/`winnerId` above describe the MATCH; a round's
    // own result is only in `dominoes_rounds` (and, until the next deal,
    // `roundPoints` here).
    scores: {
      player1: scoreOf(match, SEATS[0]),
      player2: scoreOf(match, SEATS[1]),
    },
    matchTarget: MATCH_TARGET_POINTS,
    roundNumber: roundNumberOf(match),
    roundPoints: state?.outcome?.points ?? null,
    /**
     * The LAST COMPLETED ROUND: pips, points, winner and reason — and nothing
     * else. The round that just closed stays on the projection for the whole next
     * round, which is what lets the board announce it without racing the deal.
     * No hand is ever selected here: the secret columns are not touched.
     */
    lastRound: lastRound ?? null,
    previousRoundWinner: (match.previousRoundWinner as Seat | null) ?? null,
    previousStartingSeat: (match.previousStartingSeat as Seat | null) ?? null,
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
  // hands — and, when the deal carries a double, places that double on the chain
  // — so neither the joiner nor the host can choose who opens, or how.
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

  // The deal's own opening tile, logged now that the row really started. A
  // racing joiner that lost the UPDATE above returns before this, so a match
  // that was never created leaves no move behind.
  await logOpeningPlacement(tx, String(candidateId), seats, state);

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
 * The deal for a round that ALREADY has a starting seat (round 2 onwards).
 *
 * Same engine deal as round 1 — a fresh shuffled double-six set, 7 / 7 / 14 — but
 * the opener is IMPOSED (`startingSeat`) instead of won by the tiles, and no
 * opening tile is placed for it: that seat opens the empty chain by hand with any
 * tile it likes. Wrapped so a crypto failure becomes a handled `null`.
 */
function dealRoundSafely(
  startingSeat: Seat,
  rule: StartingRule,
): DominoesState | null {
  try {
    return dealNextRound({ startingSeat, rule });
  } catch (error) {
    console.error(
      "[dominoes] round deal failed:",
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

    // The deal's own opening tile, if it came with one — logged at ply 0, by
    // whichever seat the engine credited with the placement (the bot included).
    await logOpeningPlacement(tx, String(match.id), seats, state);

    // After the opening placement the turn belongs to the other seat, so the bot
    // may still owe a turn. Play it now, in the same transaction, so the returned
    // row is never "waiting on the bot".
    const afterBot = await playAiTurns(tx, match, state);
    if (afterBot === state) return { match, state } as const;

    const roundEnded = afterBot.status === MATCH_STATUS.FINISHED;
    const plan = roundEnded
      ? await advanceAfterRound({ tx, match, state: afterBot, seats, nowMs })
      : null;
    const [updated] = await tx
      .update(dominoesMatches)
      .set(
        plan
          ? plan.columns
          : {
              ...stateColumns(afterBot),
              ply: afterBot.ply,
              status: MATCH_STATUS.PLAYING,
              currentTurnUserId: userIdForSeat(seats, afterBot.turn),
              turnDeadlineAt: new Date(nowMs + TURN_WINDOW_MS),
              updatedAt: new Date(nowMs),
            },
      )
      .where(eq(dominoesMatches.id, match.id))
      .returning();

    if (plan?.matchFinished) {
      await settleMatch(tx, updated ?? match, {
        result: plan.result,
        reason: plan.reason,
      });
    }

    return { match: updated ?? match, state: plan ? plan.state : afterBot } as const;
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

    // The last COMPLETED round, for the round-result announcement. Pips and
    // points were public the moment the round closed; no hand, no pile.
    let lastRound: RoundSnapshot | null = null;
    try {
      const [row] = await tx
        .select({
          roundNumber: dominoesRounds.roundNumber,
          player1Pips: dominoesRounds.player1Pips,
          player2Pips: dominoesRounds.player2Pips,
          player1Points: dominoesRounds.player1Points,
          player2Points: dominoesRounds.player2Points,
          winnerSeat: dominoesRounds.winnerSeat,
          endReason: dominoesRounds.endReason,
          completedAt: dominoesRounds.completedAt,
        })
        .from(dominoesRounds)
        .where(eq(dominoesRounds.matchId, matchId))
        .orderBy(sql`${dominoesRounds.roundNumber} DESC`)
        .limit(1);
      lastRound = (row as RoundSnapshot | undefined) ?? null;
    } catch {
      // An adornment: the board renders without it rather than failing the read.
      lastRound = null;
    }

    return {
      match: current,
      dto: matchToDto(current, userId, lastRound),
      /** True when this read itself advanced the clock (the route may push). */
      timedOut: resolved.timedOut,
    } as const;
  });
}

/**
 * The completed rounds of a match, oldest first.
 *
 * Every round ever played, never just the latest: `dominoes_rounds` is
 * append-only and UNIQUE per (match, round), so this is the full history the
 * match screen can render. It carries no hands — only end-of-round pips, the
 * points those were worth, the round's winner and why it ended.
 */
export async function fetchMatchRounds(matchId: string) {
  if (!isMatchId(matchId)) return [];
  return await db
    .select({
      roundNumber: dominoesRounds.roundNumber,
      player1Pips: dominoesRounds.player1Pips,
      player2Pips: dominoesRounds.player2Pips,
      player1Points: dominoesRounds.player1Points,
      player2Points: dominoesRounds.player2Points,
      winnerSeat: dominoesRounds.winnerSeat,
      endReason: dominoesRounds.endReason,
      completedAt: dominoesRounds.completedAt,
    })
    .from(dominoesRounds)
    .where(eq(dominoesRounds.matchId, matchId))
    .orderBy(sql`${dominoesRounds.roundNumber} ASC`);
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

/* -------------------------------------------------------------------------- *
 * Rounds and the match scoreboard
 * -------------------------------------------------------------------------- */

/**
 * How many rounds one transaction may close.
 *
 * A request closes exactly ONE round in every reachable position: a fresh deal
 * cannot be emptied by the bot's next turn. The bound exists so a future engine
 * change (or a corrupted row) can never spin here — after that many rounds the
 * match is left LIVE on the round that was dealt last, never decided arbitrarily.
 */
const MAX_ROUNDS_PER_CALL = 3;

/** The round a row is on. Rows written before rounds existed are round 1. */
function roundNumberOf(row: Partial<MatchRow> | null | undefined): number {
  const value = Number(row?.roundNumber ?? 1);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** A cumulative score, normalised (a pre-rounds row has none). */
function scoreOf(row: Partial<MatchRow> | null | undefined, seat: Seat): number {
  const value = Number(
    seat === SEATS[0] ? row?.player1Score : row?.player2Score,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The columns that finish a MATCH (a finished ROUND does not use these). */
function matchTerminalColumns(
  result: string | null,
  reason: string | null,
  seats: Seats,
  now: Date,
) {
  const winnerSeat =
    result === RESULT.PLAYER1
      ? SEATS[0]
      : result === RESULT.PLAYER2
        ? SEATS[1]
        : null;
  return {
    status: MATCH_STATUS.FINISHED,
    result,
    winnerId: winnerSeat ? userIdForSeat(seats, winnerSeat) : null,
    resultReason: reason,
    endedAt: now,
    // A decided match has no clock and no seat on turn.
    turnDeadlineAt: null,
    currentTurnUserId: null,
  };
}

/** One completed round, as the store records it. */
type RoundSummary = {
  roundNumber: number;
  pips: Record<Seat, number>;
  points: Record<Seat, number>;
  winner: Seat | null;
  reason: string;
};

/**
 * Append one completed round to `dominoes_rounds`.
 *
 * IDEMPOTENT, deliberately: the table is UNIQUE on (match_id, round_number) and
 * this insert is ON CONFLICT DO NOTHING, so a retried request — or a resolver
 * racing another writer — can never create a second row for the same round, and
 * an old round is never overwritten by a newer one.
 */
async function recordRound(
  tx: any,
  matchId: string,
  summary: RoundSummary,
  now: Date,
): Promise<void> {
  const values = {
    matchId,
    roundNumber: summary.roundNumber,
    player1Pips: summary.pips.player1,
    player2Pips: summary.pips.player2,
    player1Points: summary.points.player1,
    player2Points: summary.points.player2,
    winnerSeat: summary.winner,
    endReason: summary.reason,
    completedAt: now,
  };
  try {
    const query = tx.insert(dominoesRounds).values(values);
    await (typeof query?.onConflictDoNothing === "function"
      ? query.onConflictDoNothing()
      : query);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/** What closing a round means for the row, the caller and the next round. */
type RoundPlan = {
  /** Row columns to write (a live next round, or a finished match). */
  columns: any;
  /** True only when the MATCH is over (a seat reached the target). */
  matchFinished: boolean;
  /** `player1 | player2 | draw` when the match is over, else null. */
  result: string | null;
  /** The match's winning seat, or null on a level finish. */
  resultSeat: Seat | null;
  reason: string | null;
  /** The position the caller should report: the next round, or the last one. */
  state: DominoesState;
  scores: Record<Seat, number>;
  roundNumber: number;
  rounds: RoundSummary[];
};

/**
 * Close the finished round(s) and walk the match forward.
 *
 * Everything here happens INSIDE the transaction that already holds the match
 * row and has just applied the action, so the whole sequence — record the
 * round, add its points, decide the match, deal the next round, log its opening
 * placement, let the bot answer — commits or rolls back as one unit. A round is
 * therefore never recorded without its points, and a match is never finished
 * without its final round.
 *
 * PLY IS NEVER RESET: a fresh round's state is rebased onto the ply the previous
 * round ended at (`current.ply + deal.ply`). The version therefore stays monotonic
 * across the whole match and `dominoes_moves`' unique (match_id, ply) still makes
 * a replayed action a clean conflict rather than a second move.
 *
 * WHO OPENS. The previous round's winner, and it opens the fresh chain BY HAND
 * with any tile — the deal places no opening tile for it. A level round inherits
 * no winner, so the bid alternates. Round 1 is the only round whose opener is
 * decided by the tiles.
 *
 * A match is over when `matchVerdict` says one seat LEADS at MATCH_TARGET_POINTS;
 * a level crossing is a TIEBREAK, not a draw, so the series keeps going. The
 * round's own outcome stays in `dominoes_rounds`, never only in the row.
 */
async function advanceAfterRound({
  tx,
  match,
  state,
  seats,
  nowMs,
}: {
  tx: any;
  match: MatchRow;
  state: DominoesState;
  seats: Seats;
  nowMs: number;
}): Promise<RoundPlan> {
  const now = new Date(nowMs);
  const matchId = String(match.id);
  const scores: Record<Seat, number> = {
    player1: scoreOf(match, SEATS[0]),
    player2: scoreOf(match, SEATS[1]),
  };
  const rounds: RoundSummary[] = [];

  let current = state;
  let roundNumber = roundNumberOf(match);
  let previousRoundWinner = (match.previousRoundWinner as Seat | null) ?? null;
  // The seat the round being CLOSED started with. A level round hands the next
  // opening bid to the other seat, so this one value is all that fallback needs.
  let startingSeat: Seat =
    (match.previousStartingSeat as Seat | null) ??
    (state.startingSeat as Seat) ??
    SEATS[0];

  /** The row as a decided MATCH (a finished ROUND is never a match result). */
  const finished = (
    result: string | null,
    reason: string | null,
    seat: Seat | null,
  ): RoundPlan => ({
    columns: {
      // The final position is written WITH the result: a terminal row must not
      // keep the position from before the action that ended it.
      ...stateColumns(current),
      ply: current.ply,
      ...matchTerminalColumns(result, reason, seats, now),
      player1Score: scores.player1,
      player2Score: scores.player2,
      roundNumber,
      previousRoundWinner,
      previousStartingSeat: startingSeat,
    },
    matchFinished: true,
    result,
    resultSeat: seat,
    reason,
    state: current,
    scores: { ...scores },
    roundNumber,
    rounds,
  });

  /** The row as a LIVE round: PLAYING, a seat on turn and a fresh clock. */
  const live = (roundState: DominoesState): RoundPlan => ({
    columns: {
      ...stateColumns(roundState),
      ply: roundState.ply,
      status: MATCH_STATUS.PLAYING,
      currentTurnUserId: userIdForSeat(seats, roundState.turn),
      turnDeadlineAt: new Date(nowMs + TURN_WINDOW_MS),
      roundNumber,
      player1Score: scores.player1,
      player2Score: scores.player2,
      previousRoundWinner,
      previousStartingSeat: startingSeat,
      // A live round has no match result — the round's own result is in
      // `dominoes_rounds`, and `game_state.outcome` describes the live deal.
      result: null,
      winnerId: null,
      resultReason: null,
      updatedAt: now,
    },
    matchFinished: false,
    result: null,
    resultSeat: null,
    reason: null,
    state: roundState,
    scores: { ...scores },
    roundNumber,
    rounds,
  });

  /**
   * Who opens the next round.
   *
   * The previous round's WINNER, always — the seat that emptied its hand, or the
   * seat the blocked round scored more for. A LEVEL round has no winner to
   * inherit, so the bid ALTERNATES: the seat that did not start the round just
   * closed opens the next one. Deterministic, and read off the row rather than
   * re-derived from the tiles.
   */
  const nextStarter = (roundWinner: Seat | null): Seat =>
    roundWinner ?? otherSeat(startingSeat);

  /**
   * Shuffle a fresh double-six set and hand the opening bid to `starter`.
   *
   * Nothing is placed for it: that seat opens the empty chain BY HAND with any
   * tile (no double required), which is the multi-round rule. The new state's ply
   * is rebased onto the ply the last round ended at, so the version keeps climbing
   * for the whole match and `dominoes_moves`' unique (match_id, ply) still makes a
   * replayed action a conflict rather than a second move.
   */
  const openRound = async (
    starter: Seat,
    roundWinner: Seat | null,
  ): Promise<DominoesState | null> => {
    const deal = dealRoundSafely(
      starter,
      roundWinner ? STARTING_RULES.PREVIOUS_WINNER : STARTING_RULES.ALTERNATE,
    );
    if (!deal) return null;
    let next = cloneState({ ...deal, ply: current.ply + deal.ply });
    // Free practice: when the bid landed on the bot's seat it answers at once, in
    // this transaction, so the new round never opens on a stale bot turn/deadline.
    if (match.isAi) next = await playAiTurns(tx, match, next);
    roundNumber += 1;
    startingSeat = starter;
    return next;
  };

  for (let guard = 0; guard < MAX_ROUNDS_PER_CALL; guard += 1) {
    // A round that is still live needs no work — this is the normal exit.
    if (current.status !== MATCH_STATUS.FINISHED) return live(current);

    const outcome = current.outcome;
    const summary: RoundSummary = {
      roundNumber,
      pips: {
        player1: Number(outcome?.pips?.player1) || 0,
        player2: Number(outcome?.pips?.player2) || 0,
      },
      points: {
        player1: Number(outcome?.points?.player1) || 0,
        player2: Number(outcome?.points?.player2) || 0,
      },
      winner: current.winner ?? null,
      reason: outcome?.reason ?? END_REASONS.BLOCKED_PIPS,
    };

    await recordRound(tx, matchId, summary, now);
    rounds.push(summary);

    // Points are added from the ENGINE's own record of the round, never from a
    // request body, and only inside the write that claimed this ply.
    scores.player1 += summary.points.player1;
    scores.player2 += summary.points.player2;
    previousRoundWinner = summary.winner;

    const verdict = matchVerdict(scores);
    if (verdict.finished) {
      return finished(verdict.result, END_REASONS.MATCH_TARGET, verdict.seat);
    }

    // Undecided. `verdict.tiebreak` is the level crossing of the target: no seat
    // may be declared, so a TIEBREAK round is dealt like any other and the match
    // is judged again after it — round after round until the totals differ.
    const next = await openRound(nextStarter(summary.winner), summary.winner);
    if (!next) {
      // No shuffle available (no Web Crypto). Finish the match on this round's
      // own result rather than leave a finished position inside a live row.
      return finished(
        summary.winner ?? RESULT.DRAW,
        summary.reason,
        summary.winner,
      );
    }
    current = next;
  }

  if (current.status !== MATCH_STATUS.FINISHED) return live(current);

  // Guard exhausted on a closed round: never invent a winner. Deal the round the
  // loop would have dealt (the tiebreak round) and hand the match back LIVE.
  const tiebreak = await openRound(otherSeat(startingSeat), null);
  if (tiebreak) return live(tiebreak);
  return finished(
    current.winner ?? RESULT.DRAW,
    current.outcome?.reason ?? END_REASONS.BLOCKED_PIPS,
    current.winner ?? null,
  );
}

/**
 * Log the deal's OWN opening placement, when the deal came with one.
 *
 * The highest double is played by the deal itself (`createInitialState`), so a
 * match can start with a tile already on the chain and the move log has to
 * explain it — otherwise the first thing a player reads is a board that has a
 * tile none of the logged actions put there.
 *
 * It is recorded at ply 0: the turn number that was OPEN when it happened (the
 * schema's own meaning for the column), which is also the version the first real
 * action is taken against. `logValuesFrom` reads the placement off the state's
 * own `lastAction`, so the tile and the end come from the engine, not from here.
 * A deal with no double anywhere opens by hand and logs nothing yet.
 */
async function logOpeningPlacement(
  tx: any,
  matchId: string,
  seats: Seats,
  state: DominoesState,
  /** The ply the placement was made at: 0 for the first round, the ply the
   *  previous round ended at for every later one. */
  ply = 0,
): Promise<void> {
  const record = state.lastAction;
  if (!record || record.action.type !== ACTION_TYPES.PLAY) return;
  await tx.insert(dominoesMoves).values({
    matchId,
    ply,
    playerId: userIdForSeat(seats, record.seat) ?? "",
    ...logValuesFrom(state, false),
  });
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

  const roundEnded = afterBot.status === MATCH_STATUS.FINISHED;
  const now = new Date(nowMs);
  // A clock action can end the ROUND (an empty pile, a pass, or the draw that
  // empties it). The round is recorded and the scores advanced here, in the
  // same transaction and under the same ply claim as any player's action.
  const plan = roundEnded
    ? await advanceAfterRound({ tx, match, state: afterBot, seats, nowMs })
    : null;
  const [updated] = await tx
    .update(dominoesMatches)
    .set(
      plan
        ? plan.columns
        : {
            ...stateColumns(afterBot),
            ply: afterBot.ply,
            status: MATCH_STATUS.PLAYING,
            currentTurnUserId: userIdForSeat(seats, afterBot.turn),
            turnDeadlineAt: new Date(nowMs + TURN_WINDOW_MS),
            updatedAt: now,
          },
    )
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

  if (plan?.matchFinished) {
    await settleMatch(tx, updated, {
      result: plan.result,
      reason: plan.reason,
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
      /** The position to report: the next round, or the round that just ended. */
      state: DominoesState;
      /** The ply the action was taken at (the version the caller echoed). */
      ply: number;
      /**
       * The action the SERVER applied for this request ('play' | 'draw' |
       * 'pass'). Reported separately from `state.lastAction`, which may already
       * be the next round's opening placement once a round has advanced.
       */
      appliedAction: string | null;
      /** True only when the MATCH is over (a seat reached the target). */
      matchCompleted: boolean;
      /** True when this action ended a ROUND (which may or may not end the match). */
      roundCompleted: boolean;
      /** The round in progress after this action. */
      roundNumber: number;
      /** Cumulative match points after this action. */
      scores: Record<Seat, number>;
      /** The match's winning seat when it is over, else the round's winner. */
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

      const roundEnded = finalState.status === MATCH_STATUS.FINISHED;
      const now = new Date(nowMs);
      // A finished ROUND is not a finished MATCH: `advanceAfterRound` records
      // the round, adds its points and deals the next one (or ends the match at
      // the target) — all under the same ply claim below.
      const plan = roundEnded
        ? await advanceAfterRound({ tx, match, state: finalState, seats, nowMs })
        : null;
      const [updated] = await tx
        .update(dominoesMatches)
        .set(
          plan
            ? plan.columns
            : {
                ...stateColumns(finalState),
                ply: finalState.ply,
                status: MATCH_STATUS.PLAYING,
                currentTurnUserId: userIdForSeat(seats, finalState.turn),
                // Every accepted action starts a fresh window for whoever is
                // next — including a draw, which keeps the same seat on turn.
                turnDeadlineAt: new Date(nowMs + TURN_WINDOW_MS),
                updatedAt: now,
              },
        )
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

      if (plan?.matchFinished) {
        await settleMatch(tx, updated, {
          result: plan.result,
          reason: plan.reason,
        });
      }

      return {
        match: updated,
        state: plan ? plan.state : finalState,
        ply: match.ply,
        appliedAction: next.lastAction?.action.type ?? null,
        matchCompleted: Boolean(plan?.matchFinished),
        roundCompleted: roundEnded,
        roundNumber: plan ? plan.roundNumber : roundNumberOf(updated),
        scores: plan
          ? plan.scores
          : {
              player1: scoreOf(updated, SEATS[0]),
              player2: scoreOf(updated, SEATS[1]),
            },
        winnerSeat: plan?.matchFinished ? plan.resultSeat : finalState.winner,
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
