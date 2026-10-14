// src/lib/pool/lobbyJoin.ts
//
// ONE implementation of "claim a Pool Masters lobby and turn it into a match",
// shared by the two callers that need it:
//
//   * POST /api/pool/join-lobby — a player clicking Join in the public lobby
//     list (behaviour unchanged: this module is its extracted body),
//   * a private room / friend challenge (src/lib/rooms/games.ts), which claims
//     a lobby it created itself for the ONE invited opponent.
//
// WHY EXTRACT IT: the claim + `pool_matches` insert must exist exactly once. A
// room that re-implemented "create the match" would be a second source of truth
// for what a Pool match looks like (seats, turn, starting state) and could drift
// from the lobby flow the rest of the game reads.
//
// IDENTITY COMES FROM THE CALLER, never from a request body: every function here
// takes the Clerk ids it was given by an authenticated route.

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { poolLobbies, poolMatches } from "../../db/schema";
import { normalizeStake } from "../games/stakes";

/** The one shape a lobby id must have (uuid) before it is used in a query. */
export const POOL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PoolPairResult =
  | { ok: true; matchId: string; firstTurnSeat: 1 | 2; lobbyId?: string }
  | { ok: false; status: number; message: string };

/**
 * Insert the match behind a claimed lobby. The first turn is drawn at random,
 * exactly as the public join path does, and the starting `gameState` is the
 * game's own shape (`{ started, turn, version }`).
 */
async function insertPoolMatch(
  tx: any,
  {
    lobbyId,
    hostUserId,
    opponentUserId,
    wager,
  }: {
    lobbyId: string | null;
    hostUserId: string;
    opponentUserId: string;
    wager: number;
  },
): Promise<{ matchId: string; firstTurnSeat: 1 | 2 }> {
  const firstTurnUserId = Math.random() < 0.5 ? hostUserId : opponentUserId;
  const firstTurnSeat: 1 | 2 = firstTurnUserId === hostUserId ? 1 : 2;

  const [match] = await tx
    .insert(poolMatches)
    .values({
      id: crypto.randomUUID(),
      lobbyId,
      player1Id: hostUserId,
      player2Id: opponentUserId,
      wager,
      status: "active",
      gameState: {
        started: true,
        turn: firstTurnSeat,
        version: Date.now(),
      },
      currentTurnUserId: firstTurnUserId,
    })
    .returning({ id: poolMatches.id });

  return { matchId: match.id, firstTurnSeat };
}

/**
 * The match a lobby already became, when there is one. This is what makes a
 * repeated Join idempotent instead of an error: the second click lands on the
 * same match rather than asking for a new one.
 */
export async function findPoolMatchForLobby(
  lobbyId: string,
): Promise<{ matchId: string; firstTurnSeat: 1 | 2 } | null> {
  if (!POOL_UUID_RE.test(String(lobbyId || ""))) return null;
  const [existing] = await db
    .select({ id: poolMatches.id, gameState: poolMatches.gameState })
    .from(poolMatches)
    .where(eq(poolMatches.lobbyId, lobbyId))
    .limit(1);
  if (!existing) return null;
  const state = existing.gameState as { turn?: 1 | 2 } | null;
  return { matchId: existing.id, firstTurnSeat: state?.turn === 2 ? 2 : 1 };
}

/**
 * Claim a WAITING lobby for one specific opponent and create the match.
 *
 * The claim is the same conditional UPDATE the public join uses — `status =
 * 'waiting' AND host <> opponent` — so whoever wins that UPDATE owns the seat
 * and two simultaneous joins can never both land in it.
 */
export async function claimPoolLobbyForPair({
  lobbyId,
  opponentUserId,
}: {
  lobbyId: string;
  opponentUserId: string;
}): Promise<PoolPairResult> {
  if (!POOL_UUID_RE.test(String(lobbyId || ""))) {
    return { ok: false, status: 400, message: "Invalid lobby" };
  }
  if (!opponentUserId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  return db.transaction(async (tx) => {
    const [claimedLobby] = await tx
      .update(poolLobbies)
      .set({ status: "active", opponentUserId })
      .where(
        and(
          eq(poolLobbies.id, lobbyId),
          eq(poolLobbies.status, "waiting"),
          ne(poolLobbies.hostUserId, opponentUserId),
        ),
      )
      .returning({
        id: poolLobbies.id,
        hostUserId: poolLobbies.hostUserId,
        wager: poolLobbies.wager,
      });

    if (!claimedLobby) {
      // Not claimable: either somebody else got there first (a match may
      // already exist) or the lobby is gone/closed. The caller decides which.
      return { ok: false as const, status: 409, message: "Lobby unavailable" };
    }

    const { matchId, firstTurnSeat } = await insertPoolMatch(tx, {
      lobbyId: claimedLobby.id,
      hostUserId: claimedLobby.hostUserId,
      opponentUserId,
      wager: normalizeStake(claimedLobby.wager, "pool"),
    });

    return { ok: true as const, matchId, firstTurnSeat, lobbyId: claimedLobby.id };
  });
}

/**
 * Create the match a PRIVATE ROOM is for: one specific pair, no publicly
 * visible waiting lobby.
 *
 * The lobby row is still created (the match keeps its lobby reference, and the
 * game's own columns are filled the same way) but it is created and claimed
 * inside ONE transaction, so `GET /api/pool/lobbies` — which selects
 * `status = 'waiting'` — can never observe it and no third player can claim it.
 * Seats come from the caller's authenticated identities, never from input.
 */
export async function createPoolMatchForPair({
  hostUserId,
  opponentUserId,
  stake = 0,
}: {
  hostUserId: string;
  opponentUserId: string;
  stake?: number | string | null;
}): Promise<PoolPairResult> {
  if (!hostUserId || !opponentUserId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  if (hostUserId === opponentUserId) {
    return { ok: false, status: 400, message: "You cannot play yourself" };
  }

  // Pool's lobby flow carries no escrow of its own, so a room may only open a
  // FREE table here; anything else is refused rather than silently dropped.
  const wager = normalizeStake(stake, "pool");
  if (wager !== 0) {
    return {
      ok: false,
      status: 400,
      message: "Pool Masters private rooms are free-play only",
    };
  }

  return db.transaction(async (tx) => {
    const [lobby] = await tx
      .insert(poolLobbies)
      .values({
        id: crypto.randomUUID(),
        hostUserId,
        wager,
        gameMode: "pvp",
        status: "waiting",
      })
      .returning({ id: poolLobbies.id });

    const [claimed] = await tx
      .update(poolLobbies)
      .set({ status: "active", opponentUserId })
      .where(
        and(
          eq(poolLobbies.id, lobby.id),
          eq(poolLobbies.status, "waiting"),
          ne(poolLobbies.hostUserId, opponentUserId),
        ),
      )
      .returning({ id: poolLobbies.id });

    if (!claimed) {
      // Unreachable: the row was just created by this transaction and nobody
      // else can see it. Never assume it — refuse instead of building a match
      // on a seat we do not own.
      throw new Error("Pool lobby could not be claimed");
    }

    const { matchId, firstTurnSeat } = await insertPoolMatch(tx, {
      lobbyId: claimed.id,
      hostUserId,
      opponentUserId,
      wager,
    });

    return { ok: true as const, matchId, firstTurnSeat, lobbyId: claimed.id };
  });
}
