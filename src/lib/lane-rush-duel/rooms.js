// src/lib/lane-rush-duel/rooms.js
//
// Shared Socket.IO room-id constants + a safe server-side broadcast
// helper for the Lane Rush Duel match system. Mirrors
// `src/lib/mines-pvp/rooms.js` so the lobby page, the match view,
// and the server store all agree on room naming.
//
// Polling remains active as a safety net for cases where the socket
// round-trip drops (mobile suspend, etc.) — the helper silently
// no-ops when `globalThis.io` is not reachable (the realtime-server
// runs in a separate process) and the 1.5s client polling fallback
// covers the latency.

/** Lobby-list refresh room. */
export const LANE_RUSH_DUEL_LOBBY_ROOM = "lobby:lane-rush-duel";

/**
 * Per-match live-update room.
 * @param {number|string} matchId
 * @returns {string}
 */
export function laneRushDuelMatchRoom(matchId) {
  return `lane-rush-duel:match:${matchId}`;
}

/** Event name broadcast on the per-match room AND the lobby room. */
export const LANE_RUSH_DUEL_MATCH_UPDATED = "lobby:updated";

/**
 * Broadcast a `LANE_RUSH_DUEL_MATCH_UPDATED` event to every socket
 * currently joined to the per-match room. Safe to call from
 * anywhere — silently no-ops if `globalThis.io` is not reachable
 * (the client-side polling fallback will deliver the update within
 * ~1.5s).
 *
 * @param {number|string} matchId
 * @param {object} [payload]
 * @returns {boolean}
 */
export function broadcastMatchUpdate(matchId, payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const roomId = laneRushDuelMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(LANE_RUSH_DUEL_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn(
      "[lane-rush-duel] broadcastMatchUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}
