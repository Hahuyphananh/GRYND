// src/lib/keno-pvp/rooms.js
//
// Shared Socket.IO room-id constants + a safe server-side broadcast
// helper for the Keno PvP ("Keno Survival Duel") match system. Centralised
// so the lobby page, the match view, and the server store all agree on
// room naming — a typo in only one would silently break the per-match
// live-update channel.
//
// Mirrors `src/lib/slots-pvp/rooms.js` exactly; rooms are namespaced
// with `keno-pvp` so emissions don't leak across PvP features.
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Player A — lobby page: hits /api/keno-pvp/create-or-join.
//     createOrJoin() either returns A's own existing match (no-op) or
//     the freshly-matched pair. After success, the lobby emits
//       room_event({ roomId: keno-pvp:match:${id},
//                  event:   "lobby:updated" })
//     so Player B (sitting on /casino/keno-pvp/[matchId] AFTER the
//     join) sees the status flip from waiting → ready without waiting
//     for the next poll.
//
//   In match view, both players are members of the per-match room.
//   When Player A POSTs /api/keno-pvp/match/[matchId]/catch and the
//   server records the claim (and lights the next tile), Player A's
//   client emits the same room_event — Player B's status poll fires
//   inside ~50 ms (socket round trip) instead of waiting for the next
//   poll.
//
//   Polling remains active as a safety net for cases where the socket
//   round-trip drops (mobile suspend, etc.).

/** Lobby-list refresh room (open keno-pvp lobbies). */
export const KENO_PVP_LOBBY_ROOM = "lobby:keno-pvp";

/**
 * Per-match live-update room. Each match has its own room id so
 * emissions don't leak to other matches' open sockets.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function kenoPvpMatchRoom(matchId) {
  return `keno-pvp:match:${matchId}`;
}

/**
 * Event name broadcast on the per-match room. Same string
 * (`"lobby:updated"`) as every other PvP game so the realtime-server's
 * generic `room_event` handler routes them identically.
 */
export const KENO_PVP_MATCH_UPDATED = "lobby:updated";

/**
 * Broadcast a `KENO_PVP_MATCH_UPDATED` event to every socket currently
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
  const roomId = kenoPvpMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(KENO_PVP_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn(
      "[keno-pvp] broadcastMatchUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}
