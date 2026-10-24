// src/lib/hillstrike/rooms.ts
//
// Shared Socket.IO room-id + event-name vocabulary and the safe server-side
// broadcast helper for Hillstrike online 1v1. Centralised so the match view, the
// lobby, the API routes and the realtime server all agree on the room names — a
// typo in only one of them would silently break the per-match live-update
// channel.
//
// Mirrors `src/lib/barricade/rooms.ts` exactly: one room per match, the generic
// `"lobby:updated"` event string so the realtime server's `room_event` relay
// routes it identically, and a `broadcastMatchUpdate` that silently no-ops when
// no `io` instance is reachable (the standard split-process deployment).
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Lobby → POST /api/hillstrike/create-or-join. Once the caller is seated, the
//   route broadcasts, so the host already waiting flips waiting → playing without
//   waiting for the next poll.
//
//   In the match view both seats join the per-match room
//   (`hillstrike:match:<id>`). After an accepted shot the client emits the
//   dedicated `hillstrike:ready` poke so the opponent's refresh fires in ~50 ms
//   instead of on the next poll tick.
//
//   HTTP polling remains the backstop: the match view re-reads
//   GET /api/hillstrike/match/<id>, which is also the state-synchronisation path
//   after a refresh or a reconnect. A refresh re-joins the room, which is what
//   cancels the realtime server's disconnect grace timer for that seat.
//
// ── Trust boundary ────────────────────────────────────────────────
//
//   Broadcast payloads carry ONLY what the client needs to decide "should I
//   refetch?" (status, version, turn, lives, result). The position and every
//   outcome are always re-read from the authoritative snapshot; nothing here is a
//   client-authoritative input, and the client→server poke carries nothing but
//   the match id.
//
// This module imports nothing (no DB, no React) so the client bundle can use the
// same strings the server emits.

/** Lobby-list refresh room (open Hillstrike lobbies). */
export const HILLSTRIKE_LOBBY_ROOM = "lobby:hillstrike";

/** Namespace prefix for the per-match live-update room. */
export const HILLSTRIKE_MATCH_ROOM_PREFIX = "hillstrike:match:";

/**
 * Per-match live-update room. Each match has its own room id so emissions do
 * not leak to other matches' open sockets.
 */
export function hillstrikeMatchRoom(matchId: string | number): string {
  return `${HILLSTRIKE_MATCH_ROOM_PREFIX}${matchId}`;
}

/**
 * Event name broadcast on the per-match room. The match view listens for this
 * and re-reads the authoritative snapshot. Same string as every other PvP game
 * (`"lobby:updated"`) so the realtime server's generic `room_event` handler
 * routes them identically.
 */
export const HILLSTRIKE_MATCH_UPDATED = "lobby:updated";

/**
 * Dedicated client → server poke emitted after an accepted shot, forfeit or
 * cancel. It carries ONLY `{ matchId }` — a bare invalidation hint. The realtime
 * server checks that the caller is a tracked participant of that match, then
 * relays `HILLSTRIKE_MATCH_UPDATED` to the other seat.
 */
export const HILLSTRIKE_READY = "hillstrike:ready";

/**
 * Broadcast a `HILLSTRIKE_MATCH_UPDATED` event to every socket currently joined
 * to the per-match room.
 *
 * Safe to call from anywhere — silently no-ops and returns `false` when
 * `globalThis.io` is not reachable. A broadcast failure is never allowed to
 * bubble up into the calling API route: a missed push is recoverable, a 500 on an
 * accepted shot is not.
 */
export function broadcastMatchUpdate(
  matchId: string | number,
  payload: Record<string, unknown> = {},
): boolean {
  const io = (
    globalThis as {
      io?: { to?: (room: string) => { emit: (event: string, body: unknown) => void } };
    }
  ).io;
  if (!io || typeof io.to !== "function") return false;

  const roomId = hillstrikeMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(roomId).emit(HILLSTRIKE_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(
      "[hillstrike] broadcastMatchUpdate failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
