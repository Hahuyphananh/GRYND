// src/lib/solitaire-puzzle/matchmaking.ts
//
// PUZZLE RANKED MATCHMAKING — human vs human only.
//
// There is NO ghost, bot, back-fill or fabricated opponent anywhere in this
// file, and no path can move a human ranked search into an AI match. When
// nobody is waiting the caller gets an honest `waiting` state with the instant
// their search started, its expiry, and a cancel primitive.
//
// ONE IDENTITY, ONE SEAT: a player already in a live Puzzle Ranked session gets
// that session back instead of a second one, and a second search returns the
// search they already have. A player can never hold two active Puzzle Ranked
// matches.
//
// CONCURRENCY: every mutation runs under `pg_advisory_xact_lock` on a namespace
// that is OURS ALONE (never Solitaire Duel's), and the second seat is claimed
// by a conditional UPDATE on a `FOR UPDATE` row, so two callers cannot both
// take the same seat or both open a lobby.
//
// A waiting row older than PUZZLE_RANKED_QUEUE_TTL_MS is never offered: an
// abandoned search is cancelled rather than paired with somebody who left.

import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { solitairePuzzleSessions } from "../../db/schema";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { randomHex } from "../solitaire-duel/seeds";
import {
  PUZZLE_RANKED_GAME_KEY,
  PUZZLE_RANKED_LOCK_NAMESPACE,
  PUZZLE_RANKED_QUEUE_TTL_MS,
  PUZZLE_SESSION_MODE,
  PUZZLE_SESSION_STATUS,
  type PuzzleSessionStatus,
} from "./constants";
import { PUZZLE_RANKED_FORMAT } from "./ranked";
import {
  createPuzzleSessionRecord,
  sessionRowToSnapshot,
  type StoreError,
} from "./serverStore";
import type { PuzzleSessionSnapshot } from "./types";

type SessionRow = typeof solitairePuzzleSessions.$inferSelect;

export type PuzzleRankedQueueState = {
  sessionId: string | null;
  status: PuzzleSessionStatus | null;
  waiting: boolean;
  /** True when this call took the second seat. */
  joined: boolean;
  /** True when the caller already held a search or a live session. */
  alreadyActive: boolean;
  goAtMs: number | null;
  deadlineAtMs: number | null;
  /** When the caller's search began (waiting only). */
  waitingSinceMs: number | null;
  /** When the waiting seat stops being joinable (waiting only). */
  queueExpiresAtMs: number | null;
  serverNowMs: number;
};

export type PuzzleRankedQueueResult =
  | { state: PuzzleRankedQueueState }
  | StoreError;

function instantMs(value: unknown): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function err(error: string, status: number): StoreError {
  return { error, status };
}

function stateFor(
  snapshot: PuzzleSessionSnapshot,
  nowMs: number,
  extra: { joined?: boolean; alreadyActive?: boolean } = {},
): PuzzleRankedQueueState {
  const waiting = snapshot.status === PUZZLE_SESSION_STATUS.WAITING;
  return {
    sessionId: snapshot.id,
    status: snapshot.status,
    waiting,
    joined: extra.joined ?? false,
    alreadyActive: extra.alreadyActive ?? false,
    goAtMs: snapshot.goAtMs,
    deadlineAtMs: snapshot.deadlineAtMs,
    waitingSinceMs: waiting ? snapshot.createdAtMs : null,
    queueExpiresAtMs: waiting
      ? snapshot.createdAtMs + PUZZLE_RANKED_QUEUE_TTL_MS
      : null,
    serverNowMs: nowMs,
  };
}

/** True for a row that is still asking for an opponent. */
function isOpenSearch(row: SessionRow): boolean {
  return (
    row.mode === PUZZLE_SESSION_MODE.RANKED &&
    row.status === PUZZLE_SESSION_STATUS.WAITING &&
    !row.player2Id
  );
}

function isExpired(row: SessionRow, nowMs: number): boolean {
  const createdAtMs = instantMs(row.createdAt);
  return createdAtMs > 0 && nowMs - createdAtMs > PUZZLE_RANKED_QUEUE_TTL_MS;
}

async function cancelRow(
  tx: any,
  row: SessionRow,
  nowMs: number,
  reason: string,
): Promise<void> {
  await tx
    .update(solitairePuzzleSessions)
    .set({
      status: PUZZLE_SESSION_STATUS.CANCELLED,
      endedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitairePuzzleSessions.id, row.id));

  mirrorQueueTransition({
    gameKey: PUZZLE_RANKED_GAME_KEY,
    matchId: row.id,
    status: "cancelled",
    playerCount: 1,
    cancelReason: reason,
    at: new Date(nowMs),
  });
}

/**
 * The caller's own live Puzzle Ranked session, or null.
 *
 * Authorization is by stored seat (`player1_id`/`player2_id`), never by a
 * request-supplied id, and only `waiting`/`playing` count as active.
 */
