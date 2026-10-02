// src/lib/mines-pvp/rooms.js
//
// Shared Socket.IO room-id constants + safe server-side broadcast helpers for
// the Mines PvP match system. Centralised so the lobby page, the match view,
// the server store and the realtime-server all agree on room naming — a typo
// in only one would silently break the per-match live-update channel.
//
// Mirrors `src/lib/blackjack-pvp/rooms.js` / `src/lib/keno-pvp/rooms.js`;
// rooms are namespaced with `mines-pvp` so emissions don't leak across PvP
// features.
//
// ── The simultaneous model ────────────────────────────────────────────
// There are NO turns any more, so there is no "your turn" push. Both seats
// act independently and every score-changing action produces a realtime
// update. The client relays `lobby:updated` (a bare "refetch the authoritative
// snapshot" hint) after each successful action; the opponent's status GET
// returns that viewer's OWN board state plus the opponent's PUBLIC progress
// (score, revealed/flag counts, completion). No hidden mine information is
// ever broadcast.
//
//   Player A acts → POST /api/mines-pvp/match/:id/{pick|flag|unflag}
//     → client emits room_event({ roomId: mines-pvp:match:id,
//                                event: "lobby:updated" })
//     → Player B refetches /api/mines-pvp/match/:id (per-viewer state)
//
// The realtime-server additionally tracks per-match participants so an
// abandoned socket can be forfeited after a grace window (see
// realtime-server/server.js and /api/mines-pvp/disconnect-forfeit).

/** Lobby-list refresh room (open mines-pvp lobbies). */
export const MINES_PVP_LOBBY_ROOM = "lobby:mines-pvp";

/** Room-id prefix used by the realtime-server's participant tracking. */
export const MINES_PVP_MATCH_ROOM_PREFIX = "mines-pvp:match:";

/**
 * Per-match live-update room id.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function minesPvpMatchRoom(matchId) {
  return `${MINES_PVP_MATCH_ROOM_PREFIX}${matchId}`;
}

/**
 * The generic "refetch the authoritative snapshot" event. Emitted on the
 * per-match room (and the lobby room). It carries NO game authority — the
 * listener refetches `/status`.
 */
export const MINES_PVP_MATCH_UPDATED = "lobby:updated";

/**
 * Cosmetic score-animation event. The server (or the acting client, relayed
 * by the realtime-server's generic `room_event` handler) may emit this after a
 * score-changing action so the opponent can play an animation immediately.
 *
 * It is DELIBERATELY a hint: the payload is never treated as authoritative
 * state — the listener still refetches `/status`, which recomputes every
 * number server-side. Fields:
 *   { seat: "player1"|"player2", delta: number,
 *     reason: "safe"|"correct_flag"|"wrong_flag"|"mine_hit"|"complete",
 *     myScore?: number, opponentScore?: number }
 */
export const MINES_PVP_SCORE_EVENT = "mines-pvp:score";

function safeRoomBroadcast(roomId, event, payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(event, { ...safePayload, sentAt: new Date().toISOString() });
    return true;
  } catch (err) {
    console.warn(
      "[mines-pvp] realtime broadcast failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}

/**
 * Broadcast a `MINES_PVP_MATCH_UPDATED` event to every socket in the
 * per-match room. Safe to call from anywhere — silently no-ops when no io
 * instance is reachable (the client relay + 1.5s polling cover that case).
 *
 * @param {number|string} matchId
 * @param {object} [payload] Extra fields merged into the envelope.
 * @returns {boolean}
 */
export function broadcastMatchUpdate(matchId, payload) {
  return safeRoomBroadcast(minesPvpMatchRoom(matchId), MINES_PVP_MATCH_UPDATED, {
    matchId,
    ...(payload && typeof payload === "object" ? payload : {}),
  });
}

/**
 * Broadcast a cosmetic `MINES_PVP_SCORE_EVENT` to the per-match room. Never
 * authoritative; the client refetches the authoritative snapshot separately.
 *
 * @param {number|string} matchId
 * @param {object} payload { seat, delta, reason, myScore, opponentScore }
 * @returns {boolean}
 */
export function broadcastScoreEvent(matchId, payload) {
  return safeRoomBroadcast(minesPvpMatchRoom(matchId), MINES_PVP_SCORE_EVENT, {
    matchId,
    ...(payload && typeof payload === "object" ? payload : {}),
  });
}
