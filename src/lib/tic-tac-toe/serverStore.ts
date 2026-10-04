// src/lib/tic-tac-toe/serverStore.ts
//
// The server-authoritative Tic-Tac-Toe Duel match store. Every state transition
// in the game happens inside a row-locked `db.transaction` here, and the API
// routes are thin wrappers around these functions.
//
// TRUST BOUNDARY: the ONLY player-authored values that reach this module are
// `boardIndex` and `cellIndex` — which board, and which cell on it. The mark,
// the boards, whose turn it is, every board's control, the stage, the Mega
// winner, the tiebreaker, the match result, the rating change and the trophies
// are all computed from the server's own authoritative state by the pure rules
// engine (`applyMove`). A client cannot submit a winner, a result, a score, a
// turn, a board, a round/stage, an Elo value, a trophy or a completion flag —
// no such field is ever read.
//
// Settlement reuses the platform's existing rating/trophy infrastructure
// (`applyRatingResult` / `applyTrophyResult`) inside the SAME transaction that
// finalises the match, exactly once — the guard is the `status` flip to
// `finished` under a `FOR UPDATE` lock, plus those helpers' own
// (user, game, match)-keyed idempotency journals. There is NO second Elo
// implementation and NO wager/token/payout path anywhere in this file.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { ticTacToeMatches, ticTacToeMoves, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import {
  CELL_COUNT,
  MATCH_STATUS,
  MAX_BOARDS,
  RESULT,
  TIC_TAC_TOE_AI_PLAYER_ID,
  TIC_TAC_TOE_LOCK_NAMESPACE,
} from "./constants";
import { chooseAiMove } from "./ai";
import { coerceAiDifficulty } from "../aiDifficulty";
import {
  applyMove,
  computeMatchResult,
  createInitialState,
  isWellFormedBoard,
  normalizeForViewer,
  otherSeat,
  seatForUser,
  statusForState,
  userIdForSeat,
  validateMove,
} from "./rules";
// The seat vocabulary lives in `./types` (and is re-exported there for the
// routes); importing it from `./rules` would fail, since `rules` only imports
// it for its own signatures.
import type { Seat, Seats, TicTacToeState } from "./types";

// The rated/trophy game key, and the queue-mirror game key.
//
// Written as a string literal at every call site (rather than a shared
// constant) on purpose: `tests/trophy-system.test.mjs` audits the source for
// `gameKey: "<key>"` to prove every rated game is wired to a trophy writer,
// and a constant reference would be invisible to that check.

type MatchRow = typeof ticTacToeMatches.$inferSelect;

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

/** True when `userId` occupies either seat. */
export function isParticipant(
  match: { player1Id: string; player2Id?: string | null },
  userId: string | null,
): boolean {
  return Boolean(seatForUser(seatsFromRow(match), userId));
}

/** The persisted authoritative state of a row. */
export function stateOf(match: MatchRow): TicTacToeState {
  return match.gameState as TicTacToeState;
}

/** Client-facing DTO for a match row, from `viewerId`'s perspective. */
export function matchToDto(match: MatchRow, viewerId: string | null) {
  return {
    ...normalizeForViewer({
      state: stateOf(match),
      seats: seatsFromRow(match),
      viewerId,
      status: match.status,
      result: match.result ?? null,
      winnerId: match.winnerId ?? null,
    }),
    // Free practice is not competitive; nothing that reaches this flag is ever
    // rated. Present so a future bot needs no schema or DTO change.
    isAi: Boolean(match.isAi),
  };
}

// ── Lobby / matchmaking ───────────────────────────────────────────────────

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(ticTacToeMatches)
    .where(
      and(
        eq(ticTacToeMatches.status, MATCH_STATUS.WAITING),
        isNull(ticTacToeMatches.player2Id),
      ),
    )
    .orderBy(sql`${ticTacToeMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any. */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(ticTacToeMatches)
    .where(
      and(
        eq(ticTacToeMatches.status, MATCH_STATUS.WAITING),
        isNull(ticTacToeMatches.player2Id),
        eq(ticTacToeMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${ticTacToeMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * Match the caller into an open lobby, or open a new one.
 *
 * The whole operation runs under a single advisory lock (per-game namespace)
 * so two concurrent callers can never both see "no open lobby" and each create
 * one, and so a caller can never join a lobby that is being cancelled.
 */
export async function createOrJoin({ userId }: { userId: string }) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${TIC_TAC_TOE_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(ticTacToeMatches)
      .where(
        and(
          eq(ticTacToeMatches.status, MATCH_STATUS.WAITING),
          isNull(ticTacToeMatches.player2Id),
        ),
      )
      .orderBy(sql`${ticTacToeMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // The caller's own lobby — return it rather than creating a second.
      if (open.player1Id === userId) return { match: open, joined: false };
      return await joinExistingMatch(tx, open.id, userId);
    }

    return await createWaitingMatch(tx, userId);
  });
}

