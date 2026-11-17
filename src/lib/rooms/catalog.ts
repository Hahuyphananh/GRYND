// src/lib/rooms/catalog.ts
//
// THE list of games a private room / friend challenge can be created for.
//
// GRYND is Solitaire-only, so this list has exactly one entry: Solitaire Duel.
// The module stays client-safe (it imports nothing but the pure wager policy)
// so the UI can render the game picker without pulling in server stores.

import { maxStakeFor } from "../games/stakes";

/** Canonical keys of the games that support rooms today. */
export type RoomGameKey = "solitaire-duel";

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
 *
 * Solitaire Duel is a free ranked game by construction: its match row has a
 * stake column, but the competitive reward is rating/trophies, and a private
 * room must never be the way a wager enters a game that does not use one.
 */
function cap(key: RoomGameKey): number {
  if (key === "solitaire-duel") return 0;
  return Number(maxStakeFor(key)) || 0;
}

export const ROOM_GAMES: readonly RoomGameDef[] = Object.freeze([
  // Solitaire Duel joins on its own `createSolitaireMatchForPair` primitive:
  // the same server seed → solvable deal → two independent boards as its public
  // lobby, seeded directly for the named pair. Free play only — see `cap`.
  { key: "solitaire-duel", label: "Solitaire Duel", mode: "pvp", seats: 2, maxStake: cap("solitaire-duel") },
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

/** This gate is closed until a game is explicitly reviewed for guests. */
export const GUEST_ROOM_GAME_KEYS: readonly string[] = Object.freeze([]);

/** True when a guest may host or join a room for this game. */
export function isGuestRoomGame(key: unknown): boolean {
  const wanted = String(key ?? "").trim().toLowerCase();
  return GUEST_ROOM_GAME_KEYS.includes(wanted);
}

// ── Room lifetime and limits ────────────────────────────────────────────────
//
// A room (and a challenge) is time-boxed: an invitation that nobody answers
// must not stay joinable forever. The sweep is lazy (see src/lib/rooms/store.ts)
// so nothing depends on a cron being alive.

/** How long a PRO custom room stays open and joinable by default. */
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The lifetimes a host may choose for a room, in seconds (15 min … 2 h).
 *
 * This is the ROOM's clock — how long the invitation stays joinable before the
 * lazy expiry sweep closes it — not a match clock.
 */
export const ROOM_TIMER_OPTIONS: readonly number[] = Object.freeze([
  15 * 60,
  30 * 60,
  60 * 60,
  ROOM_TTL_MS / 1000,
]);

/** The lifetime a room gets when the host does not choose one (2 hours). */
export const ROOM_DEFAULT_TIMER_SECONDS = ROOM_TTL_MS / 1000;

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
