// src/lib/blackjack-pvp/rooms.js
//
// Shared Socket.IO room-id constants for the Blackjack PvP match
// system. Centralised so the lobby page and the match view agree on
// naming — a typo in only one would silently break the per-match
// live-update channel.
//
// Mirrors `src/lib/roulette-pvp/rooms.js` so contributions to either
// feature feel familiar; we namespace the rooms with `blackjack-pvp`
// so emissions don't leak across PvP features.

/** Lobby-list refresh room (open blackjack-pvp lobbies). */
export const BLACKJACK_PVP_LOBBY_ROOM = "lobby:blackjack-pvp";

/**
 * Per-match live-update room. Each match has its own room id so
 * emissions don't leak to other matches' open sockets.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function blackjackPvpMatchRoom(matchId) {
  return `blackjack-pvp:match:${matchId}`;
}

/**
 * Event name broadcast on the per-match room. The match view listens
 * for this and re-fetches status. Mirrors roulette-pvp's
 * `ROULETTE_PVP_MATCH_UPDATED` event name so the realtime-server's
 * generic `room_event` handler routes them identically.
 */
export const BLACKJACK_PVP_MATCH_UPDATED = "lobby:updated";
