// src/lib/battleship/rooms.ts
//
// Shared Socket.IO room-id + event-name vocabulary and the safe server-side
// broadcast helper for Battleship online 1v1 — the same shape as
// `src/lib/barricade/rooms.ts`, so the realtime server can relay a Battleship
// match's invalidations with the pattern it already uses for the other games.
//
// Broadcast payloads carry ONLY what a client needs to decide "should I
// refetch?" (phase, round, readiness, result). Fleets, attack selections and the
// outcome are always re-read from the authoritative snapshot — nothing here is
// a client-authoritative input.
//
// `broadcastMatchUpdate` silently no-ops when no `io` instance is reachable (the
// split-process deployment), so a missed push is recoverable and can never turn
// an accepted mutation into a 500.

/** Lobby-list refresh room (open Battleship lobbies). */
export const BATTLESHIP_LOBBY_ROOM = "lobby:battleship";

/** Namespace prefix for the per-match live-update room. */
export const BATTLESHIP_MATCH_ROOM_PREFIX = "battleship:match:";

/** Per-match live-update room, so emissions never leak across matches. */
export function battleshipMatchRoom(matchId: string | number): string {
  return `${BATTLESHIP_MATCH_ROOM_PREFIX}${matchId}`;
}

/** Same wire event as every other PvP game, so the relay routes it identically. */
export const BATTLESHIP_MATCH_UPDATED = "lobby:updated";

/** The client → server invalidation poke (carries only `{ matchId }`). */
export const BATTLESHIP_READY = "battleship:ready";

/**
 * The combat events, scoped to one match's room.
 *
 * EVERY payload is public-at-that-moment information:
 *
 *   attack_locked     — a seat locked a shot (round + WHICH SEAT, never the cell)
 *   opponent_waiting  — that seat is waiting on the other one (round only)
 *   round_resolved    — both attacks, together, after the transaction committed
 *   round_started     — the next round opened and its deadline
 *   ship_sunk         — the ship identities destroyed by this round's shots
 *   match_finished    — the outcome (draw included)
 *
 * No fleet layout, no hidden coordinate and no pending opponent cell is ever
 * carried: the client always re-reads the snapshot over its own session.
 */
export const BATTLESHIP_EVENTS = {
  ATTACK_LOCKED: "battleship:attack_locked",
  OPPONENT_WAITING: "battleship:opponent_waiting",
  ROUND_RESOLVED: "battleship:round_resolved",
  ROUND_STARTED: "battleship:round_started",
  SHIP_SUNK: "battleship:ship_sunk",
  MATCH_FINISHED: "battleship:match_finished",
  /** A deadline expired and the server chose a legal untried cell. */
  ATTACK_TIMEOUT: "battleship:attack_timeout",
  /** A missed 60 s placement deadline voided the match (nobody to award it to). */
  MATCH_CANCELLED: "battleship:match_cancelled",
} as const;

/** Emit one combat event to a match's room. Never throws, never leaks fleet data. */
export function broadcastBattleshipEvent(
  matchId: string | number,
  event: string,
  payload: Record<string, unknown> = {},
): boolean {
  const io = (
    globalThis as {
      io?: { to?: (room: string) => { emit: (name: string, body: unknown) => void } };
    }
  ).io;
  if (!io || typeof io.to !== "function") return false;

  const roomId = battleshipMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(roomId).emit(event, { matchId, ...safePayload, sentAt: new Date().toISOString() });
    return true;
  } catch (error) {
    console.warn(
      "[battleship] broadcastBattleshipEvent failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Broadcast a `lobby:updated` invalidation to the match room. Never throws. */
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

  const roomId = battleshipMatchRoom(matchId);
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(roomId).emit(BATTLESHIP_MATCH_UPDATED, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(
      "[battleship] broadcastMatchUpdate failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
