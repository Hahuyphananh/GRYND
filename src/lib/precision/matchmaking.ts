// ── Auto-matchmaking for the Precision PvP casino game ─────────────────
//
// Pairs two players that click "Find match" at the SAME wager amount.
//
// The queue is `precision_lobbies` in Postgres (it used to be a process-local
// Map, which meant two callers on different serverless instances could never
// see each other — nobody ever got matched). Pairing is a single transaction:
//
//   1. take the oldest waiting lobby at this wager that isn't the caller's,
//      `FOR UPDATE SKIP LOCKED` so concurrent callers walk past each other's
//      rows instead of blocking;
//   2. flip that row `waiting → active` and stamp the opponent (the UPDATE
//      re-checks `status = 'waiting'`, so a lobby can be claimed exactly
//      once, by exactly one caller);
//   3. create the match row under the claimed lobby id — the lobby id IS the
//      match id, so both players navigate to the same
//      /casino/precision/game/<id> URL.
//
// Conventions:
//   * Host-side wait state lives in `precision_lobbies` with status='waiting'.
//   * Polling via /api/precision/get-match surfaces the state transition to
//     both clients; no socket work is needed because the match page already
//     re-renders when state.phase flips out of "waiting".

import { and, asc, eq, ne } from "drizzle-orm";

import { db } from "../../db/client";
import { precisionLobbies } from "../../db/schema";
import { MAX_WAGER } from "./constants";
import { mirrorPrecisionQueued } from "./canonicalLifecycle";
import { makeInitialMatch } from "./engine";
import {
  LOBBY_COLUMNS,
  PrecisionEscrowError,
  createMatchForPairing,
  mapLobbyRow,
  sweepPrecisionGamesIfDue,
  toClientLobby,
  type PrecisionLobbyRow,
} from "./serverStore";
import type { PrecisionLobby, PrecisionPlayer, PrecisionState } from "./types";

/** Re-exported so routes/tests that build a canonical match state keep a
 *  single import site (`matchmaking` used to own this). The rules live in
 *  the pure engine now. */
export { makeInitialMatch };

export interface AutoMatchWaitingResult {
  status: "waiting";
  gameId: string;
  lobby: PrecisionLobby;
}

export interface AutoMatchMatchedResult {
  status: "matched";
  gameId: string;
  match: PrecisionState;
  /** Opponent from the perspective of the caller (the joiner) — the host,
   *  who occupies seat 1. */
  opponent: { userId: string; name: string; seat: 1 | 2 };
}

/** A pairing was found but could not be funded: one of the two seats cannot
 *  cover the wager. The claimed lobby is rolled back to `waiting`, so the
 *  caller simply gets the reason (and can top up and retry). */
export interface AutoMatchInsufficientResult {
  status: "insufficient";
  error: string;
  statusCode: number;
}

export type AutoMatchResult =
  | AutoMatchWaitingResult
  | AutoMatchMatchedResult
  | AutoMatchInsufficientResult;

interface AutoPairOptions {
  /** Wager the caller is matching on, already clamped to a valid value. */
  wager: number;
  /** Stable id of the calling user (clerkId in production). */
  hostUserId: string;
  /** Display name, surfaced to the opponent when paired. */
  hostName: string;
}

/** This user's own waiting entry at this wager, if any. */
async function findOwnWaitingLobby(
  wager: number,
  hostUserId: string,
): Promise<PrecisionLobbyRow | null> {
  const [row] = await db
    .select(LOBBY_COLUMNS)
    .from(precisionLobbies)
    .where(
      and(
        eq(precisionLobbies.status, "waiting"),
        eq(precisionLobbies.gameMode, "pvp"),
        eq(precisionLobbies.wager, wager),
        eq(precisionLobbies.hostUserId, hostUserId),
      ),
    )
    .orderBy(asc(precisionLobbies.createdAt))
    .limit(1);
  return row ? mapLobbyRow(row as Record<string, unknown>) : null;
}

/**
 * Create the match a PRIVATE ROOM / friend challenge is for: one named pair,
 * with nothing in the public queue.
 *
 * It is the SAME creation path a public pairing takes — a `precision_lobbies`
 * row whose id becomes the match id, claimed by a conditional UPDATE, then
 * `createMatchForPairing` (which is also what funds both seats when the room
 * carries a stake) — but the row is inserted and claimed inside ONE
 * transaction. A public queue can therefore never observe it (`listLobbies`
 * selects `status = 'waiting'`) and `/api/precision/join-lobby` refuses any id
 * that already has a match row, so a third player cannot walk into the seat.
 *
 * Identities come from the caller (an authenticated route), never from input.
 */
export async function createPrecisionMatchForPair({
  hostUserId,
  hostName,
  opponentUserId,
  opponentName,
  wager = 0,
}: {
  hostUserId: string;
  hostName?: string;
  opponentUserId: string;
  opponentName?: string;
  wager?: number;
}): Promise<
  | { ok: true; matchId: string; state: PrecisionState }
  | { ok: false; status: number; message: string }
