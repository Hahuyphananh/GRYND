// src/lib/roulette-pvp/rooms.js
//
// Shared Socket.IO room-id constants for the Roulette PvP match system.
// Centralised so the lobby page and the match view agree on naming (a
// typo in only one would silently break the per-match live update
// channel).
//
// Wiring overview (client-driven fanout via the realtime-server's
// generic `room_event` handler in realtime-server/server.js):
//
//   Player A — lobby page: hits /api/roulette-pvp/create-or-join.
//     createOrJoin() may either return A's own existing match (no-op)
//     OR the freshly-matched pair. After success, the lobby emits
//       room_event({ roomId: roulette-pvp:match:${id},
//                  event:   "lobby:updated" })
//     so that Player B (who is sitting on /casino/roulette/[matchId]
//     AFTER the join) sees the status flip from waiting → ready
//     without waiting for the next 1.5 s poll.
//
//   In match view, both players are members of the per-match room.
//   When Player A POSTs /api/roulette-pvp/match/[matchId]/bet and the
//   server's submitBets resolves the round, Player A's client emits
//   the same room_event — Player B's fetchStatus fires inside ~50 ms
//   (socket round trip) instead of waiting for the 1.5 s poll.
//
//   Polling is still active as a safety net for cases where the
//   socket round-trip drops (mobile suspend, etc.). The polling
//   interval remains 1.5 s but the user-perceived latency for
//   opponent stake changes and round resolutions drops to "instant".

/** Lobby-list refresh room (open roulette-pvp lobbies). */
export const ROULETTE_PVP_LOBBY_ROOM = "lobby:roulette-pvp";

/**
 * Per-match live-update room. Each match has its own room id so
 * emissions don't leak to other matches' open sockets.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function roulettePvpMatchRoom(matchId) {
  return `roulette-pvp:match:${matchId}`;
}

/** The event name broadcast on the per-match room. The match view
 *  listens for this and re-fetches status. */
export const ROULETTE_PVP_MATCH_UPDATED = "lobby:updated";
