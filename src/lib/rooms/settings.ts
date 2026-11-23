// src/lib/rooms/settings.ts
//
// Room settings: what a client may ask for, and what the server will actually
// store. PURE — no database, no game stores.
//
// WAGERS ARE GONE: the coin economy was removed, so a room and a friend
// challenge are always free. The `stake` field stays in the stored shape for
// legacy rows, but it is never set from a request and is always 0 for new
// rooms.
//
// Only the timer is a setting today. The shape is generic: the first real
// per-game option (a chess time control, say) is one field here plus one in the
// adapter that reads it.
import {
  ROOM_DEFAULT_TIMER_SECONDS,
  ROOM_TIMER_OPTIONS,
  getRoomGame,
} from "./catalog";

/** The validated settings a room carries. */
export interface RoomSettings {
  /** Coins on the line. 0 = a free match, and always legal. */
  stake: number;
  /**
   * How long this room stays open and joinable, in seconds. One of
   * ROOM_TIMER_OPTIONS. It is the ROOM's clock (the invitation window), not a
   * match clock — no supported game accepts a per-match timer yet.
   */
  timerSeconds: number;
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

  const requestedTimer = source.timerSeconds;
  // A number only: a JSON string that happens to spell an option is refused,
  // so the stored setting is always the exact value the catalog offers.
  const timerSeconds =
    requestedTimer === undefined || requestedTimer === null
      ? ROOM_DEFAULT_TIMER_SECONDS
      : typeof requestedTimer === "number"
        ? requestedTimer
        : Number.NaN;
  if (!ROOM_TIMER_OPTIONS.includes(timerSeconds)) {
    return {
      ok: false,
      status: 400,
      message: `Room timer must be one of ${ROOM_TIMER_OPTIONS.join(", ")} seconds`,
    };
  }

  // A stake in the request body is ignored: every room is free play.
  return { ok: true, settings: { stake: 0, timerSeconds } };
}

/**
 * The settings a FREE friend challenge runs with: chosen by the server, never
 * by the challenger. A challenge is therefore always a free match — which is
 * what makes it safe to allow without a Pro membership, since accepting one can
 * never move coins on the acceptor's behalf.
 */
export function challengeSettings(): RoomSettings {
  return { stake: 0, timerSeconds: ROOM_DEFAULT_TIMER_SECONDS };
}
