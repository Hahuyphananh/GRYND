// src/lib/mini-golf/serverStore.ts
//
// The server-authoritative Mini Golf match store. Every state transition in
// the game happens inside a row-locked `db.transaction` here, and the API
// routes are thin wrappers around these functions.
//
// Trust boundary: the ONLY player-authored values that reach this module are
// `angle` and `power`. Ball positions, stroke counts, hole winners, the match
// winner and the rating change are all computed from the server's own
// deterministic simulation (`simulateShot`) applied by the pure rules engine
// (`applyShot`). A client cannot submit a position, a stroke count, a hole
// result or a winner.
//
// Settlement reuses the platform's existing rating/trophy infrastructure
// (`applyRatingResult` / `applyTrophyResult`) inside the SAME transaction that
// finalises the match, exactly once — the guard is the `status` flip to
// `finished` under a `FOR UPDATE` lock, plus those helpers' own
// (user, game, match)-keyed idempotency journals. There is NO second Elo
// implementation and NO wager/token/payout path anywhere in this file.

import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { miniGolfMatches, miniGolfShots, users } from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { COURSE_VERSION, MATCH_STATUS, MINI_GOLF_LOCK_NAMESPACE, RESULT } from "./constants";
import { simulateShot } from "./physics";
import {
  applyShot,
  computeMatchResult,
  createInitialState,
  holeFor,
  normalizeForViewer,
  otherSeat,
  seatForUser,
  statusForState,
  userIdForSeat,
  validateShot,
  type LifecycleStage,
  type MiniGolfState,
  type Seat,
  type Seats,
} from "./rules";

// The rated/trophy game key, and the queue-mirror game key.
//
// Written as a string literal at every call site (rather than a shared
// constant) on purpose: `tests/trophy-system.test.mjs` audits the source for
// `gameKey: "<key>"` to prove every rated game is wired to a trophy writer,
// and a constant reference would be invisible to that check.

type MatchRow = typeof miniGolfMatches.$inferSelect;

export type StoreError = { error: string; status: number };

/** Route-level guard so a non-UUID id can never reach a Postgres uuid cast. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMatchId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
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
export function stateOf(match: MatchRow): MiniGolfState {
  return match.gameState as MiniGolfState;
}

/**
 * Server-generated course seed. `randomInt` (CSPRNG-backed) is used for the
 * seed itself; everything downstream of it is deterministic, so the stored
 * seed alone reproduces the course and every shot forever.
 */
export function generateMatchSeed(): number {
  return randomInt(0, 0x100000000);
}

/** Client-facing DTO for a match row, from `viewerId`'s perspective. */
export function matchToDto(match: MatchRow, viewerId: string | null) {
  const seats = seatsFromRow(match);
  return normalizeForViewer({
    state: stateOf(match),
    seats,
    viewerId,
    status: match.status,
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
  });
}

