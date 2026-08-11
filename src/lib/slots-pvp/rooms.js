// src/lib/slots-pvp/rooms.js
//
// Shared Socket.IO room-id constants + a safe server-side broadcast
// helper for the PvP Slots match system. Centralised so the lobby page,
// the match view, and the server store all agree on room naming —
// a typo in only one would silently break the per-match live-update
// channel.
//
// Mirrors `src/lib/plinko-pvp/rooms.js` exactly so contributions to
// either PvP feature feel familiar; rooms are namespaced with
// `slots-pvp` so emissions don't leak across PvP features.
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Both players sit on `/casino/slots-pvp/[matchId]` and are members
//   of the per-match room. When a player POSTs a reel stop and the
//   server resolves the round (or the whole match after round 5), the
//   API route calls `broadcastMatchUpdate(id)` — the opponent's status
//   poll fires inside ~50 ms (socket round trip) instead of waiting for
//   the 800 ms poll.
//
//   Polling remains active as a safety net (mobile suspend, dropped
//   socket). The 10-second round deadline is enforced server-side on
//   every status poll regardless of sockets.

/** Lobby-list refresh room (future lobby step; API routes currently
 *  refresh the open-lobbies list by polling, matching the other PvP
 *  games). */
export const SLOTS_PVP_LOBBY_ROOM = "lobby:slots-pvp";

/**
 * Per-match live-update room. Each match has its own room id so
 * emissions don't leak to other matches' open sockets.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function slotsPvpMatchRoom(matchId) {
  return `slots-pvp:match:${matchId}`;
}

/**
 * Event name broadcast on the per-match room. Same string
 * (`"lobby:updated"`) as every other PvP game so the realtime-server's
 * generic `room_event` handler routes them identically.
 */
export const SLOTS_PVP_MATCH_UPDATED = "lobby:updated";

/**
 * Broadcast a `SLOTS_PVP_MATCH_UPDATED` event to every socket currently
 * joined to the per-match room. Safe to call from anywhere — silently
 * no-ops if `globalThis.io` is not reachable (the client-side polling
 * fallback will deliver the update within ~1 s).
 *
 * @param {number|string} matchId
 * @param {object} [payload] Extra fields merged into the envelope.
 * @returns {boolean} `true` if the broadcast was dispatched.
 */
export function broadcastMatchUpdate(matchId, payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const roomId = slotsPvpMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(SLOTS_PVP_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn(
      "[slots-pvp] broadcastMatchUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}
