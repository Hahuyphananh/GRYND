// src/lib/dominoes/rooms.ts
//
// Shared Socket.IO room-id + event-name vocabulary and the safe server-side
// broadcast helper for online Dominoes.
//
// Mirrors src/lib/barricade/rooms.ts and src/lib/tic-tac-toe/rooms.ts exactly:
// one room per match, the generic `"lobby:updated"` event string so the
// realtime server's `room_event` relay routes it identically, and a
// `broadcastMatchUpdate` that silently no-ops when no `io` instance is
// reachable (the standard split-process deployment, where Render hosts the
// relay and Vercel owns the state).
//
// ── TRUST BOUNDARY ────────────────────────────────────────────────────────
//
// A broadcast payload is an INVALIDATION HINT, never a snapshot: it carries
// the match id, the status, the version and the public result so a client can
// decide whether to refetch. It must never carry a hand, a tile count or the
// draw pile — the authoritative, viewer-projected snapshot is re-read over
// HTTP, and that is the only thing a board renders.
//
// This module imports nothing (no DB, no React) so the client bundle can use
// the same strings the server emits.

/** Lobby-list refresh room (open Dominoes lobbies). */
export const DOMINOES_LOBBY_ROOM = "lobby:dominoes";

/** Namespace prefix for the per-match live-update room. */
export const DOMINOES_MATCH_ROOM_PREFIX = "dominoes:match:";

/**
 * Per-match live-update room. Each match has its own room id so emissions do
 * not leak to other matches' open sockets.
 */
export function dominoesMatchRoom(matchId: string | number): string {
  return `${DOMINOES_MATCH_ROOM_PREFIX}${matchId}`;
}

/**
 * Event name broadcast on the per-match room. The match view listens for this
 * and re-reads the authoritative snapshot. Same string as every other PvP game
 * (`"lobby:updated"`) so the realtime server's generic handler routes them
 * identically.
 */
export const DOMINOES_MATCH_UPDATED = "lobby:updated";

/**
 * Dedicated client → server poke emitted after a successful action, forfeit,
 * cancel or clock resolution. It carries ONLY `{ matchId }` — a bare
 * invalidation hint. The realtime server checks that the caller is a tracked
 * participant of that match, then relays `DOMINOES_MATCH_UPDATED` to the other
 * seat.
 */
export const DOMINOES_READY = "dominoes:ready";

/**
 * Broadcast a `DOMINOES_MATCH_UPDATED` event to every socket currently joined
 * to the per-match room.
 *
 * Safe to call from anywhere — silently no-ops and returns `false` when
 * `globalThis.io` is not reachable. A broadcast failure is never allowed to
 * bubble up into the calling API route: a missed push is recoverable, a 500 on
 * an accepted action is not.
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

  const roomId = dominoesMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(roomId).emit(DOMINOES_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(
      "[dominoes] broadcastMatchUpdate failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
