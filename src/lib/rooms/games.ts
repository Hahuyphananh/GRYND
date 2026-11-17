// src/lib/rooms/games.ts
//
// THE server-side adapter registry behind private rooms and friend challenges.
//
// GRYND is Solitaire-only, so there is exactly one adapter. It does two things
// and nothing else: decide whether the room's settings are legal, and create
// the real match for one NAMED pair through the game's OWN store.
//
// WHY: the match must be the same object the game's public flow produces (same
// seats, same starting state, same settlement). A room never builds its own
// match row, so it cannot become a second source of truth for the game.
//
// IDENTITY: the caller (an authenticated route) supplies both Clerk ids. No
// function here reads a user id, a match id or a status from a request body.

import { createSolitaireMatchForPair } from "../solitaire-duel/serverStore";
import { getRoomGame, type RoomGameDef } from "./catalog";
import type { RoomSettings } from "./settings";

// Settings validation is pure and lives in ./settings so it can be unit-tested
// without a database; re-exported here so a caller that already holds an
// adapter has one import site for the whole game contract.
export { challengeSettings, resolveRoomSettings } from "./settings";
export type { RoomSettings, SettingsResult } from "./settings";

/** The result of asking a game to create the pair's match. */
export interface PairMatchResult {
  ok: boolean;
  matchId?: string;
  matchUrl?: string;
  status?: number;
  message?: string;
}

/** Where the participants of a match go. */
export function matchUrlFor(gameKey: string, matchId: string): string {
  switch (getRoomGame(gameKey)?.key) {
    case "solitaire-duel":
      return `/casino/solitaire-duel/${matchId}`;
    default:
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
 * `hostUserId` takes the first seat, `opponentUserId` the second — the room's
 * creator is seat 1, exactly as in the public flow.
 */
export async function createPairMatch({
  gameKey,
  hostUserId,
  hostName,
  opponentUserId,
  opponentName,
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

  switch (game.key) {
    case "solitaire-duel": {
      // No stake is passed: the catalog pins Solitaire rooms to free play, and
      // the store's pair primitive takes no stake at all.
      const result = await createSolitaireMatchForPair({
        hostUserId,
        opponentUserId,
      });
      if (!result.ok) {
        const failed = result as { status?: number; message?: string };
        return {
          ok: false,
          status: failed.status ?? 400,
          message: failed.message ?? "Unable to create the match",
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
