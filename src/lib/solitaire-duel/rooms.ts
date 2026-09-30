// src/lib/solitaire-duel/rooms.ts
//
// The CLIENT-SAFE Socket.IO vocabulary for Solitaire Duel: room ids, event
// names and the safe server-side broadcast helper. This file imports nothing,
// so a client component can use it without pulling the store (or the seed
// machinery) into the browser bundle.
//
// Mirrors `src/lib/tic-tac-toe/rooms.ts` and `src/lib/speed-typing/rooms.ts`
// exactly: one room per match, the generic `"lobby:updated"` invalidation event
// so the realtime server's relay routes it identically, and a
// `broadcastMatchUpdate` that silently no-ops when no `io` instance is
// reachable (the split-process deployment, where a Next.js route holds no
// socket handle).
//
// ── Wiring ────────────────────────────────────────────────────────────────
//
//   Lobby → POST /api/solitaire-duel/create-or-join. When that call fills the
//   second seat, the route pushes the server's absolute GO instant, so the
//   player already sitting on /casino/solitaire-duel/[matchId] starts its
//   countdown without waiting for the next poll.
//
//   In the match view both seats join `solitaire-duel:match:<id>`. After a
//   successful MOVE the client emits the `solitaire-duel:ready` poke, so the
//   opponent refreshes in ~50 ms instead of on the next poll tick, and the
//   route additionally broadcasts the server-derived opponent-progress
//   projection.
//
//   Polling remains the backstop: the match view re-fetches the authoritative
//   GET /api/solitaire-duel/match/[id] snapshot on an interval, which is also
//   how a reconnecting client reconstructs its board.
//
// ── Trust boundary ───────────────────────────────────────────────────────
//
//   Every payload here is an invalidation hint or a server DERIVED projection.
//   The client → server direction carries only `{ matchId }`, and the
//   server → room direction never carries a board, a card identity, a progress
//   figure, a completion, a winner or an Elo/trophy value that the client
//   authored. The authoritative board only ever arrives in the snapshot.

/** Lobby-list refresh room (open Solitaire Duel lobbies). */
export const SOLITAIRE_DUEL_LOBBY_ROOM = "lobby:solitaire-duel";

/** Namespace prefix for the per-match live-update room. */
export const SOLITAIRE_DUEL_MATCH_ROOM_PREFIX = "solitaire-duel:match:";

/**
 * Per-match live-update room.
 *
 * One room per match, so an emission can never leak into another match's open
 * sockets. The match view joins exactly this room and RE-JOINS on every
 * (re)connect — Socket.IO does not restore room membership for you.
 */
export function solitaireDuelMatchRoom(matchId: string | number): string {
  return `${SOLITAIRE_DUEL_MATCH_ROOM_PREFIX}${matchId}`;
}

/**
 * Every realtime event the game uses.
 *
 * `MATCH_UPDATED` is the shared `"lobby:updated"` string every PvP game uses
 * for "something changed, refetch the snapshot". The dedicated events below are
 * the ones a client can act on without a refetch, and each carries only
 * server-derived fields.
 */
export const SOLITAIRE_DUEL_EVENTS = {
  /** Server → room: the lifecycle changed (joined / armed / resolved). Refetch. */
  MATCH_UPDATED: "lobby:updated",
  /** Client → server poke after a successful move/forfeit POST. Bare hint. */
  READY: "solitaire-duel:ready",
  /** Server → room: the absolute GO instant, so both seats count to one clock. */
  COUNTDOWN: "solitaire-duel:countdown",
  /** Server → room: the deal is open and moves are accepted. */
  MATCH_STARTED: "solitaire-duel:match-started",
  /** Server → room: one seat's authoritative progress, projected for the opponent. */
  OPPONENT_PROGRESS: "solitaire-duel:opponent-progress",
  /** Server → room: the race is resolved, with the authoritative result. */
  MATCH_FINISHED: "solitaire-duel:match-finished",
} as const;

export type SolitaireDuelEvent =
  (typeof SOLITAIRE_DUEL_EVENTS)[keyof typeof SOLITAIRE_DUEL_EVENTS];

/**
 * The closed opponent shape a client may receive mid-race.
 *
 * Counts and status only — deliberately no tableau layout, no stock or waste
 * contents, no face-down identities and no move list, so the payload is
 * insufficient to reconstruct (or copy) the opponent's board. It mirrors the
 * server's `OpponentProgress` in ./types.ts field for field; it is restated
 * here only so the client can type the socket payload without importing the
 * rules module.
 */
export type OpponentProgressEvent = {
  matchId?: string | number;
  seatKey: "player1" | "player2";
  foundationCards: number;
  revealedTableau: number;
  progressPercent: number;
  completed: boolean;
  completedAtMs: number | null;
};

/**
 * Broadcast one event to a match room.
 *
 * Safe to call from anywhere: silently no-ops and returns `false` when no `io`
 * instance is reachable and when an emission throws. A missed push is
 * recoverable from the snapshot, so a broadcast failure must never bubble into
 * the API route that called it.
 */
export function broadcastMatchEvent(
  matchId: string | number,
  event: string,
  payload: Record<string, unknown> = {},
): boolean {
  const io = (
    globalThis as {
      io?: { to?: (room: string) => { emit: (event: string, body: unknown) => void } };
    }
  ).io;
  if (!io || typeof io.to !== "function") return false;

  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(solitaireDuelMatchRoom(matchId)).emit(event, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(
      "[solitaire-duel] broadcastMatchEvent failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** The generic "something changed, refetch" push. */
export function broadcastMatchUpdate(
  matchId: string | number,
  payload: Record<string, unknown> = {},
): boolean {
  return broadcastMatchEvent(matchId, SOLITAIRE_DUEL_EVENTS.MATCH_UPDATED, payload);
}
