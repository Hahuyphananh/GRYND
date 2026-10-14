// src/lib/rooms/catalog.ts
//
// THE list of games a private room / friend challenge can be created for.
//
// WHY A SEPARATE, CLIENT-SAFE MODULE: the UI has to render the game picker and
// the settings the server will accept, but it must not import the adapters —
// those pull in game server stores and a database client. So this module holds
// only what both sides need (which games, which mode, which stake range) and
// imports nothing but the pure wager policy. The server-side implementation of
// each game lives in src/lib/rooms/games.ts, keyed by the SAME keys.
//
// WHY THE STAKE IS THE ONLY SETTING: Pool Masters, Precision and Tower Arena
// take exactly one room-level rule from a player — the coins on the line — and
// the platform already has ONE wager policy (`maxStakeFor` / `validateWager` in
// src/lib/games/stakes.js). A room therefore re-exposes that policy rather than
// inventing a second one, and a game whose lobby flow cannot escrow a stake
// (Pool Masters) declares `maxStake: 0`, i.e. free play only.
//
// ADDING A GAME: it needs a "seat these two named players" primitive in ITS OWN
// store first (see docs/PRIVATE_ROOMS.md §1), an adapter in src/lib/rooms/games.ts,
// and one entry here. Until then it is not offered anywhere, and the server
// refuses its key (`unknown_game`) instead of faking support.

import { maxStakeFor } from "../games/stakes";

/** Canonical keys of the games that support rooms today. */
export type RoomGameKey = "precision" | "pool" | "tower-arena";

export interface RoomGameDef {
  key: RoomGameKey;
  /** English display name — the UI localises with `roomGame_<key>`. */
  label: string;
  /** The one mode every supported game offers for a room. */
  mode: "pvp";
  /** Seats a room fills. Every supported game is a two-seat duel. */
  seats: number;
  /**
   * Largest legal room stake (coins). `0` means the game's own lobby flow
   * carries no escrow, so the room may only be free-play.
   */
  maxStake: number;
}

/**
 * Cap a room stake by the game's own ceiling. Kept here (not in the UI) so the
 * picker and the server agree by construction: the UI renders `maxStake`, the
 * server re-validates against the same number.
 */
function cap(key: RoomGameKey): number {
  const global = Number(maxStakeFor(key)) || 0;
  // Pool Masters' join-lobby flow never escrows, so a staked table there would
  // be a match that cannot settle a wager. Free only.
  if (key === "pool") return 0;
  return global;
}

export const ROOM_GAMES: readonly RoomGameDef[] = Object.freeze([
  { key: "precision", label: "Precision", mode: "pvp", seats: 2, maxStake: cap("precision") },
  { key: "pool", label: "Pool Masters", mode: "pvp", seats: 2, maxStake: cap("pool") },
  { key: "tower-arena", label: "Tower Arena", mode: "pvp", seats: 2, maxStake: cap("tower-arena") },
]);

/** Every supported key, for server-side membership tests. */
export const ROOM_GAME_KEYS: readonly string[] = Object.freeze(
  ROOM_GAMES.map((g) => g.key),
);

/** The definition for a key, or null when the game cannot host a room. */
export function getRoomGame(key: unknown): RoomGameDef | null {
  const wanted = String(key ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return ROOM_GAMES.find((game) => game.key === wanted) ?? null;
}

/** True when `key` is a game private rooms support. */
export function isRoomGame(key: unknown): key is RoomGameKey {
  return getRoomGame(key) !== null;
}

// ── Room lifetime and limits ────────────────────────────────────────────────
//
// A room (and a challenge) is time-boxed: an invitation that nobody answers
// must not stay joinable forever. The sweep is lazy (see src/lib/rooms/store.ts)
// so nothing depends on a cron being alive.

/** How long a PRO custom room stays open and joinable. */
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

/** How long a friend challenge stays pending before it expires. */
export const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** Invited players a single PRO room may carry (the host is not counted). */
export const ROOM_MAX_INVITES = 8;

/** Characters in a shareable room code. */
export const ROOM_CODE_LENGTH = 10;

/**
 * The alphabet a room code is drawn from. Base32 without I/O/0/1 so a code can
 * be read aloud or retyped without ambiguity — 32^10 ≈ 1.1e15 possibilities, so
 * guessing one is not a strategy. Codes are also unique in the database and
 * join-by-code is rate limited (see the create/join routes).
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
