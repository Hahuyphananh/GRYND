// src/lib/speed-typing/realtime.ts
//
// Speed Typing's slice of GRYND's ONE Socket.IO layer — the SERVER-side half.
//
// There is no second socket server and no second websocket service: the room id
// and event vocabulary live in ./rooms.ts (client-safe, imports nothing), and
// this module adds the safe broadcast/relay helpers and the opponent projection.
// Mirrors `src/lib/mini-golf/rooms.ts` and
// `src/lib/tower-arena/realtimeRelay.ts` deliberately — a typo in a room name in
// only one of them would silently break the live channel.
//
// ── WHAT THE SOCKET IS, AND IS NOT ──────────────────────────────────────
//
// The Render-hosted realtime server is TRANSPORT. It is not the authority.
// Authoritative state lives in Postgres, derived by `src/lib/speed-typing/rules.ts`
// and written under a row lock by `src/lib/speed-typing/serverStore.ts`. Every
// payload here is a PROJECTION of that state, and the client always reconciles
// against the authoritative snapshot (`GET /api/speed-typing/match/[id]`).
//
// The upstream direction is deliberately NOT a progress channel: a client never
// emits "I am 60% done" and have it relayed. Progress travels
//   client → POST checkpoint → store (verify + throttle + persist) → broadcast
// so the opponent only ever sees numbers the SERVER derived from the canonical
// prompt. High-frequency keystrokes never reach the socket at all: they stay in
// the client's own render, and the store's throttle collapses the checkpoint
// stream into a handful of writes per race.
//
// ── TRUST BOUNDARY ──────────────────────────────────────────────────────
//
// `opponentProgressFor` is the ONLY thing that builds an opponent payload, and
// it is built field by field — never by spreading a seat object and deleting
// keys. There is therefore no code path that can leak the opponent's RAW TYPED
// TEXT, and no field a client could set. The prompt TEXT is delivered to a
// participant by the authoritative snapshot, not by this module. Nothing here is
// a game decision input.

import type { SeatKey } from "./constants";
import { emptySeatRace, raceMetrics, type SeatRace } from "./rules";
import { SPEED_TYPING_EVENTS, speedTypingMatchRoom } from "./rooms";
import type { OpponentProgress } from "./rooms";

// The vocabulary is shared with the client, so it is defined once in ./rooms.ts
// and re-exported here for the server callers that already import this module.
export {
  SPEED_TYPING_EVENTS,
  SPEED_TYPING_LOBBY_ROOM,
  SPEED_TYPING_MATCH_ROOM_PREFIX,
  speedTypingMatchRoom,
} from "./rooms";
export type { OpponentProgress, SpeedTypingEvent } from "./rooms";

/** Clamp to a plain integer inside `[0, max]`. */
function clampInt(value: unknown, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.floor(n));
}

/**
 * Project one authoritative seat into the opponent-facing payload.
 *
 * Pure and field-by-field by construction — this is the single place an
 * opponent-visible progress object is created, so "no raw typed text" is a
 * property of the function rather than a rule someone has to remember.
 *
 * `progressPercent` uses the verified CURSOR position (how far into the prompt
 * the seat has reached), not the correct-character count: a progress bar that
 * moves backwards when a player fixes a typo would read as a bug. Accuracy
 * travels alongside it, so a seat mashing keys is visibly at 100% of the text
 * with terrible accuracy rather than looking like it is winning.
 */
export function opponentProgressFor({
  seatKey,
  seat,
  promptLength,
  nowMs,
  goAtMs,
}: {
  seatKey: SeatKey;
  seat: SeatRace | null | undefined;
  promptLength: unknown;
  nowMs: number;
  goAtMs: number | null;
}): OpponentProgress {
  const resolvedSeat = seat ?? emptySeatRace();
  const length = clampInt(promptLength, Number.MAX_SAFE_INTEGER);
  const reached = clampInt(resolvedSeat.charsTyped, Number.MAX_SAFE_INTEGER);
  const progressPercent = length > 0 ? Math.min(100, Math.round((reached / length) * 100)) : 0;
  const metrics = raceMetrics({ seat: resolvedSeat, goAtMs, nowMs });

  return {
    seatKey,
    progressPercent,
    completed: resolvedSeat.finished === true,
    wpm: metrics.wpm,
    accuracy: metrics.accuracy,
  };
}

/** The `io` shape this module needs — a subset of the Socket.IO server. */
type RoomEmitter = {
  io?: { to?: (room: string) => { emit: (event: string, payload: unknown) => void } };
};

/**
 * Broadcast one event to a match room.
 *
 * Safe to call from anywhere: silently no-ops and returns `false` when no `io`
 * instance is reachable (the standard split-process deployment, where the
 * Next.js routes have no direct socket handle) and when an emission throws. A
 * missed push is recoverable — the client's poll/snapshot backstop covers it —
 * so a broadcast failure must never bubble into the API route that called it.
 */
export function broadcastMatchEvent(
  matchId: string | number,
  event: string,
  payload: Record<string, unknown> = {},
): boolean {
  const io = (globalThis as RoomEmitter).io;
  if (!io || typeof io.to !== "function") return false;
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  try {
    io.to(speedTypingMatchRoom(matchId)).emit(event, {
      matchId,
      ...safePayload,
      sentAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(
      "[speed-typing] broadcastMatchEvent failed:",
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
  return broadcastMatchEvent(matchId, SPEED_TYPING_EVENTS.MATCH_UPDATED, payload);
}

/**
 * Push one seat's authoritative progress to the match room.
 *
 * The room contains both seats, so this is the OPPONENT's live view; a client
 * renders its own progress locally and ignores the event for its own seat. Call
 * it only after the store accepted a checkpoint — the payload is derived from
 * the stored seat state, never from the request.
 */
export function broadcastOpponentProgress({
  matchId,
  seatKey,
  seat,
  promptLength,
  nowMs,
  goAtMs,
}: {
  matchId: string | number;
  seatKey: SeatKey;
  seat: SeatRace | null | undefined;
  promptLength: unknown;
  nowMs: number;
  goAtMs: number | null;
}): boolean {
  return broadcastMatchEvent(
    matchId,
    SPEED_TYPING_EVENTS.OPPONENT_PROGRESS,
    opponentProgressFor({ seatKey, seat, promptLength, nowMs, goAtMs }),
  );
}

/** The backend→realtime base URL, or "" when the deployment has none. */
function realtimeUrl(): string {
  return String(process.env.REALTIME_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || "")
    .trim()
    .replace(/\/$/, "");
}

/**
 * Push a match event to the realtime server's internal `/emit` endpoint.
 *
 * The in-process `globalThis.io` path above is what the bundled deployments use;
 * this is the split-process path (a Vercel route cannot hold the Render socket
 * handle). Fire-and-forget by design: a relay failure is recoverable from the
 * snapshot, so it must never fail the calling request.
 */
export async function relayMatchEvent(
  matchId: string | number,
  event: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const baseUrl = realtimeUrl();
  if (!baseUrl) return false;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.REALTIME_INTERNAL_SECRET) {
      headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
    }
    await fetch(`${baseUrl}/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        room: speedTypingMatchRoom(matchId),
        event,
        payload: { matchId, ...payload },
      }),
      signal: AbortSignal.timeout(2_200),
    });
    return true;
  } catch (error) {
    console.warn(
      "[speed-typing] relayMatchEvent failed",
      event,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