> {
  if (!hostUserId || !opponentUserId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  if (hostUserId === opponentUserId) {
    return { ok: false, status: 400, message: "You cannot play yourself" };
  }
  const stake = Number(wager) || 0;
  if (stake < 0 || !Number.isInteger(stake) || stake > MAX_WAGER) {
    return { ok: false, status: 400, message: "Invalid wager" };
  }

  const lobbyId = `lobby-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  try {
    const state = await db.transaction(async (tx) => {
      await tx.insert(precisionLobbies).values({
        id: lobbyId,
        hostUserId,
        hostName: hostName || "Player 1",
        opponentUserId: null,
        opponentName: null,
        wager: stake,
        gameMode: "pvp",
        status: "waiting",
        createdAt: new Date(),
      });

      // The same conditional claim the public pairing uses: the seat is taken
      // once, by the opponent we were asked to seat. Unreachable but checked —
      // never build a match on a seat we do not own.
      const [claimed] = await tx
        .update(precisionLobbies)
        .set({ status: "active", opponentUserId, opponentName: opponentName || "Player 2" })
        .where(
          and(
            eq(precisionLobbies.id, lobbyId),
            eq(precisionLobbies.status, "waiting"),
            ne(precisionLobbies.hostUserId, opponentUserId),
          ),
        )
        .returning(LOBBY_COLUMNS);

      if (!claimed) throw new Error("Precision lobby could not be claimed");

      const host = mapLobbyRow(claimed as Record<string, unknown>);
      const players: PrecisionPlayer[] = [
        { seat: 1, userId: hostUserId, name: host.hostName || "Player 1", isReady: false, isConnected: true },
        { seat: 2, userId: opponentUserId, name: opponentName || "Player 2", isReady: false, isConnected: true },
      ];

      return createMatchForPairing({ matchId: host.id, wager: stake, players }, tx);
    });

    return { ok: true, matchId: lobbyId, state };
  } catch (err) {
    // A seat that cannot cover the stake refuses the room instead of leaving a
    // half-created match: the transaction rolled the lobby row back with it.
    if (err instanceof PrecisionEscrowError) {
      return { ok: false, status: err.status, message: err.message };
    }
    return {
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : "Unable to create the match",
    };
  }
}

/**
 * Atomically either:
 *   1. Pair the caller with a waiting lobby at the same wager and return the
 *      joined match + opponent details; or
 *   2. Insert a new waiting lobby and return it for the caller to await.
 *
 * Idempotent: a caller who already has a waiting entry at this wager gets
 * that same entry back instead of a second one (double-clicks used to orphan
 * lobby rows that cluttered the public list).
 */
export async function tryAutoMatch({
  wager,
  hostUserId,
  hostName,
}: AutoPairOptions): Promise<AutoMatchResult> {
  // Reclaim dead lobbies/matches opportunistically (throttled, best-effort).
  void sweepPrecisionGamesIfDue();

  const own = await findOwnWaitingLobby(wager, hostUserId);
  if (own) {
    return { status: "waiting", gameId: own.id, lobby: toClientLobby(own) };
  }

  // ── Pair: claim the oldest eligible lobby and create the match in ONE ──
  // ── transaction, so two instances can never both claim it.          ──
  let paired: { host: PrecisionLobbyRow; match: PrecisionState } | null;
  try {
    paired = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select(LOBBY_COLUMNS)
        .from(precisionLobbies)
        .where(
          and(
            eq(precisionLobbies.status, "waiting"),
            eq(precisionLobbies.gameMode, "pvp"),
            eq(precisionLobbies.wager, wager),
            ne(precisionLobbies.hostUserId, hostUserId),
          ),
        )
        .orderBy(asc(precisionLobbies.createdAt))
        .for("update", { skipLocked: true })
        .limit(1);

      if (!candidate) return null;

      const claim = await tx
        .update(precisionLobbies)
        .set({
          status: "active",
          opponentUserId: hostUserId,
          opponentName: hostName,
        })
        .where(
          and(
            eq(precisionLobbies.id, candidate.id),
            eq(precisionLobbies.status, "waiting"),
          ),
        )
        .returning(LOBBY_COLUMNS);

      if (!claim[0]) return null;

      const host = mapLobbyRow(claim[0] as Record<string, unknown>);
      const players: PrecisionPlayer[] = [
        {
          seat: 1,
          userId: host.hostUserId,
          name: host.hostName || "Player 1",
          // Both players must explicitly click Ready before the match begins —
          // see `markPlayerReady` in serverStore.ts.
          isReady: false,
          isConnected: true,
        },
        {
          seat: 2,
          userId: hostUserId,
          name: hostName || "Player 2",
          isReady: false,
          isConnected: true,
        },
      ];

      const match = await createMatchForPairing(
        { matchId: host.id, wager: host.wager, players },
        tx,
      );
      return { host, match };
    });
  } catch (err) {
    // A pairing that cannot be funded is refused, not half-created: the
    // transaction above rolled the claim back, so the waiting lobby is still
    // there for someone who can cover the wager.
    if (err instanceof PrecisionEscrowError) {
      return { status: "insufficient", error: err.message, statusCode: err.status };
    }
    throw err;
  }

  if (paired) {
    return {
      status: "matched",
      gameId: paired.host.id,
      match: paired.match,
      opponent: {
        userId: paired.host.hostUserId,
        name: paired.host.hostName || "Player 1",
        seat: 1,
      },
    };
  }

  // No waiting lobby at this wager — insert one and have the caller wait.
  const lobbyId = `lobby-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date();
  await db.insert(precisionLobbies).values({
    id: lobbyId,
    hostUserId,
    hostName: hostName || "Player 1",
    opponentUserId: null,
    opponentName: null,
    wager,
    gameMode: "pvp",
    status: "waiting",
    createdAt,
  });
  mirrorPrecisionQueued({
    matchId: lobbyId,
    playerCount: 1,
    queuedAt: createdAt,
  });
  return {
    status: "waiting",
    gameId: lobbyId,
    lobby: {
      id: lobbyId,
      hostUserId,
      hostName: hostName || "Player 1",
      opponentUserId: null,
      opponentName: null,
      wager,
      gameMode: "pvp",
      status: "waiting",
      createdAt: createdAt.getTime(),
    },
  };
}