/**
 * Start a free practice match against the built-in bot.
 *
 * Practice is UNRATED: the row is `isAi`, so `settleMatch` skips ratings,
 * trophies and win counters entirely. It never enters the open-lobby pool (the
 * bot occupies player2 immediately), so it can never be joined or listed.
 *
 * The human is player1 (X) and moves first, exactly as a real lobby host — the
 * bot takes the O seat.
 */
export async function createAiMatch({
  userId,
  difficulty,
}: {
  userId: string;
  difficulty?: unknown;
}) {
  const state = createInitialState();
  const seats: Seats = { player1Id: userId, player2Id: TIC_TAC_TOE_AI_PLAYER_ID };
  const tier = coerceAiDifficulty(difficulty);

  const [match] = await db
    .insert(ticTacToeMatches)
    .values({
      player1Id: userId,
      player2Id: TIC_TAC_TOE_AI_PLAYER_ID,
      status: statusForState(state),
      ply: state.ply,
      currentTurnUserId: userIdForSeat(seats, state.currentTurn),
      gameState: state,
      isAi: true,
      aiDifficulty: tier,
      startedAt: new Date(),
    })
    .returning();

  return { match } as const;
}

async function createWaitingMatch(tx: any, userId: string) {
  const state = createInitialState();
  const seats: Seats = { player1Id: userId, player2Id: null };

  const [match] = await tx
    .insert(ticTacToeMatches)
    .values({
      player1Id: userId,
      status: MATCH_STATUS.WAITING,
      ply: state.ply,
      // No opponent yet, so the only seat is player1.
      currentTurnUserId: userIdForSeat(seats, state.currentTurn),
      gameState: state,
      isAi: false,
    })
    .returning();

  mirrorQueueCreated({
    gameKey: "tic-tac-toe",
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });

  return { match, joined: false };
}

