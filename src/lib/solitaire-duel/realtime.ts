// src/lib/solitaire-duel/realtime.ts
//
// Solitaire Duel's server-side slice of GRYND's ONE Socket.IO layer.
//
// There is no second socket server and no second websocket service. The room
// ids and the event vocabulary live in ./rooms.ts (client-safe, imports
// nothing); this module adds the opponent PROGRESSION projection and the
// throttle that keeps foundation runs from turning into a broadcast storm.
//
// ── WHAT THE SOCKET IS, AND IS NOT ─────────────────────────────────────
//
// The realtime server is TRANSPORT, never authority. The board, the stock
// order, the face-up/face-down state, the progress figure, the completion and
// the winner are all derived by `src/lib/solitaire-duel/rules.ts` and written
// under a row lock by `src/lib/solitaire-duel/serverStore.ts`. Every payload
// below is a projection of that stored state, and the client always reconciles
// against the authoritative snapshot
// (`GET /api/solitaire-duel/match/[id]`).
//
// The upstream direction is deliberately NOT a gameplay channel: a client never
// emits "I completed the puzzle" or "I am 60% done" and have it relayed. The
// only thing a client may send is a MOVE, which travels
//   client → POST /move → store (validate → apply → persist) → broadcast
// so the opponent only ever sees numbers the server derived from its own board.
//
// ── TRUST BOUNDARY ─────────────────────────────────────────────────────
//
// `opponentProgressFor` (in ./rules.ts) is the ONLY thing that builds an
// opponent payload, and it is built field by field from a server-side
// `SolitaireState` — never by spreading a seat object. There is therefore no
// code path that can leak the opponent's tableau, stock order, waste contents
// or face-down identities, and no field a client could set.

import {
  PROGRESS_BROADCAST_MIN_MS,
} from "./constants";
import { opponentProgressFor } from "./rules";
import {
  SOLITAIRE_DUEL_EVENTS,
  broadcastMatchEvent,
} from "./rooms";
import type { Seat, SolitaireState } from "./types";

// The vocabulary is shared with the client, so it is defined once in ./rooms.ts
// and re-exported here for the server callers that already import this module.
export {
  SOLITAIRE_DUEL_EVENTS,
  SOLITAIRE_DUEL_LOBBY_ROOM,
  SOLITAIRE_DUEL_MATCH_ROOM_PREFIX,
  broadcastMatchEvent,
  broadcastMatchUpdate,
  solitaireDuelMatchRoom,
} from "./rooms";
export type { OpponentProgressEvent } from "./rooms";

/**
 * The last time each match's progress was pushed to its room.
 *
 * Process-local and best-effort by design: it exists only to COALESCE a burst
 * (several foundations landing in the same second), so losing it on a restart
 * costs at most one extra emission. A client that misses an emission is never
 * left stale — every snapshot carries the authoritative numbers.
 */
const lastProgressBroadcastMs = new Map<string, number>();

/** Test seam: forget the coalescing window (so a suite can assert emissions). */
export function resetProgressBroadcastThrottle(): void {
  lastProgressBroadcastMs.clear();
}

/**
 * Push one seat's authoritative progress to the match room.
 *
 * The room holds BOTH seats, so this is the OPPONENT's live view; each client
 * renders its own progress from the snapshot and ignores the event that
 * describes its own seat. Call it only after the store ACCEPTED the move — the
 * payload is derived from the stored board, never from the request.
 *
 * Returns whether an emission happened (it may be coalesced).
 */
export function broadcastOpponentProgress({
  matchId,
  seat,
  state,
  nowMs = Date.now(),
  force = false,
}: {
  matchId: string | number;
  seat: Seat;
  state: SolitaireState | null | undefined;
  nowMs?: number;
  force?: boolean;
}): boolean {
  if (!state) return false;

  const key = String(matchId);
  const last = lastProgressBroadcastMs.get(key);
  if (!force && last != null && nowMs - last < PROGRESS_BROADCAST_MIN_MS) return false;

  const progress = opponentProgressFor(seat, state);
  const emitted = broadcastMatchEvent(
    matchId,
    SOLITAIRE_DUEL_EVENTS.OPPONENT_PROGRESS,
    progress,
  );
  lastProgressBroadcastMs.set(key, nowMs);
  return emitted;
}

/**
 * Push the authoritative RESULT to the match room.
 *
 * Sent once, when the store settles a match (a completion or a forfeit). The
 * payload is read off the settled row: it can never carry a client-supplied
 * winner, result or rating.
 */
export function broadcastMatchFinished({
  matchId,
  status,
  result,
  winnerId,
  resolutionReason,
  endedAtMs,
}: {
  matchId: string | number;
  status: unknown;
  result: unknown;
  winnerId?: unknown;
  resolutionReason?: unknown;
  endedAtMs?: number | null;
}): boolean {
  return broadcastMatchEvent(matchId, SOLITAIRE_DUEL_EVENTS.MATCH_FINISHED, {
    status,
    result: result ?? null,
    winnerId: winnerId ?? null,
    resolutionReason: resolutionReason ?? null,
    endedAtMs: endedAtMs ?? null,
  });
}