export async function findActivePuzzleRankedSession({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}): Promise<PuzzleSessionSnapshot | null> {
  const rows = await db
    .select()
    .from(solitairePuzzleSessions)
    .where(
      and(
        eq(solitairePuzzleSessions.mode, PUZZLE_SESSION_MODE.RANKED),
        sql`${solitairePuzzleSessions.status} IN (${PUZZLE_SESSION_STATUS.WAITING}, ${PUZZLE_SESSION_STATUS.PLAYING})`,
        or(
          eq(solitairePuzzleSessions.player1Id, userId),
          eq(solitairePuzzleSessions.player2Id, userId),
        ),
      ),
    );

  // Re-validate in JS exactly as the duel's join path does: a row that is not
  // the caller's, or is no longer active, must never be handed back.
  const mine = rows.filter(
    (row) =>
      row.mode === PUZZLE_SESSION_MODE.RANKED &&
      (row.player1Id === userId || row.player2Id === userId) &&
      (row.status === PUZZLE_SESSION_STATUS.WAITING ||
        row.status === PUZZLE_SESSION_STATUS.PLAYING),
  );
  const live = mine.find((row) => row.status === PUZZLE_SESSION_STATUS.PLAYING);
  const waiting = mine.find(
    (row) => row.status === PUZZLE_SESSION_STATUS.WAITING && !isExpired(row, nowMs),
  );
  const row = live ?? waiting;
  return row ? sessionRowToSnapshot(row) : null;
}

/**
 * Find an open Puzzle Ranked seat, or open one.
 *
 * The whole operation is one transaction under the Puzzle Ranked advisory lock,
 * so concurrent callers serialize: the first opens a lobby, the second takes
 * its second seat. Neither can ever see a half-claimed row.
 */
