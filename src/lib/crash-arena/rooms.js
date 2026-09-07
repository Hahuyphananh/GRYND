// src/lib/crash-arena/rooms.js
//
// Shared Socket.IO room-id constants + a safe server-side broadcast
// helper for the Crash Arena multiplayer table system. Centralised so
// the lobby page, the table room page, the round hook and the API
// routes all agree on room naming — a typo in only one would silently
// break the per-table live-update channel.
//
// Mirrors `src/lib/plinko-pvp/rooms.js` and `src/lib/mines-pvp/rooms.js`
// exactly so contributions to the crash flow feel familiar; rooms are
// namespaced with `crash-arena` so emissions don't leak across games.
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Player A — lobby: hits POST /api/crash-arena/create (or /join).
//     After the write commits the client emits `room_event` on the
//     `lobby:crash-arena` room so other lobby users refresh their
//     table grid instantly (the 5 s poll stays as a fallback).
//
//   Table room — every seated/visiting client joins its own per-table
//     room `crash-arena:match:${tableId}`. When any player starts a
//     round, cashes out, or the round crashes, the acting client emits
//     `crashArena:updated` with the tableId + payload. The realtime
//     server validates the caller is a tracked participant, then
//     relays `lobby:updated` to the other sockets in the room. On
//     receipt, the other clients reconcile round state instantly
//     instead of waiting up to 5 s for the poll.
//
//   The API routes additionally call broadcastTableUpdate() — a
//   best-effort push that only fires when `globalThis.io` is reachable
//   (single-process dev/test). In the standard separate-process
//   deployment (Next.js + realtime-server) it silently no-ops and the
//   client-driven fanout above is what delivers the update.

/** Lobby-list refresh room. Lobby clients join this on mount and
 *  refresh their table grid on any `lobby:updated` event. */
export const CRASH_ARENA_LOBBY_ROOM = "lobby:crash-arena";

/**
 * Per-table live-update room. Each table gets its own room id so
 * emissions don't leak to other tables' open sockets.
 *
 * @param {number|string} tableId
 * @returns {string}
 */
export function crashArenaMatchRoom(tableId) {
  return `crash-arena:match:${tableId}`;
}

/**
 * Event name broadcast on the per-table and lobby rooms. Listeners
 * re-fetch table state / reconcile the round. Mirrors
 * `PLINKO_PVP_MATCH_UPDATED` / `MINES_PVP_MATCH_UPDATED` (all the
 * same string `"lobby:updated"`) so the realtime-server's generic
 * `room_event` handler routes them identically.
 */
export const CRASH_ARENA_TABLE_UPDATED = "lobby:updated";

/**
 * Socket event name for the dedicated `crashArena:updated` handler in
 * the realtime-server. Clients emit this after a successful API
 * mutation (start-round, fold, crash/settle, join, leave) so the
 * realtime server can validate participation and relay
 * `CRASH_ARENA_TABLE_UPDATED` to the rest of the table instantly.
 */
export const CRASH_ARENA_READY = "crashArena:updated";

/**
 * Broadcast a `CRASH_ARENA_TABLE_UPDATED` event to every socket
 * joined to the per-table room. Safe to call from anywhere —
 * silently no-ops if `globalThis.io` is not reachable (the
 * client-driven fanout + 5 s poll deliver the update anyway).
 *
 * @param {number|string} tableId
 * @param {object} [payload] Extra fields merged into the broadcast
 *   envelope.
 * @returns {boolean} `true` if the broadcast was dispatched,
 *   `false` if no io instance was reachable (silent no-op).
 */
export function broadcastTableUpdate(tableId, payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const roomId = crashArenaMatchRoom(tableId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(CRASH_ARENA_TABLE_UPDATED, {
      tableId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    // Never let a broadcast failure bubble up to the calling API
    // route — a missed broadcast is recoverable (polling catches up)
    // but a 500 on create/join/start-round is a hard failure.
    console.warn(
      "[crash-arena] broadcastTableUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}

/**
 * Broadcast a `CRASH_ARENA_TABLE_UPDATED` event to the shared lobby
 * room so open-table grids refresh instantly after create/join/leave.
 *
 * @param {object} [payload]
 * @returns {boolean}
 */
export function broadcastLobbyUpdate(payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(CRASH_ARENA_LOBBY_ROOM).emit(CRASH_ARENA_TABLE_UPDATED, {
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn(
      "[crash-arena] broadcastLobbyUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}
