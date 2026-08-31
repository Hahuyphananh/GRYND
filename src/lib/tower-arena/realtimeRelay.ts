// src/lib/tower-arena/realtimeRelay.ts
//
// Fire-and-forget Socket.IO broadcasts for Tower Arena lobby events. The
// backend pushes to the shared realtime server (via its internal `/emit`
// endpoint) so waiting players get instant updates when a player joins /
// leaves / the lobby fills or starts — no polling round-trip required. The
// same internal-secret + room convention used by match-lifecycle events.
//
// The game stays server-authoritative: payloads only carry lobby metadata
// (match id, wager, player count) — never balances or payouts.

function getRealtimeUrl(): string {
  return String(
    process.env.REALTIME_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || "",
  )
    .trim()
    .replace(/\/$/, "");
}

/** Room every client in a specific Tower Arena lobby listens on. */
export function towerArenaLobbyRoom(matchId: string): string {
  return `tower-arena:lobby:${matchId}`;
}

/** Room every client in a live Tower Arena match listens on. */
export function towerArenaMatchRoom(matchId: string): string {
  return `tower-arena:match:${matchId}`;
}

/** Realtime event names the backend broadcasts to `tower-arena:match:*`. */
export const TOWER_ARENA_EVENTS = {
  STATE: "tower_arena_state",
  TURN_STARTED: "tower_arena_turn_started",
  RESOURCE_UPDATE: "tower_arena_resource_update",
  RESERVE_PHASE: "tower_arena_reserve_phase",
  BLOCK_PLACED: "tower_arena_block_placed",
  COLLAPSE: "tower_arena_collapse",
  PLAYER_ELIMINATED: "tower_arena_player_eliminated",
  RESOURCE_REFILL: "tower_arena_resource_refill",
  MATCH_FINISHED: "tower_arena_match_finished",
} as const;

/** Room the public lobby grid listens on to refresh open-lobby rows. */
export const TOWER_ARENA_LOBBIES_ROOM = "tower-arena:lobbies";

async function emit(room: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const baseUrl = getRealtimeUrl();
  if (!baseUrl) return;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.REALTIME_INTERNAL_SECRET) {
      headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
    }
    await fetch(`${baseUrl}/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ room, event, payload }),
      signal: AbortSignal.timeout(2200),
    });
  } catch (error) {
    // Best-effort only — the lobby still refreshes via its own poll fallback.
    console.warn("[tower-arena] realtime relay failed", event, error);
  }
}

/**
 * Broadcast a lobby update to the seats already in that lobby + signal the
 * public grid to refresh. Call after a create / join / leave / cancel.
 */
export async function relayTowerArenaLobbyUpdate(matchId: string, data: Record<string, unknown>): Promise<void> {
  await Promise.all([
    emit(towerArenaLobbyRoom(matchId), "tower-arena:lobby:updated", {
      matchId,
      ...data,
    }),
    emit(TOWER_ARENA_LOBBIES_ROOM, "tower-arena:lobbies:updated", {
      matchId,
      ...data,
    }),
  ]);
}

/**
 * Broadcast one in-match realtime event to every client in the match room.
 * Fire-and-forget; the client still reconciles against the authoritative
 * `get-match` snapshot on receipt. Payloads are deliberately light and hold
 * no balances / payouts / private reserve contents.
 */
export async function broadcastTowerArenaMatchEvent(
  matchId: string,
  event: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await emit(towerArenaMatchRoom(matchId), event, { matchId, ...payload });
}

// Simple, dependency-free PostHog-style event logger kept OUT of the realtime
// path — analytics is captured client-side in the lobby/match views.