async function joinExistingMatch(tx: any, candidateId: string, userId: string) {
  const [match] = await tx
    .select()
    .from(ticTacToeMatches)
    .where(eq(ticTacToeMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }

  const state = stateOf(match);
  const seats: Seats = { player1Id: match.player1Id, player2Id: userId };

  // Straight to `playing`: there is no ready banner and no countdown, so the
  // first move (X, player1) is available the moment the second seat lands.
  const [updated] = await tx
    .update(ticTacToeMatches)
    .set({
      player2Id: userId,
      status: statusForState(state),
      ply: state.ply,
      currentTurnUserId: userIdForSeat(seats, state.currentTurn),
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ticTacToeMatches.id, candidateId),
        eq(ticTacToeMatches.status, MATCH_STATUS.WAITING),
        isNull(ticTacToeMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  mirrorQueueCreated({
    gameKey: "tic-tac-toe",
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
 * Non-participants get a 403 — Tic-Tac-Toe has no spectator mode. There is no
 * deadline/backstop resolution to run here: the match has no clock (see the
 * turn-timer note in the module header), so a read can never change the state.
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
    .from(ticTacToeMatches)
    .where(eq(ticTacToeMatches.id, matchId));

  if (!match) return { error: "Match not found", status: 404 } as const;

  const seats = seatsFromRow(match);
  if (!seatForUser(seats, userId)) {
    return { error: "Not a participant of this match", status: 403 } as const;
  }

  return { match, dto: matchToDto(match, userId) } as const;
}

/** The append-only move log for a match, oldest first. */
export async function fetchMatchMoves(matchId: string) {
  return await db
    .select({
      ply: ticTacToeMoves.ply,
      playerId: ticTacToeMoves.playerId,
      // The lattice slot the move targeted. Together with `cellIndex` this is
      // the full move address a replay needs.
      boardIndex: ticTacToeMoves.boardIndex,
      cellIndex: ticTacToeMoves.cellIndex,
      createdAt: ticTacToeMoves.createdAt,
    })
    .from(ticTacToeMoves)
    .where(eq(ticTacToeMoves.matchId, matchId))
    .orderBy(sql`${ticTacToeMoves.ply} ASC`);
}

// ── Move (the only mutation) ──────────────────────────────────────────────

export type MoveResult =
  | {
      match: MatchRow;
      state: TicTacToeState;
      mark: string;
      ply: number;
      /** The lattice slot the move landed on (-1 for sudden death). */
      boardIndex: number;
      /** The expansion stage the match is on AFTER the move. */
      stage: number;
      matchCompleted: boolean;
      /** The small board's winning line, when the move resolved that board. */
      winningLine: number[] | null;
      /** The three Mega slots that won the match, when it was a Mega line. */
      winningBoards: number[] | null;
      winnerSeat: Seat | null;
    }
  | StoreError;

/**
 * Take one move.
 *
 * The request carries ONLY { boardIndex, cellIndex, expectedVersion }. Anything
 * else a client might send (a mark, a board, a winner, a result, a stage, a
 * completion flag) is ignored: the sequence
 *   validateMove → applyMove
 * runs entirely inside the row-locked transaction below.
 *
 * Rejections, in order:
 *   404 match not found
 *   403 caller holds no seat                  (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   409 match already finished
 *   409 not your turn
 *   400 board index out of range / not an integer
 *   409 board not in play yet / already locked
 *   400 cell index out of range / not an integer
 *   409 cell already occupied
 *   409 stale `expectedVersion`
 *
 * The row lock (`FOR UPDATE`) serialises concurrent move calls on the same
 * match, so two requests cannot both read version N and each apply a move; the
 * unique indexes on `tic_tac_toe_moves` (one per ply, one per (board, cell)) are
 * the structural backstop.
 */
export async function move({
  userId,
  matchId,
  boardIndex,
  cellIndex,
  expectedVersion,
}: {
  userId: string;
  matchId: string;
  boardIndex: unknown;
  cellIndex: unknown;
  expectedVersion?: unknown;
}): Promise<MoveResult> {
  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(ticTacToeMatches)
        .where(eq(ticTacToeMatches.id, matchId))
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
      const validation = validateMove({
        state,
        seat,
        boardIndex,
        cellIndex,
        expectedVersion,
      });
      if (!validation.ok) {
        return {
          error: validation.error ?? "Invalid move",
          status: validation.status ?? 400,
        } as const;
      }

      const index = cellIndex as number;
      const slot = boardIndex as number;
      const applied = applyMove({ state, seat, boardIndex: slot, cellIndex: index });

      // Append-only log. `ply` is the turn number the moved seat just played;
      // `boardIndex` + `cellIndex` are the full address of the mark.
      await tx.insert(ticTacToeMoves).values({
        matchId: match.id,
        ply: state.ply,
        playerId: userId,
        boardIndex: slot,
        cellIndex: index,
      });

      // Free practice: the bot answers INSIDE this same transaction, so its
      // turn can never be skipped by a client that forgets to call an AI
      // endpoint, and the snapshot the caller gets back already reflects it.
      // The loop is the closed form (tic-tac-toe is one move per turn, so it
      // runs once) and it stops the instant the turn is the human's again or
      // the match is finished.
      let finalState = applied.state;
      let finalApplied = applied;
      if (match.isAi && !applied.matchCompleted) {
        let guard = 0;
        // A Mega match alternates one move per turn exactly like stage 1, so
        // the loop runs once; the generous guard (every cell of every board)
        // only exists so a future non-alternating bot cannot spin forever.
        while (
          finalState.phase !== "finished" &&
          finalState.currentTurn !== seat &&
          guard < MAX_BOARDS * CELL_COUNT
        ) {
          guard += 1;
          const aiSeat = finalState.currentTurn;
          const aiMove = chooseAiMove({
            state: finalState,
            seat: aiSeat,
            difficulty: match.aiDifficulty,
          });
          if (!aiMove) break;
          const aiApplied = applyMove({
            state: finalState,
            seat: aiSeat,
            boardIndex: aiMove.boardIndex,
            cellIndex: aiMove.cellIndex,
          });
          await tx.insert(ticTacToeMoves).values({
            matchId: match.id,
            ply: finalState.ply,
            playerId: TIC_TAC_TOE_AI_PLAYER_ID,
            boardIndex: aiMove.boardIndex,
            cellIndex: aiMove.cellIndex,
          });
          finalState = aiApplied.state;
          finalApplied = aiApplied;
        }
      }

      const outcome = finalApplied.matchCompleted
        ? computeMatchResult(finalState)
        : null;

      const updates: Partial<typeof ticTacToeMatches.$inferInsert> = {
        gameState: finalState,
        ply: finalState.ply,
        currentTurnUserId: userIdForSeat(seats, finalState.currentTurn),
        status: outcome ? MATCH_STATUS.FINISHED : statusForState(finalState),
        updatedAt: new Date(),
      };

      if (outcome) {
        updates.result = outcome.result;
        updates.winnerId = outcome.winnerSeat
          ? userIdForSeat(seats, outcome.winnerSeat)
          : null;
        updates.endedAt = new Date();
      }

      const [updated] = await tx
        .update(ticTacToeMatches)
        .set(updates)
        .where(eq(ticTacToeMatches.id, match.id))
        .returning();

      if (outcome) {
        // Exactly-once settlement, in the same transaction that finalised the
        // match. `applyRatingResult` / `applyTrophyResult` are journal-keyed by
        // (user, game, match) so a retry can never move a rating twice.
        await settleMatch(tx, match, outcome);
        // A free-practice match is excluded from the canonical queue entirely,
        // so it must not mirror a transition either.
        if (!match.isAi) {
          mirrorQueueTransition({
            gameKey: "tic-tac-toe",
            matchId: match.id,
            status: "completed",
            playerCount: 2,
            cancelReason: null,
            at: new Date(),
          });
        }
      }

      return {
        match: updated ?? match,
        state: finalState,
        // The mark is DERIVED from the acting seat by `applyMove`; echoing it
        // back is a convenience for the client's history panel, never an input.
        mark: finalApplied.state.lastMove?.mark ?? "",
        ply: state.ply,
        boardIndex: slot,
        stage: finalState.stage,
        matchCompleted: finalApplied.matchCompleted,
        winningLine: finalApplied.winningLine,
        winningBoards: finalApplied.winningBoards,
        winnerSeat: finalApplied.winnerSeat,
      } as const;
    });
  } catch (error) {
    // A duplicate cell or a replayed ply lost the race and was rejected by the
    // storage-layer unique indexes. The transaction has already rolled back, so
    // report a clean 409 rather than a 500.
    if (isUniqueViolation(error)) {
      return { error: "Move already recorded", status: 409 } as const;
    }
    throw error;
  }
}

// ── Forfeit / cancel ──────────────────────────────────────────────────────

/** Concede: the opponent wins the match, with the same settlement path. */
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
      .from(ticTacToeMatches)
      .where(eq(ticTacToeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.PLAYING || !seats.player2Id) {
      return {
        error: "Only an active match can be forfeited",
        status: 409,
      } as const;
    }

    const winnerSeat = otherSeat(seat);
    const state = stateOf(match);
    const finishedState: TicTacToeState = { ...state, phase: "finished" };
    const outcome = { result: winnerSeat, winnerSeat };

    const [updated] = await tx
      .update(ticTacToeMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        gameState: finishedState,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ticTacToeMatches.id, match.id))
      .returning();

    await settleMatch(tx, match, outcome);
    if (!match.isAi) {
      mirrorQueueTransition({
        gameKey: "tic-tac-toe",
        matchId: match.id,
        status: "completed",
        playerCount: 2,
        cancelReason: null,
        at: new Date(),
      });
    }

    return { match: updated ?? match } as const;
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
      .from(ticTacToeMatches)
      .where(eq(ticTacToeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.player1Id !== userId) {
      return {
        error: "Only the lobby creator can cancel it",
        status: 403,
      } as const;
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return {
        error: "Only a waiting lobby can be cancelled",
        status: 409,
      } as const;
    }

    const state = stateOf(match);
    const cancelledState: TicTacToeState = { ...state, phase: "finished" };

    const [updated] = await tx
      .update(ticTacToeMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        gameState: cancelledState,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ticTacToeMatches.id, match.id))
      .returning();

    mirrorQueueTransition({
      gameKey: "tic-tac-toe",
      matchId: match.id,
      status: "cancelled",
      playerCount: 1,
      cancelReason: "cancelled_by_player",
      at: new Date(),
    });

    // A cancelled lobby never settled, so no rating, trophy or win counter
    // moves — settleMatch is deliberately not called here.
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
}: {
  userId: string;
  matchId: string;
}): Promise<DisconnectResult> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(ticTacToeMatches)
      .where(eq(ticTacToeMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }

    // Terminal — nothing to resolve.
    if (
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      return { match, forfeited: false, cancelled: false } as const;
    }

    // Still an open lobby: release it. There is no opponent to award a win to,
    // and a cancelled lobby never settles, so no rating or stat is touched.
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      const state = stateOf(match);
      const cancelledState: TicTacToeState = { ...state, phase: "finished" };
      const [updated] = await tx
        .update(ticTacToeMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          gameState: cancelledState,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(ticTacToeMatches.id, match.id))
        .returning();

      mirrorQueueTransition({
        gameKey: "tic-tac-toe",
        matchId: match.id,
        status: "cancelled",
        playerCount: 1,
        cancelReason: "disconnected",
        at: new Date(),
      });

      return { match: updated ?? match, forfeited: false, cancelled: true } as const;
    }

    // Active match: award the opponent the win, with the standard settlement.
    const winnerSeat = otherSeat(seat);
    const state = stateOf(match);
    const finishedState: TicTacToeState = { ...state, phase: "finished" };
    const outcome = { result: winnerSeat, winnerSeat };

    const [updated] = await tx
      .update(ticTacToeMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        gameState: finishedState,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ticTacToeMatches.id, match.id))
      .returning();

    await settleMatch(tx, match, outcome);
    if (!match.isAi) {
      mirrorQueueTransition({
        gameKey: "tic-tac-toe",
        matchId: match.id,
        status: "completed",
        playerCount: 2,
        cancelReason: null,
        at: new Date(),
      });
    }

    return { match: updated ?? match, forfeited: true, cancelled: false } as const;
  });
}

