// src/lib/tic-tac-toe/serverStore.ts
//
// The server-authoritative Tic-Tac-Toe Duel match store. Every state transition
// in the game happens inside a row-locked `db.transaction` here, and the API
// routes are thin wrappers around these functions.
//
// TRUST BOUNDARY: the ONLY player-authored values that reach this module are
// `boardIndex` and `cellIndex` — which board, and which cell on it — and
// `boardIndex` is only honoured when it is the destination the rules derived.
// The mark, the boards, whose turn it is, every board's control, the required
// destination, the lattice winner, the draw, the match result, the rating change
// and the trophies are all computed from the server's own authoritative state by
// the pure rules engine (`applyMove`). A client cannot submit a winner, a
// result, a score, a turn, a board owner, a destination, an Elo value, a trophy
// or a completion flag — no such field is ever read.
//
// Settlement reuses the platform's existing rating/trophy infrastructure
// (`applyRatingResult` / `applyTrophyResult`) inside the SAME transaction that
// finalises the match, exactly once — the guard is the `status` flip to
// `finished` under a `FOR UPDATE` lock, plus those helpers' own
// (user, game, match)-keyed idempotency journals. There is NO second Elo
// implementation.
//
// THE POT RIDES THE SAME SETTLEMENT: both seats are escrowed through the shared
// ledger (`escrowMatchWagers`) the moment the second player takes the seat, the
// winner is paid `ticTacToePayout(stake)` (`settlePayout`) in the transaction
// that finalises the match, and a tie (or a cancelled/voided match) gives both
// stakes back (`refundMatchWagers`). The ledger is keyed per (match, seat), so
// a retry can never pay or refund twice, and it refuses to pay a seat with no
// funding row — which is what keeps a legacy, unstaked row from minting coins.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { ticTacToeMatches, ticTacToeMoves, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { isPracticePaused } from "../practicePause";
import { markDailyRewardWin } from "../dailyRewardWin";
import { PVP_WINNER_SHARE } from "../games/economy";
import {
  escrowMatchWagers,
  refundMatchWagers,
  settlePayout,
} from "../tokens/wager";
import {
  CELL_COUNT,
  MATCH_STATUS,
  MAX_BOARDS,
  RESULT,
  TIC_TAC_TOE_AI_PLAYER_ID,
  TIC_TAC_TOE_LOCK_NAMESPACE,
} from "./constants";
import { chooseAiMove } from "./ai";
import { openingSeatIsHost, parseMarkChoice, resolveHumanMark } from "./seating";
import { coerceAiDifficulty } from "../aiDifficulty";
import {
  applyMove,
  computeMatchResult,
  createInitialState,
  isExpansionEraState,
  isWellFormedBoard,
  isWellFormedState,
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

/**
 * What a win pays: both seats' stakes (the pot) minus the shared house rake, so
 * a 2× pot pays 1.8× the winner's own stake at the current 10% rake. Pure, so a
 * client-facing read can never drift from the coins that actually move. A free
 * match (stake 0) pays nothing.
 */
export function ticTacToePayout(stake: unknown): number {
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((2 * amount * PVP_WINNER_SHARE).toFixed(2));
}

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

/**
 * Why a row's persisted state cannot be played by the CURRENT rules, or null
 * when it can.
 *
 * Two cases, both treated the same way:
 *
 *   "legacy"     — written by the expansion-era ("Mega") engine;
 *   "unreadable" — a structurally malformed blob the engine refuses to index.
 *
 * Neither may be reinterpreted as an Ultimate position: the old stage 1 was ONE
 * board and the new game is NINE from move one, so "continuing" it would silently
 * change the game under a rated, staked match.
 */
export function rulesVoidReason(
  match: { gameState?: unknown },
): "legacy" | "unreadable" | null {
  const state = match?.gameState;
  if (isExpansionEraState(state)) return "legacy";
  if (!isWellFormedState(state)) return "unreadable";
  return null;
}

/** True when the row's state cannot be played by the current rules. */
export function needsRulesVoid(match: { gameState?: unknown }): boolean {
  return rulesVoidReason(match) !== null;
}

/**
 * Close a match that the current rules cannot continue, refunding both seats.
 *
 * Deliberately NOT a rating/trophy path: the match has no result, so it is
 * CANCELLED (like a lobby closed before play) and both escrowed stakes go back
 * through the shared ledger, which is keyed per (match, seat) and therefore
 * idempotent — a retry can never refund twice.
 *
 * A lobby that never had a move is not voided here: `joinExistingMatch` simply
 * re-seeds its state to the current opening position, because there is nothing
 * to preserve. This is only reached for a match that already has moves, or whose
 * blob is unreadable.
 */
async function voidUnplayableMatch(tx: any, match: MatchRow) {
  const [updated] = await tx
    .update(ticTacToeMatches)
    .set({
      status: MATCH_STATUS.CANCELLED,
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ticTacToeMatches.id, match.id))
    .returning();

  await refundMatchWagers({
    clerkIds: [match.player1Id, match.player2Id],
    stake: Number(match.stakeAmount) || 0,
    matchId: match.id,
    gameKey: "tic-tac-toe",
    tx,
  });

  // A practice match never entered the canonical queue, exactly like a normal
  // practice completion.
  if (!match.isAi) {
    mirrorQueueTransition({
      gameKey: "tic-tac-toe",
      matchId: match.id,
      status: "cancelled",
      playerCount: match.player2Id ? 2 : 1,
      cancelReason: "rules_migrated",
      at: new Date(),
    });
  }

  return updated ?? match;
}

/** The refusal returned when a match was voided because its state is unusable. */
function rulesVoidError(reason: "legacy" | "unreadable"): string {
  return reason === "legacy"
    ? "This match was played under the previous rules and can no longer be continued — both stakes have been refunded. Please start a new match."
    : "This match's saved state cannot be read, so it cannot be continued — both stakes have been refunded. Please start a new match.";
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
    // The stake each seat put up (0 = free practice), and the pot a win pays
    // out of it. Read-only display values: the coins that move are the ones the
    // escrow ledger took, which is why the pot comes from the same pure helper
    // the settlement uses rather than from a second formula here.
    stakeAmount: Number(match.stakeAmount) || 0,
    pot: ticTacToePayout(match.stakeAmount),
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
 *
 * STAKED MATCHMAKING: the caller states the stake they are playing for, and
 * only a waiting lobby AT THAT STAKE is a candidate (a PvP duel always plays
 * for coins, so there is no free entry here — the route requires a legal stake
 * before it calls this). The lobby's own stake is what gets escrowed, and
 * `joinExistingMatch` re-checks it, so a stale or crafted request can never
 * fund a seat at an amount the player did not agree to.
 */
export async function createOrJoin({
  userId,
  stakeAmount,
}: {
  userId: string;
  stakeAmount: number;
}) {
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
          eq(ticTacToeMatches.stakeAmount, stakeAmount.toFixed(2)),
        ),
      )
      .orderBy(sql`${ticTacToeMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // The caller's own lobby — return it rather than creating a second.
      if (open.player1Id === userId) return { match: open, joined: false };
      return await joinExistingMatch(tx, open.id, userId, stakeAmount);
    }

    return await createWaitingMatch(tx, userId, stakeAmount);
  });
}

// The opening-seat policy (which USER takes the X seat) lives in its own pure
// module so it can be pinned without a database; re-exported here because every
// caller of the store already reaches for it through this module.
export { parseMarkChoice, resolveHumanMark, openingSeatIsHost } from "./seating";
export type { MarkChoice } from "./seating";

/**
 * Start a free practice match against the built-in bot.
 *
 * Practice is UNRATED: the row is `isAi`, so `settleMatch` skips ratings,
 * trophies and win counters entirely. It never enters the open-lobby pool (the
 * bot occupies the other seat immediately), so it can never be joined or listed.
 *
 * WHO OPENS is the player's choice (or a server-side roll), like chess colours:
 * `mark` is the human's X/O preference. X is `player1` and opens — so picking O
 * seats the bot in `player1` and gives it the first move. That opening move is
 * played HERE, at creation, because tic-tac-toe's bot otherwise answers inside a
 * HUMAN move's transaction: a bot that opens has no human move to ride on, and
 * the board would sit waiting on it forever.
 */
export async function createAiMatch({
  userId,
  difficulty,
  mark,
  random = Math.random,
}: {
  userId: string;
  difficulty?: unknown;
  mark?: unknown;
  random?: () => number;
}) {
  const tier = coerceAiDifficulty(difficulty);
  let humanMark = resolveHumanMark(parseMarkChoice(mark), random);
  let humanSeat: Seat = humanMark === "X" ? "player1" : "player2";

  let state = createInitialState();
  let opening: { boardIndex: number; cellIndex: number } | null = null;
  if (state.currentTurn !== humanSeat) {
    const move = chooseAiMove({ state, seat: state.currentTurn, difficulty: tier });
    if (move) {
      state = applyMove({
        state,
        seat: state.currentTurn,
        boardIndex: move.boardIndex,
        cellIndex: move.cellIndex,
      }).state;
      opening = { boardIndex: move.boardIndex, cellIndex: move.cellIndex };
    } else {
      // Defensive: an empty board always offers a move, but a bot that could not
      // open must never leave the match waiting on itself — hand X to the human.
      humanMark = "X";
      humanSeat = "player1";
    }
  }

  const seats: Seats =
    humanSeat === "player1"
      ? { player1Id: userId, player2Id: TIC_TAC_TOE_AI_PLAYER_ID }
      : { player1Id: TIC_TAC_TOE_AI_PLAYER_ID, player2Id: userId };

  return db.transaction(async (tx) => {
    const [match] = await tx
      .insert(ticTacToeMatches)
      .values({
        player1Id: seats.player1Id,
        player2Id: seats.player2Id,
        status: statusForState(state),
        ply: state.ply,
        currentTurnUserId: userIdForSeat(seats, state.currentTurn),
        gameState: state,
        isAi: true,
        aiDifficulty: tier,
        startedAt: new Date(),
      })
      .returning();

    // The bot's opening move belongs in the append-only log exactly like a human
    // move, so replaying the log reconstructs the same position.
    if (opening) {
      await tx.insert(ticTacToeMoves).values({
        matchId: match.id,
        ply: 0,
        playerId: TIC_TAC_TOE_AI_PLAYER_ID,
        boardIndex: opening.boardIndex,
        cellIndex: opening.cellIndex,
      });
    }

    return { match, humanMark, humanSeat } as const;
  });
}

async function createWaitingMatch(tx: any, userId: string, stakeAmount: number) {
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
      // The stake the table WILL carry. An open lobby costs nothing to hold:
      // both seats are escrowed at once when the second player joins, so a
      // lobby that never fills never touches a balance.
      stakeAmount: stakeAmount.toFixed(2),
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

async function joinExistingMatch(
  tx: any,
  candidateId: string,
  userId: string,
  stakeAmount: number,
) {
  const [match] = await tx
    .select()
    .from(ticTacToeMatches)
    .where(eq(ticTacToeMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }
  // The joiner is held to the stake the lobby carries: a request that names a
  // different one is refused rather than escrowed at an amount the player never
  // agreed to (the lobby list is public, and `createOrJoin` matches on stake
  // equality, so this only fires for a stale or crafted request).
  if (Number(match.stakeAmount) !== stakeAmount) {
    return {
      error: "This lobby is no longer open at that stake",
      status: 400,
    } as const;
  }

  // Escrow BOTH stakes before the seat fills: a staked match either funds
  // fully or the join is refused, so a `playing` match is always backed by two
  // stakes and the winner's payout is always funded. A seat that cannot cover
  // the stake is answered with the reason (and the transaction rolls back, so
  // the lobby is still open and nothing was charged).
  const escrow: { ok: boolean; error?: string; status?: number } =
    await escrowMatchWagers({
      clerkIds: [match.player1Id, userId],
      stake: Number(match.stakeAmount),
      matchId: match.id,
      gameKey: "tic-tac-toe",
      tx,
    });
  if (!escrow.ok) {
    return {
      error: escrow.error || "Insufficient coins",
      status: escrow.status || 400,
    } as const;
  }

  // A lobby opened BEFORE the rules change still carries the expansion-era
  // opening position. It has no moves, so nothing is lost by re-seeding it to
  // the CURRENT opening position — the joiner simply gets an Ultimate table
  // instead of a state the new engine would have to void.
  const reseed = needsRulesVoid(match);
  const state = reseed ? createInitialState() : stateOf(match);
  // WHO OPENS IS ROLLED HERE, like chess colours. The host is not automatically
  // X: `player1` is the seat that opens (one engine invariant this change does
  // not touch), and the roll decides which USER takes it. Both seats are already
  // escrowed above by user id, so the swap moves no coins; the seat cards and
  // the first move then follow the row.
  const seats: Seats = openingSeatIsHost()
    ? { player1Id: match.player1Id, player2Id: userId }
    : { player1Id: userId, player2Id: match.player1Id };

  // Straight to `playing`: there is no ready banner and no countdown, so the
  // first move (X, player1) is available the moment the second seat lands.
  const [updated] = await tx
    .update(ticTacToeMatches)
    .set({
      player1Id: seats.player1Id,
      player2Id: seats.player2Id,
      status: statusForState(state),
      ply: state.ply,
      currentTurnUserId: userIdForSeat(seats, state.currentTurn),
      // Only written when the lobby needed re-seeding, so a normal join keeps
      // its existing single-write shape.
      ...(reseed ? { gameState: state } : {}),
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
      /** The lattice slot the move landed on (0..8). */
      boardIndex: number;
      /**
       * The mini-board the OPPONENT must play after this move, or null when its
       * destination resolved and it may choose any unfinished board. Derived by
       * `applyMove` from the cell index; never accepted from a client.
       */
      nextBoard: number | null;
      matchCompleted: boolean;
      /** The small board's winning line, when the move resolved that board. */
      winningLine: number[] | null;
      /** The three lattice slots that won the match, when it was a lattice line. */
      winningBoards: number[] | null;
      winnerSeat: Seat | null;
    }
  | StoreError;

/**
 * Take one move.
 *
 * The request carries ONLY { boardIndex, cellIndex, expectedVersion }. Anything
 * else a client might send (a mark, a board owner, a winner, a result, a
 * destination, a completion flag) is ignored: the sequence
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
  // Free-play pause: a paused match accepts no moves (the overlay blocks the
  // click already, this is the server-side backstop).
  if (await isPracticePaused("tic-tac-toe", matchId)) {
    return { error: "Match is paused", status: 409 } as const;
  }
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

      // Legacy compatibility: a match whose persisted state predates the
      // Ultimate rules cannot be continued. Void it (refunding both stakes,
      // unrated) rather than either crashing the engine or silently re-reading
      // a one-board Mega position as a nine-board Ultimate one.
      const voidReason = rulesVoidReason(match);
      if (voidReason) {
        await voidUnplayableMatch(tx, match);
        return { error: rulesVoidError(voidReason), status: 409 } as const;
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
        // A match alternates one move per turn by construction, so the loop
        // runs once; the generous guard (every cell of every board) only exists
        // so a future non-alternating bot cannot spin forever.
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
        nextBoard: finalState.nextBoard,
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
    // A legacy match has no valid result to award: void it instead of settling
    // a win on a game that was being played under different rules.
    const voidReason = rulesVoidReason(match);
    if (voidReason) {
      await voidUnplayableMatch(tx, match);
      return { error: rulesVoidError(voidReason), status: 409 } as const;
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
    // moves — settleMatch is deliberately not called here. Any escrow it holds
    // is handed back (a waiting lobby was never charged, so this is normally a
    // no-op: the ledger refuses to refund a seat that was never debited).
    await refundMatchWagers({
      clerkIds: [match.player1Id, match.player2Id],
      stake: Number(match.stakeAmount) || 0,
      matchId: match.id,
      gameKey: "tic-tac-toe",
      tx,
    });

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

    // A match the current rules cannot continue: void it (refund both, unrated)
    // and report it as cancelled so the realtime retry loop stops.
    if (needsRulesVoid(match)) {
      const voided = await voidUnplayableMatch(tx, match);
      return { match: voided, forfeited: false, cancelled: true } as const;
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
 * A win also takes the pot: both seats were escrowed at join, so the winner is
 * paid `ticTacToePayout(stake)` out of that escrow in THIS transaction, and the
 * free account stats touched are `users.gamesWon` / `users.gamesLost`. The
 * leaderboard counters are deliberately NOT called: they are keyed to the
 * single-player bet columns (`applyLeaderboardCounters` returns early for a
 * bet of 0) and a PvP match has no such column, so calling it here would be a
 * no-op that reads like a bug.
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
  // Free vs-AI matches must never affect rating, trophies or win counters —
  // and they are never escrowed, so they never move coins either. A human win
  // still unlocks the daily reward, which is the one progression signal free
  // play is allowed to move.
  if (match.isAi) {
    const winnerId = outcome.winnerSeat
      ? outcome.winnerSeat === "player1"
        ? match.player1Id
        : match.player2Id
      : null;
    if (outcome.result !== RESULT.TIE && winnerId && winnerId !== TIC_TAC_TOE_AI_PLAYER_ID) {
      await markDailyRewardWin(tx, winnerId);
    }
    return;
  }
  if (!match.player2Id) return;

  const matchId = String(match.id);
  const seatIds = [match.player1Id, match.player2Id];
  const stake = Number(match.stakeAmount) || 0;

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
    // A tie is VOID, not a stranded pot: both stakes go back through the same
    // ledger (which refuses the refund if the match was already paid).
    await refundMatchWagers({
      clerkIds: seatIds,
      stake,
      matchId,
      gameKey: "tic-tac-toe",
      tx,
    });
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

  // …and the pot, out of the escrow both seats funded at join. The ledger is
  // keyed per (match, seat), so a replayed settle pays nothing, and a seat whose
  // stake was never taken (a legacy unstaked row) is paid nothing rather than
  // minted. Free matches (stake 0) skip the call: there is no pot.
  const payout = ticTacToePayout(stake);
  if (payout > 0) {
    await settlePayout({
      clerkId: winnerId,
      amount: payout,
      matchId,
      gameKey: "tic-tac-toe",
      tx,
    });
  }
}

// Re-exported so the routes can assert board shape without importing the rules
// module directly, and so the derivability invariant stays discoverable.
export { isWellFormedBoard };
