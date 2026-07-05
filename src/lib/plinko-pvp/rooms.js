// src/lib/plinko-pvp/rooms.js
//
// Shared Socket.IO room-id constants + a safe server-side broadcast
// helper for the Plinko Duel PvP match system. Centralised so the
// lobby page, the match view, and the server store all agree on
// room naming — a typo in only one would silently break the
// per-match live-update channel.
//
// Mirrors `src/lib/mines-pvp/rooms.js` exactly so contributions to
// either PvP feature feel familiar; we namespace the rooms with
// `plinko-pvp` so emissions don't leak across PvP features.
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Player A — lobby page: hits /api/plinko-pvp/create-or-join.
//     createOrJoin() either returns A's own existing match (no-op)
//     or the freshly-matched pair. After success, the API route
//     calls broadcastMatchUpdate(id) so that Player B (sitting on
//     /casino/plinko/[matchId] AFTER the join) sees the status
//     flip from waiting → ready without waiting for the next 1.5
//     s poll. The lobby page itself refreshes its open-lobbies
//     list via the /available polling endpoint (no socket
//     fan-out — the open-lobbies list is cheap to refetch).
//
//   In match view, both players are members of the per-match room.
//   When Player A POSTs /api/plinko-pvp/[matchId]/launch and the
//   server's launchBall fills the last gap and resolves the ball
//   (or the whole match after ball_3), the API route emits the
//   same broadcast — Player B's status poll fires inside ~50 ms
//   (socket round trip) instead of waiting for the 1.5 s poll.
//
//   Polling remains active as a safety net for cases where the
//   socket round-trip drops (mobile suspend, etc.). The polling
//   interval stays 1.5 s but the user-perceived latency for
//   opponent commits, ball resolutions, and match end drops to
//   "instant".
//
// ── The server-side broadcast helper ──────────────────────────────
//
//   The realtime-server runs in a separate Node process (see
//   realtime-server/server.js) and exposes its Socket.IO instance
//   as the local `io` constant. In the standard flow the NEXT.JS
//   API routes (which call into the server store) DO NOT have
//   direct access to `io` — in that case the helper silently
//   no-ops and the client-side polling fallback (1.5 s interval)
//   covers the latency. The helper only fires when invoked from
//   inside a process that exposes `io` on globalThis (e.g. the
//   realtime-server itself, or a future shared-process
//   deployment, or unit tests that wire one up).

/** Lobby-list refresh room. Exposed so the lobby page (task 8) can
 *  join it on mount if it wants to opt into socket-based lobby
 *  refresh; the API routes DO NOT broadcast to this room (the
 *  open-lobbies list is cheap to refetch via /available polling).
 *  Kept in the public surface for future use — matches the
 *  `MINES_PVP_LOBBY_ROOM` / `BLACKJACK_PVP_LOBBY_ROOM` shape. */
export const PLINKO_PVP_LOBBY_ROOM = "lobby:plinko-pvp";

/**
 * Per-match live-update room. Each match has its own room id so
 * emissions don't leak to other matches' open sockets.
 *
 * @param {number|string} matchId
 * @returns {string}
 */
export function plinkoPvpMatchRoom(matchId) {
  return `plinko-pvp:match:${matchId}`;
}

/**
 * Event name broadcast on the per-match room. The match view listens
 * for this and re-fetches status. Mirrors
 * `MINES_PVP_MATCH_UPDATED` / `BLACKJACK_PVP_MATCH_UPDATED` /
 * `ROULETTE_PVP_MATCH_UPDATED` (all are the same string
 * `"lobby:updated"`) so the realtime-server's generic `room_event`
 * handler routes them identically.
 */
export const PLINKO_PVP_MATCH_UPDATED = "lobby:updated";

/**
 * Broadcast a `PLINKO_PVP_MATCH_UPDATED` event to every socket
 * currently joined to the per-match room. Safe to call from
 * anywhere — silently no-ops if `globalThis.io` is not reachable
 * (the client-side polling fallback will deliver the update
 * within ~1.5 s).
 *
 * Use this from the API routes (the /launch, /create-or-join,
 * /cancel handlers) to fan out a status update immediately after
 * the server store's DB write commits, so the opponent's "your
 * turn" / "opponent launched" / "ball resolved" banner flips
 * without waiting for the poll.
 *
 * Matches the `broadcastMatchUpdate` shape in mines-pvp/rooms.js
 * exactly: per-match room only, single boolean return, `matchId`
 * and `sentAt` pre-filled on the envelope.
 *
 * @param {number|string} matchId
 * @param {object} [payload] Extra fields merged into the broadcast
 *   envelope. The realtime-server's `room_event` handler also
 *   injects `userId` (the broadcaster) and `sentAt` automatically
 *   when the broadcast originates from a client socket; this
 *   server-side helper pre-fills `matchId` and `sentAt` itself.
 * @returns {boolean} `true` if the broadcast was dispatched,
 *   `false` if no io instance was reachable (silent no-op).
 */
export function broadcastMatchUpdate(matchId, payload) {
  const io = globalThis.io;
  if (!io || typeof io.to !== "function") return false;
  const roomId = plinkoPvpMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  try {
    io.to(roomId).emit(PLINKO_PVP_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    // Never let a broadcast failure bubble up to the calling API
    // route — a missed broadcast is recoverable (polling will catch
    // up) but a 500 on /api/plinko-pvp/launch is a hard failure.
    console.warn(
      "[plinko-pvp] broadcastMatchUpdate failed:",
      err && err.message ? err.message : err,
    );
    return false;
  }
}
