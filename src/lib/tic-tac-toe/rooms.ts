// src/lib/tic-tac-toe/rooms.ts
//
// Shared Socket.IO room-id + event-name vocabulary and the safe server-side
// broadcast helper for Tic-Tac-Toe Duel. Centralised so the match view, the API
// routes and the realtime server all agree on room naming — a typo in only one
// would silently break the per-match live-update channel.
//
// Mirrors `src/lib/mini-golf/rooms.ts` exactly: one room per match, the generic
// `"lobby:updated"` event string so the realtime server's `room_event` relay
// routes it identically, and a `broadcastMatchUpdate` that silently no-ops when
// no `io` instance is reachable.
//
// ── Wiring overview ────────────────────────────────────────────────
//
//   Lobby → /api/tic-tac-toe/create-or-join. After the caller is matched, the
//   route calls `broadcastMatchUpdate(matchId, …)` so the player already sitting
//   on /casino/tic-tac-toe/[matchId] sees waiting → playing without waiting for
//   the next poll.
//
//   In the match view both players are members of the per-match room
//   (`tic-tac-toe:match:<id>`). After a successful /move POST the client emits
//   the dedicated `tic-tac-toe:ready` poke so the opponent's refresh fires in
//   ~50 ms instead of on the next poll tick.
//
//   Polling remains the backstop: the match view re-fetches the GET
//   /api/tic-tac-toe/match/[id] snapshot on an interval, which is also the
//   state-synchronisation path after a reconnect.
//
// ── Trust boundary ────────────────────────────────────────────────
//
//   Broadcast payloads carry ONLY the fields the client needs to decide
//   "should I refetch?" (status, version, turn, ply, result). The board, the
//   winning line and every outcome are always recomputed from the authoritative
//   snapshot; nothing here is a client-authoritative input, and the client→
//   server poke carries nothing but the match id.

/** Lobby-list refresh room (open Tic-Tac-Toe lobbies). */
export const TIC_TAC_TOE_LOBBY_ROOM = "lobby:tic-tac-toe";

/** Namespace prefix for the per-match live-update room. */
export const TIC_TAC_TOE_MATCH_ROOM_PREFIX = "tic-tac-toe:match:";

/**
 * Per-match live-update room. Each match has its own room id so emissions do
 * not leak to other matches' open sockets.
 */
export function ticTacToeMatchRoom(matchId: string | number): string {
  return `${TIC_TAC_TOE_MATCH_ROOM_PREFIX}${matchId}`;
}

/**
 * Event name broadcast on the per-match room. The match view listens for this
 * and re-fetches the authoritative snapshot. Same string as every other PvP
 * game (`"lobby:updated"`) so the realtime server's generic `room_event`
 * handler routes them identically.
 */
export const TIC_TAC_TOE_MATCH_UPDATED = "lobby:updated";

/**
 * Dedicated client → server poke emitted after a successful /move or /forfeit
 * POST. It carries ONLY `{ matchId }` — a bare invalidation hint. The realtime
 * server validates that the caller is a tracked participant of that match, then
 * relays `TIC_TAC_TOE_MATCH_UPDATED` to the other seat.
 */
export const TIC_TAC_TOE_READY = "tic-tac-toe:ready";

/**
 * Broadcast a `TIC_TAC_TOE_MATCH_UPDATED` event to every socket currently
 * joined to the per-match room.
 *
 * Safe to call from anywhere — silently no-ops and returns `false` when
 * `globalThis.io` is not reachable (the standard split-process deployment, in
 * which the Next.js routes have no direct socket handle; the client polling
 * fallback covers the latency). A broadcast failure is never allowed to bubble
 * up to the calling API route: a missed push is recoverable, a 500 on /move is
 * not.
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

  const roomId = ticTacToeMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(roomId).emit(TIC_TAC_TOE_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(
      "[tic-tac-toe] broadcastMatchUpdate failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