// ── Settlement (existing GRYND rating/trophy infrastructure only) ─────────

/**
 * Record the outcome of a finished Tic-Tac-Toe match.
 *
 * Reuses the platform's Elo (`applyRatingResult`) and trophy
 * (`applyTrophyResult`) helpers — there is deliberately no Tic-Tac-Toe-specific
 * rating maths and no custom scoring. Both are called with the store's
 * transaction so the match finalisation and the rating change commit
 * atomically, and both are idempotent per (user, game, match) via their own
 * event journals.
 *
 * No wager, no token, no payout: the game is unstaked, so the only account
 * stats touched are `users.gamesWon` / `users.gamesLost`. The leaderboard
 * counters are deliberately NOT called because `applyLeaderboardCounters` is
 * wager-gated (`bet <= 0` returns early) and this game has no wager — calling
 * it would be a no-op that reads like a bug.
 *
 * A DRAW is journaled by both helpers (with `result: "draw"`, which moves both
 * ratings by K × (0.5 − expected)) but changes neither win counter, exactly as
 * Mini Golf does. Tic-tac-toe is a solved draw, so this path is common, not an
 * edge case.
 */
async function settleMatch(
  tx: any,
  match: MatchRow,
  outcome: { result: string; winnerSeat: Seat | null },
) {
  // Free vs-AI matches must never affect rating, trophies or win counters.
  if (match.isAi) return;
  if (!match.player2Id) return;

  const matchId = String(match.id);

  if (outcome.result === RESULT.TIE) {
    await applyRatingResult({
      tx,
      gameKey: "tic-tac-toe",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: "tic-tac-toe",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    return;
  }

  const winnerId =
    outcome.winnerSeat === "player1" ? match.player1Id : match.player2Id;
  const loserId =
    outcome.winnerSeat === "player1" ? match.player2Id : match.player1Id;
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
    gameKey: "tic-tac-toe",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "tic-tac-toe",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// Re-exported so the routes can assert board shape without importing the rules
// module directly, and so the derivability invariant stays discoverable.
export { isWellFormedBoard };
