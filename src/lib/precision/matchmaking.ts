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
import { mirrorPrecisionQueued } from "./canonicalLifecycle";
import { makeInitialMatch } from "./engine";
import {
  LOBBY_COLUMNS,
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

export type AutoMatchResult = AutoMatchWaitingResult | AutoMatchMatchedResult;

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
  const paired = await db.transaction(async (tx) => {
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
