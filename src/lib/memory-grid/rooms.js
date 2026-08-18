// src/lib/memory-grid/rooms.js
//
// Shared Socket.IO room-id constants + a safe server-side broadcast
// helper for the Memory Grid match system. Centralised so the lobby
// page, the match view, and the server store all agree on room
// naming — a typo in only one would silently break the per-match
// live-update channel.
//
// Mirrors `src/lib/mines-pvp/rooms.js` (which itself mirrors
// blackjack-pvp / roulette-pvp) so contributions to any PvP feature
// feel familiar; we namespace the rooms with `memory-grid` so
// emissions don't leak across PvP features.
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Player A — lobby page: hits /api/memory-grid/create-or-join.
//     createOrJoin() either returns A's own existing match (no-op)
//     or the freshly-matched pair. After success, the lobby emits
//       room_event({ roomId: memory-grid:match:${id},
//                  event:   "lobby:updated" })
//     so that Player B (sitting on /casino/memory-grid/[matchId]
//     AFTER the join) sees the status flip from waiting → ready
//     without waiting for the next 1.5 s poll.
//
//   In match view, both players are members of the per-match room.
//   When Player A POSTs /api/memory-grid/match/[matchId]/reconstruct
//   and the server's submitReconstruction advances the turn (or
//   resolves the match), the route broadcasts the same room_event —
//   Player B's status poll fires inside ~50 ms (socket round trip)
//   instead of waiting for the 1.5 s poll.
//
//   Polling remains active as a safety net for cases where the
//   socket round-trip drops (mobile suspend, etc.). The polling
//   interval stays 1.5 s but the user-perceived latency for
//   opponent submissions and phase advances drops to "instant".

/** Lobby-list refresh room (open memory-grid lobbies). The casino
 *  lobby page joins this on mount and re-renders its list whenever
 *  it receives a `MEMORY_GRID_MATCH_UPDATED` event broadcast on
 *  this room. */
export const MEMORY_GRID_LOBBY_ROOM = "lobby:memory-grid";

/**
 * Per-match live-update room. Each match has its own room id so
 * emissions don't leak to other matches' open sockets.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function memoryGridMatchRoom(matchId) {
  return `memory-grid:match:${matchId}`;
}

/**
 * Event name broadcast on the per-match room AND the lobby room.
 * The match view listens for this and re-fetches status. Mirrors
 * `MINES_PVP_MATCH_UPDATED` / `BLACKJACK_PVP_MATCH_UPDATED` (all
 * the same string `"lobby:updated"`) so the realtime-server's
 * generic `room_event` handler routes them identically.
 */
export const MEMORY_GRID_MATCH_UPDATED = "lobby:updated";

/**
 * Broadcast a `MEMORY_GRID_MATCH_UPDATED` event to every socket
 * currently joined to the per-match room. Safe to call from
 * anywhere — silently no-ops if `globalThis.io` is not reachable
 * (the client-side polling fallback will deliver the update
 * within ~1.5 s).
 *
 * @param {number|string} matchId
 * @param {object} [payload] Extra fields merged into the broadcast
 *   envelope.
 * @returns {boolean} `true` if the broadcast was dispatched,
 *   `false` if no io instance was reachable (silent no-op).
 */
export function broadcastMatchUpdate(matchId, payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const roomId = memoryGridMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(MEMORY_GRID_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    // Never let a broadcast failure bubble up to the calling API
    // route — a missed broadcast is recoverable (polling will catch
    // up) but a 500 on /api/memory-grid/reconstruct is a hard failure.
    console.warn(
      "[memory-grid] broadcastMatchUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}