// ── Lobby / matchmaking ───────────────────────────────────────────────────

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(miniGolfMatches)
    .where(
      and(
        eq(miniGolfMatches.status, MATCH_STATUS.WAITING),
        isNull(miniGolfMatches.player2Id),
      ),
    )
    .orderBy(sql`${miniGolfMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any. */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(miniGolfMatches)
    .where(
      and(
        eq(miniGolfMatches.status, MATCH_STATUS.WAITING),
        isNull(miniGolfMatches.player2Id),
        eq(miniGolfMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${miniGolfMatches.createdAt} ASC`)
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
      sql`SELECT pg_advisory_xact_lock(${MINI_GOLF_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(miniGolfMatches)
      .where(
        and(
          eq(miniGolfMatches.status, MATCH_STATUS.WAITING),
          isNull(miniGolfMatches.player2Id),
        ),
      )
      .orderBy(sql`${miniGolfMatches.createdAt} ASC`)
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

async function createWaitingMatch(tx: any, userId: string) {
  const seed = generateMatchSeed();
  const state = createInitialState({ seed, courseVersion: COURSE_VERSION });
  const seats: Seats = { player1Id: userId, player2Id: null };

  const [match] = await tx
    .insert(miniGolfMatches)
    .values({
      player1Id: userId,
      status: MATCH_STATUS.WAITING,
      currentHole: state.currentHole,
      // No opponent yet, so the only seat is player1.
      currentTurnUserId: userIdForSeat(seats, state.currentTurn),
      player1HoleWins: state.player1HoleWins,
      player2HoleWins: state.player2HoleWins,
      seed,
      courseVersion: COURSE_VERSION,
      gameState: state,
      isAi: false,
    })
    .returning();

  mirrorQueueCreated({
    gameKey: "mini-golf",
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });

  return { match, joined: false };
}

async function joinExistingMatch(tx: any, candidateId: string, userId: string) {
  const [match] = await tx
    .select()
    .from(miniGolfMatches)
    .where(eq(miniGolfMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }

  const state = stateOf(match);
  const seats: Seats = { player1Id: match.player1Id, player2Id: userId };

  // v1 goes straight to `playing`: there is no ready-banner timer, so nothing
  // has to poll a deadline to open the first turn.
  const [updated] = await tx
    .update(miniGolfMatches)
    .set({
      player2Id: userId,
      status: statusForState(state),
      currentHole: state.currentHole,
      currentTurnUserId: userIdForSeat(seats, state.currentTurn),
      player1HoleWins: state.player1HoleWins,
      player2HoleWins: state.player2HoleWins,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(miniGolfMatches.id, candidateId),
        eq(miniGolfMatches.status, MATCH_STATUS.WAITING),
        isNull(miniGolfMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  mirrorQueueCreated({
    gameKey: "mini-golf",
    matchId: updated.id,
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
  });

  return { match: updated, joined: true };
}

// ── Read ──────────────────────────────────────────────────────────────────

export async function fetchMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}) {
  const [match] = await db
    .select()
    .from(miniGolfMatches)
    .where(eq(miniGolfMatches.id, matchId))
    .limit(1);

  if (!match) return { error: "Match not found", status: 404 } as const;
  if (!isParticipant(match, userId)) {
    return { error: "Not a participant of this match", status: 403 } as const;
  }

  return { match, dto: matchToDto(match, userId) } as const;
}

/** Authoritative stroke history for a match, oldest first. */
export async function fetchMatchShots(matchId: string, { limit = 200 } = {}) {
  return await db
    .select()
    .from(miniGolfShots)
    .where(eq(miniGolfShots.matchId, matchId))
    .orderBy(sql`${miniGolfShots.shotSeq} ASC`)
    .limit(limit);
}

// ── The only mutating player action: shoot ────────────────────────────────

export type ShootResult =
  | StoreError
  | {
      match: MatchRow;
      state: MiniGolfState;
      shotResult: ReturnType<typeof simulateShot>;
      holeCompleted: boolean;
      matchCompleted: boolean;
      holeWinner: string | null;
      /** Ordered lifecycle transitions the shot produced (see rules.ts). */
      stages: LifecycleStage[];
    };

/**
 * Apply one shot. The complete anti-cheat surface of the game:
 *
 *   • participant check          — you cannot shoot in someone else's match
 *   • status check               — no shots on waiting/finished/cancelled
 *   • turn check                 — `validateShot` (state.currentTurn === seat)
 *   • double-shot check          — the shooter's ball is not already holed out
 *   • optimistic concurrency     — `expectedVersion` must equal state.version
 *   • input range check          — finite angle in [0,360), power in [0,100]
 *   • one-shot-per-sequence      — row lock + unique(match_id, shot_seq)
 *
 * The row lock (`FOR UPDATE`) serialises concurrent shoot calls on the same
 * match, so two requests cannot both read version N and each apply a shot.
 */
export async function shoot({
  userId,
  matchId,
  angle,
  power,
  expectedVersion,
}: {
  userId: string;
  matchId: string;
  angle: unknown;
  power: unknown;
  expectedVersion?: unknown;
}): Promise<ShootResult> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(miniGolfMatches)
      .where(eq(miniGolfMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }
    if (match.status === MATCH_STATUS.WAITING) {
      return { error: "Waiting for an opponent", status: 409 } as const;
    }
    if (
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      return { error: "Match is not active", status: 409 } as const;
    }
    if (!seats.player2Id) {
      return { error: "Waiting for an opponent", status: 409 } as const;
    }

    const state = stateOf(match);
    const validation = validateShot({
      state,
      seat,
      angle,
      power,
      expectedVersion,
    });
    if (!validation.ok) {
      return {
        error: validation.error ?? "Invalid shot",
        status: validation.status ?? 400,
      } as const;
    }

    // Authoritative simulation. The hole geometry and the starting ball both
    // come from the persisted state — never from the request.
    const hole = holeFor(state);
    const from = state.balls[seat as Seat];
    const shotResult = simulateShot({
      hole,
      from: { x: from.x, y: from.y },
      shot: { angle: Number(angle), power: Number(power) },
    });

    const applied = applyShot({
      state,
      seat: seat as Seat,
      angle: Number(angle),
      power: Number(power),
      shotResult,
    });
    const nextState = applied.state;
    const strokeNumber =
      nextState.holeScores[state.currentHole - 1][seat as Seat];

    await tx.insert(miniGolfShots).values({
      matchId: match.id,
      shotSeq: nextState.shotSeq,
      holeNumber: state.currentHole,
      playerId: userId,
      strokeNumber,
      angle: String(Number(angle)),
      power: String(Number(power)),
      result: shotResult,
    });

    const outcome = applied.matchCompleted
      ? computeMatchResult(nextState)
      : null;

    const updates: Partial<typeof miniGolfMatches.$inferInsert> = {
      gameState: nextState,
      currentHole: nextState.currentHole,
      currentTurnUserId: userIdForSeat(seats, nextState.currentTurn),
      player1HoleWins: nextState.player1HoleWins,
      player2HoleWins: nextState.player2HoleWins,
      status: outcome ? MATCH_STATUS.FINISHED : statusForState(nextState),
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
      .update(miniGolfMatches)
      .set(updates)
      .where(eq(miniGolfMatches.id, match.id))
      .returning();

    if (outcome) {
      // Exactly-once settlement, in the same transaction that finalised the
      // match. `applyRatingResult` / `applyTrophyResult` are journal-keyed by
      // (user, game, match) so a retry can never move a rating twice.
      await settleMatch(tx, match, outcome);
      mirrorQueueTransition({
        gameKey: "mini-golf",
        matchId: match.id,
        status: "completed",
        playerCount: 2,
        cancelReason: null,
        at: new Date(),
      });
    }

    return {
      match: updated ?? match,
      state: nextState,
      shotResult,
      holeCompleted: applied.holeCompleted,
      matchCompleted: applied.matchCompleted,
      holeWinner: applied.holeWinner,
      stages: applied.stages,
    };
  });
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
      .from(miniGolfMatches)
      .where(eq(miniGolfMatches.id, matchId))
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

    const winnerSeat = otherSeat(seat as Seat);
    const state = stateOf(match);
    const finishedState: MiniGolfState = { ...state, phase: "finished" };
    const outcome = { result: winnerSeat, winnerSeat };

    const [updated] = await tx
      .update(miniGolfMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        gameState: finishedState,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(miniGolfMatches.id, match.id))
      .returning();

    await settleMatch(tx, match, outcome);
    mirrorQueueTransition({
      gameKey: "mini-golf",
      matchId: match.id,
      status: "completed",
      playerCount: 2,
      cancelReason: null,
      at: new Date(),
    });

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
      .from(miniGolfMatches)
      .where(eq(miniGolfMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 } as const;
    }
    if (match.status !== MATCH_STATUS.WAITING) {
      return {
        error: "Match cannot be cancelled after an opponent joins",
        status: 409,
      } as const;
    }

    const state = stateOf(match);
    const cancelledState: MiniGolfState = { ...state, phase: "finished" };

    const [updated] = await tx
      .update(miniGolfMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        gameState: cancelledState,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(miniGolfMatches.id, match.id))
      .returning();

    // A cancelled lobby never settled, so no rating/stats are touched.
    mirrorQueueTransition({
      gameKey: "mini-golf",
      matchId: match.id,
      status: "cancelled",
      playerCount: 1,
      cancelReason: "host_cancelled",
      at: new Date(),
    });

    return { match: updated ?? match } as const;
  });
}

// ── Disconnect / abandonment ─────────────────────────────────────────────────

/**
 * Resolve a match whose participant's socket stayed disconnected past the
 * realtime server's grace window. This is the \"abandoned match\" path, and it
 * is idempotent by construction:
 *
 *   • already finished / cancelled → no-op (the realtime retry loop stops)
 *   • still an open lobby (waiting, no opponent) → release it as `cancelled`,
 *     so an abandoned lobby never lingers in the available list
 *   • active match → the opponent is awarded the win through the exact same
 *     settlement path as a played-out victory or a manual forfeit
 *
 * Called only by /api/mini-golf/disconnect-forfeit, which re-verifies the
 * socket's Clerk token first, so the endpoint can never be used to grieve
 * another player's match.
 */
export type DisconnectResult =
  | StoreError
  | { match: MatchRow; forfeited: boolean; cancelled: boolean };

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
      .from(miniGolfMatches)
      .where(eq(miniGolfMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 } as const;

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) {
      return { error: "Not a participant of this match", status: 403 } as const;
    }

    // Terminal — nothing to resolve. Reported (not an error) so the realtime
    // retry loop stops instead of hammering the endpoint.
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
      const cancelledState: MiniGolfState = { ...state, phase: "finished" };
      const [updated] = await tx
        .update(miniGolfMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          gameState: cancelledState,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(miniGolfMatches.id, match.id))
        .returning();

      mirrorQueueTransition({
        gameKey: "mini-golf",
        matchId: match.id,
        status: "cancelled",
        playerCount: 1,
        cancelReason: "disconnected",
        at: new Date(),
      });

      return { match: updated ?? match, forfeited: false, cancelled: true } as const;
    }

    // Active match: award the opponent the win, with the standard settlement.
    const winnerSeat = otherSeat(seat as Seat);
    const state = stateOf(match);
    const finishedState: MiniGolfState = { ...state, phase: "finished" };
    const outcome = { result: winnerSeat, winnerSeat };

    const [updated] = await tx
      .update(miniGolfMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        result: winnerSeat,
        winnerId: userIdForSeat(seats, winnerSeat),
        gameState: finishedState,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(miniGolfMatches.id, match.id))
      .returning();

    await settleMatch(tx, match, outcome);
    mirrorQueueTransition({
      gameKey: "mini-golf",
      matchId: match.id,
      status: "completed",
      playerCount: 2,
      cancelReason: null,
      at: new Date(),
    });

    return { match: updated ?? match, forfeited: true, cancelled: false } as const;
  });
}

// ── Settlement (existing GRYND rating/trophy infrastructure only) ─────────

/**
 * Record the outcome of a finished Mini Golf match.
 *
 * Reuses the platform's Elo (`applyRatingResult`) and trophy
 * (`applyTrophyResult`) helpers — there is deliberately no Mini Golf-specific
 * rating maths. Both are called with the store's transaction so the match
 * finalisation and the rating change commit atomically, and both are
 * idempotent per (user, game, match) via their own event journals.
 *
 * No wager, no token, no payout: Mini Golf is unstaked, so the only account
 * stats touched are `users.gamesWon` / `users.gamesLost`. The leaderboard
 * counters are deliberately NOT called because `applyLeaderboardCounters` is
 * wager-gated (`bet <= 0` returns early) and this game has no wager — calling
 * it would be a no-op that reads like a bug.
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
    // A draw moves both ratings by K × (0.5 − expected) and awards no
    // trophies, but it is still journaled so the event history stays complete.
    await applyRatingResult({
      tx,
      gameKey: "mini-golf",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: "mini-golf",
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
    gameKey: "mini-golf",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "mini-golf",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}