export async function createOrJoinPuzzleRanked({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}): Promise<PuzzleRankedQueueResult> {
  if (!userId) return err("Unauthenticated", 401);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PUZZLE_RANKED_LOCK_NAMESPACE}, 0)`,
    );

    const rows = await tx
      .select()
      .from(solitairePuzzleSessions)
      .where(
        and(
          eq(solitairePuzzleSessions.mode, PUZZLE_SESSION_MODE.RANKED),
          sql`${solitairePuzzleSessions.status} IN (${PUZZLE_SESSION_STATUS.WAITING}, ${PUZZLE_SESSION_STATUS.PLAYING})`,
          or(
            eq(solitairePuzzleSessions.player1Id, userId),
            eq(solitairePuzzleSessions.player2Id, userId),
          ),
        ),
      )
      .orderBy(desc(solitairePuzzleSessions.createdAt))
      .for("update");

    const mine = rows.filter(
      (row) =>
        row.mode === PUZZLE_SESSION_MODE.RANKED &&
        (row.player1Id === userId || row.player2Id === userId),
    );

    // One live match per player: hand back the session instead of a second.
    const live = mine.find((row) => row.status === PUZZLE_SESSION_STATUS.PLAYING);
    if (live) {
      return {
        state: stateFor(sessionRowToSnapshot(live), nowMs, { alreadyActive: true }),
      } as const;
    }

    // A search already in flight is the same search.
    const ownSearch = mine.find(
      (row) => row.status === PUZZLE_SESSION_STATUS.WAITING && !row.player2Id,
    );
    if (ownSearch) {
      if (!isExpired(ownSearch, nowMs)) {
        return {
          state: stateFor(sessionRowToSnapshot(ownSearch), nowMs, {
            alreadyActive: true,
          }),
        } as const;
      }
      await cancelRow(tx, ownSearch, nowMs, "queue_expired");
    }

    const candidates = await tx
      .select()
      .from(solitairePuzzleSessions)
      .where(
        and(
          eq(solitairePuzzleSessions.mode, PUZZLE_SESSION_MODE.RANKED),
          eq(solitairePuzzleSessions.status, PUZZLE_SESSION_STATUS.WAITING),
          isNull(solitairePuzzleSessions.player2Id),
          ne(solitairePuzzleSessions.player1Id, userId),
        ),
      )
      .orderBy(solitairePuzzleSessions.createdAt)
      .for("update");

    // Never pair with yourself, a stale search, or a row that is no longer open.
    const usable: SessionRow[] = [];
    for (const candidate of candidates) {
      if (candidate.player1Id === userId) continue;
      if (!isOpenSearch(candidate)) continue;
      if (isExpired(candidate, nowMs)) {
        await cancelRow(tx, candidate, nowMs, "queue_expired");
        continue;
      }
      usable.push(candidate);
    }

    const opponent = usable[0];
    if (opponent) {
      const [joined] = await tx
        .update(solitairePuzzleSessions)
        .set({
          player2Id: userId,
          status: PUZZLE_SESSION_STATUS.PLAYING,
          // ONE absolute clock pair, minted when the second seat is taken.
          // Both players receive the same allowance from this instant.
          goAt: new Date(nowMs),
          deadlineAt: new Date(nowMs + PUZZLE_RANKED_FORMAT.deadlineMs),
          updatedAt: new Date(nowMs),
        })
        .where(
          and(
            eq(solitairePuzzleSessions.id, opponent.id),
            eq(solitairePuzzleSessions.status, PUZZLE_SESSION_STATUS.WAITING),
            isNull(solitairePuzzleSessions.player2Id),
          ),
        )
        .returning();

      if (!joined) return err("That match is no longer available", 409);

      mirrorQueueTransition({
        gameKey: PUZZLE_RANKED_GAME_KEY,
        matchId: joined.id,
        status: "playing",
        playerCount: 2,
        cancelReason: null,
        at: new Date(nowMs),
      });

      return {
        state: stateFor(sessionRowToSnapshot(joined), nowMs, { joined: true }),
      } as const;
    }

    // Nobody is waiting: open an honest lobby. The frozen manifest is chosen
    // NOW, server-side, and both seats will read this one row.
    const snapshot = await createPuzzleSessionRecord({
      mode: PUZZLE_SESSION_MODE.RANKED,
      player1Id: userId,
      seed: randomHex(32),
      nowMs,
      status: PUZZLE_SESSION_STATUS.WAITING,
      tx,
    });

    mirrorQueueCreated({
      gameKey: PUZZLE_RANKED_GAME_KEY,
      matchId: snapshot.id,
      mode: "pvp",
      playerCount: 1,
      queuedAt: new Date(nowMs),
    });

    return { state: stateFor(snapshot, nowMs) } as const;
  });

  if ("error" in result) return result as StoreError;
  return result as { state: PuzzleRankedQueueState };
}

/** The caller's current search state, expiring an abandoned search on read. */
export async function getPuzzleRankedQueue({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}): Promise<PuzzleRankedQueueState> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PUZZLE_RANKED_LOCK_NAMESPACE}, 0)`,
    );

    const rows = await tx
      .select()
      .from(solitairePuzzleSessions)
      .where(
        and(
          eq(solitairePuzzleSessions.mode, PUZZLE_SESSION_MODE.RANKED),
          sql`${solitairePuzzleSessions.status} IN (${PUZZLE_SESSION_STATUS.WAITING}, ${PUZZLE_SESSION_STATUS.PLAYING})`,
          or(
            eq(solitairePuzzleSessions.player1Id, userId),
            eq(solitairePuzzleSessions.player2Id, userId),
          ),
        ),
      )
      .for("update");

    const mine = rows.filter(
      (row) =>
        row.mode === PUZZLE_SESSION_MODE.RANKED &&
        (row.player1Id === userId || row.player2Id === userId),
    );
    const live = mine.find((row) => row.status === PUZZLE_SESSION_STATUS.PLAYING);
    if (live) {
      return stateFor(sessionRowToSnapshot(live), nowMs, { alreadyActive: true });
    }

    const search = mine.find(
      (row) => row.status === PUZZLE_SESSION_STATUS.WAITING && !row.player2Id,
    );
    if (search) {
      if (isExpired(search, nowMs)) {
        await cancelRow(tx, search, nowMs, "queue_expired");
        return null;
      }
      return stateFor(sessionRowToSnapshot(search), nowMs, { alreadyActive: true });
    }
    return null;
  });

  return (
    result ?? {
      sessionId: null,
      status: null,
      waiting: false,
      joined: false,
      alreadyActive: false,
      goAtMs: null,
      deadlineAtMs: null,
      waitingSinceMs: null,
      queueExpiresAtMs: null,
      serverNowMs: nowMs,
    }
  );
}

/**
 * Cancel the caller's own waiting search.
 *
 * A LIVE match is deliberately not cancellable here — leaving a started match
 * is a forfeit (a settled result), not a void. A cancelled search settles
 * nothing and touches no rating, trophy or counter.
 */
export async function cancelPuzzleRankedSearch({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}): Promise<{ cancelled: boolean; sessionId: string | null }> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PUZZLE_RANKED_LOCK_NAMESPACE}, 0)`,
    );

    const rows = await tx
      .select()
      .from(solitairePuzzleSessions)
      .where(
        and(
          eq(solitairePuzzleSessions.mode, PUZZLE_SESSION_MODE.RANKED),
          eq(solitairePuzzleSessions.status, PUZZLE_SESSION_STATUS.WAITING),
          eq(solitairePuzzleSessions.player1Id, userId),
          isNull(solitairePuzzleSessions.player2Id),
        ),
      )
      .for("update");

    const search = rows.find(
      (row) =>
        row.player1Id === userId &&
        row.status === PUZZLE_SESSION_STATUS.WAITING &&
        !row.player2Id,
    );
    if (!search) return { cancelled: false, sessionId: null } as const;

    await cancelRow(tx, search, nowMs, "cancelled_by_player");
    return { cancelled: true, sessionId: String(search.id) } as const;
  });
}
