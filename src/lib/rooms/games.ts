// src/lib/rooms/games.ts
//
// THE server-side adapter registry behind private rooms and friend challenges.
//
// Each adapter does exactly two things, and nothing else:
//   1. decide whether the room's settings are legal for ITS game, and
//   2. create the real match for one NAMED pair by calling the game's OWN store.
//
// WHY: the match must be the same object the game's public flow produces (same
// seats, same starting state, same escrow, same settlement). A room that built
// its own match row would be a second source of truth for that game and would
// drift from it. So no adapter re-implements game state — it delegates, and the
// delegates are the primitives extracted for this purpose:
//   * Pool Masters  — createPoolMatchForPair  (src/lib/pool/lobbyJoin.ts)
//   * Precision     — createPrecisionMatchForPair (src/lib/precision/matchmaking.ts)
//   * Tower Arena   — createTowerArenaMatchForPair (src/lib/tower-arena/serverStore.ts)
//   * Dominoes      — createDominoesMatchForPair (src/lib/dominoes/serverStore.ts)
//                    (opens the same waiting row + join path its public lobby
//                    uses, in one transaction, so the deal/clock/settlement are
//                    the public ones — and free play only, like Pool Masters.)
//
// PRIVATE MEANS UNOBSERVABLE: every adapter creates AND claims its lobby inside
// ONE transaction, so the public queue/listing (which selects `status =
// 'waiting'`) never sees the row and no third player can be matched into it.
//
// IDENTITY: the caller (an authenticated route) supplies both Clerk ids. No
// function here reads a user id, a match id or a status from a request body.
//
// ADDING A GAME: it needs that "seat these two named players" primitive in its
// own store first. `create-or-join` games (barricade, mini-golf, tic-tac-toe,
// …) pair the caller with ANY waiting row and have no such primitive, so they
// cannot host a room without a per-game rewrite — see docs/PRIVATE_ROOMS.md §1.

import { createDominoesMatchForPair } from "../dominoes/serverStore";
import { createPoolMatchForPair } from "../pool/lobbyJoin";
import { createPrecisionMatchForPair } from "../precision/matchmaking";
import { createTowerArenaMatchForPair } from "../tower-arena/serverStore";
import { getRoomGame, type RoomGameDef } from "./catalog";
import type { RoomSettings } from "./settings";

// Settings validation is pure and lives in ./settings so it can be unit-tested
// without a database; re-exported here so a caller that already holds an
// adapter has one import site for the whole game contract.
export { challengeSettings, resolveRoomSettings } from "./settings";
export type { RoomSettings, SettingsResult } from "./settings";

/** The result of asking a game to create the pair's match. Plain object — see
 *  the note on `Decision` in rules.ts about `strict: false` narrowing. */
export interface PairMatchResult {
  ok: boolean;
  matchId?: string;
  matchUrl?: string;
  status?: number;
  message?: string;
}

/** Where the participants of a match go, per game. */
export function matchUrlFor(gameKey: string, matchId: string): string {
  switch (getRoomGame(gameKey)?.key) {
    case "precision":
      return `/casino/precision/game/${matchId}`;
    case "pool":
      return `/casino/pool-masters/game/${matchId}`;
    case "tower-arena":
      return `/casino/tower-arena/game/${matchId}`;
    case "dominoes":
      // The canonical public match URL — the same one the lobby navigates to
      // and the same one `/games/:slug/:path+` rewrites to the match page.
      return `/games/dominoes/${matchId}`;
    default:
      // Unreachable: `getRoomGame` gated every room before this point. Returning
      // null rather than a guessed URL keeps a bad room from sending players to
      // somebody else's page.
      return "";
  }
}

/** The catalog entry for a key, or null when rooms do not support it. */
export function roomGame(gameKey: unknown): RoomGameDef | null {
  return getRoomGame(gameKey);
}

/**
 * Create the real match for one named pair, through the game's own store.
 *
 * `hostUserId` takes the first seat, `opponentUserId` the second — in every
 * supported game the room's creator is seat 1, exactly as in the public flow.
 */
export async function createPairMatch({
  gameKey,
  hostUserId,
  hostName,
  opponentUserId,
  opponentName,
  settings,
}: {
  gameKey: string;
  hostUserId: string;
  hostName?: string | null;
  opponentUserId: string;
  opponentName?: string | null;
  settings: RoomSettings;
}): Promise<PairMatchResult> {
  const game = getRoomGame(gameKey);
  if (!game) {
    return { ok: false, status: 400, message: "Unsupported game for a private room" };
  }

  const stake = Number(settings?.stake) || 0;

  switch (game.key) {
    case "precision": {
      const result = await createPrecisionMatchForPair({
        hostUserId,
        hostName: hostName || undefined,
        opponentUserId,
        opponentName: opponentName || undefined,
        wager: stake,
      });
      // Read the failure through a widened view: the game's own result type is
      // a boolean-discriminated union, which this repo's `strict: false` cannot
      // narrow (see rules.ts). The values are exactly the game's own.
      if (!result.ok) {
        const failed = result as { status?: number; message?: string };
        return {
          ok: false,
          status: failed.status ?? 400,
          message: failed.message ?? "Unable to create the match",
        };
      }
      return {
        ok: true,
        matchId: result.matchId,
        matchUrl: matchUrlFor(game.key, result.matchId),
      };
    }

    case "pool": {
      const result = await createPoolMatchForPair({
        hostUserId,
        opponentUserId,
        stake,
      });
      if (!result.ok) {
        const failed = result as { status?: number; message?: string };
        return {
          ok: false,
          status: failed.status ?? 400,
          message: failed.message ?? "Unable to create the match",
        };
      }
      return {
        ok: true,
        matchId: result.matchId,
        matchUrl: matchUrlFor(game.key, result.matchId),
      };
    }

    case "tower-arena": {
      const result: {
        match?: { id?: string | number };
        error?: string;
        status?: number;
      } = await createTowerArenaMatchForPair({
        hostUserId,
        opponentUserId,
        wager: stake,
      });
      if (result.error || !result.match?.id) {
        return {
          ok: false,
          status: result.status || 500,
          message: result.error || "Unable to create the match",
        };
      }
      const matchId = String(result.match.id);
      return { ok: true, matchId, matchUrl: matchUrlFor(game.key, matchId) };
    }

    case "dominoes": {
      // No stake is passed: the catalog caps Dominoes at 0 and its store takes
      // no stake argument at all, so a staked room is refused by
      // resolveRoomSettings before this case is reached.
      const result = await createDominoesMatchForPair({
        hostUserId,
        opponentUserId,
      });
      // Read the failure through a widened view: the store returns a
      // boolean-discriminated union, which this repo's `strict: false` cannot
      // narrow (the same note the other cases carry). The values are the
      // store's own.
      if (!result.ok) {
        const failed = result as { status?: number; message?: string };
        return {
          ok: false,
          status: failed.status || 500,
          message: failed.message || "Unable to create the match",
        };
      }
      const created = result as { matchId: string };
      return {
        ok: true,
        matchId: created.matchId,
        matchUrl: matchUrlFor(game.key, created.matchId),
      };
    }

    default:
      return { ok: false, status: 400, message: "Unsupported game for a private room" };
  }
}
