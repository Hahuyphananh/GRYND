// src/lib/rooms/settings.ts
//
// Room settings: what a client may ask for, and what the server will actually
// store. PURE — no database, no game stores — so the validation that decides
// whether a room may carry a stake is unit-tested (tests/private-rooms.test.mjs)
// instead of only being reachable through a live API call.
//
// THE WAGER POLICY IS NOT REIMPLEMENTED: legality belongs to
// src/lib/games/stakes.js (`validateWager`), which every game entry point
// already uses. This module only adds the per-game ROOM ceiling from the
// catalog — that is what makes "Pool Masters rooms are free-play only" a server
// rule, and it is why a request body can never talk a game into a stake its
// lobby flow cannot settle.
//
// Only the stake is a setting today, because that is the only room-level rule
// the three supported games take (see catalog.ts). The shape is generic: the
// first real per-game option (a chess time control, say) is one field here plus
// one in the adapter that reads it.

import { validateWager } from "../games/stakes";
import { getRoomGame } from "./catalog";

/** The validated settings a room carries. Only the stake is a rule today. */
export interface RoomSettings {
  /** Coins on the line. 0 = a free match, and always legal. */
  stake: number;
}

// A PLAIN object rather than a discriminated union: this repo compiles with
// `strict: false`, where narrowing a union on a boolean discriminant does not
// work as expected (the same note src/lib/auth/requireAgeVerified.ts carries).
export interface SettingsResult {
  ok: boolean;
  /** Present when `ok`. */
  settings?: RoomSettings;
  /** Present when not `ok`. */
  status?: number;
  message?: string;
}

/**
 * Validate and normalise requested settings for one game.
 *
 * `raw` is whatever the client sent (`{ stake: 25 }`); unknown keys never reach
 * here — the route's allowlist validation rejects them first — and an absent /
 * null stake means free play.
 */
export function resolveRoomSettings(
  gameKey: unknown,
  raw: unknown,
): SettingsResult {
  const game = getRoomGame(gameKey);
  if (!game) {
    return { ok: false, status: 400, message: "Unsupported game for a private room" };
  }

  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const requested = source.stake;

  const wager = validateWager(requested, game.key);
  if (!wager.ok) {
    // `validateWager`'s own message + status: the platform's wording, not a
    // second set of bounds invented here.
    return { ok: false, status: wager.status, message: wager.error };
  }
  if (wager.stake > game.maxStake) {
    return {
      ok: false,
      status: 400,
      message:
        game.maxStake === 0
          ? `${game.label} private rooms are free-play only`
          : `Maximum stake for ${game.label} is ${game.maxStake} coins`,
    };
  }
  return { ok: true, settings: { stake: wager.stake } };
}

/**
 * The settings a FREE friend challenge runs with: chosen by the server, never
 * by the challenger. A challenge is therefore always a free match — which is
 * what makes it safe to allow without a Pro membership, since accepting one can
 * never move coins on the acceptor's behalf.
 */
export function challengeSettings(): RoomSettings {
  return { stake: 0 };
}
