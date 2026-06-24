// ── Multiplayer wiring for the Precision PvP casino game ────────────────
//
// This file is the bridge between the React UI and the two transport
// layers we already use across the project:
//   1. REST API routes under /api/precision/* (mirrors /api/pool/*)
//   2. The realtime SocketProvider (see src/context/SocketProvider.tsx)
//
// No gameplay logic lives here — these helpers only set up channels and
// deliver opaque payloads. Real game-engine logic should live in a future
// `src/lib/precision/engine.ts` that the match page consumes.

import type { RealtimeSocket } from "../socket";
import { API_ROUTES, SOCKET_NAMESPACE } from "./constants";
import type {
  PrecisionLobby,
  PrecisionMatchSummary,
  PrecisionPlayer,
  PrecisionRoundStopResponse,
  PrecisionState,
} from "./types";

// ── REST helpers ─────────────────────────────────────────────────────────

export interface CreateLobbyRequest {
  wager: number;
  /** Precision is PvP-only — solo practice lives at
   *  `/casino/precision/test`, not here. The field is kept on the wire
   *  for backwards-compat with any persisted request payloads, but
   *  the route ignores anything other than `"pvp"`. */
  gameMode: "pvp";
}

export interface CreateLobbyResponse {
  success: boolean;
  /** Unified id used by the client to navigate to the game page. Equal to
   *  `lobbyId` for waiting entries and to `matchId` for matched entries
   *  (when matchmaking pairs two players, the lobby id becomes the match
   *  id so both clients land on the same URL). */
  gameId: string | null;
  /** Set when the response represents a queued / waiting entry. */
  lobbyId: string | null;
  /** Set when the response represents an auto-matched PvP match. */
  matchId: string | null;
  /** Lifecycle status of the newly created entity. */
  status?: "waiting" | "matched";
  opponent?: { userId: string; name: string; seat: 1 | 2 };
  error?: string;
}

export async function createLobby(
  payload: CreateLobbyRequest,
): Promise<CreateLobbyResponse> {
  const res = await fetch(API_ROUTES.createLobby, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function joinLobby(
  lobbyId: string,
): Promise<{ success: boolean; matchId?: string; error?: string }> {
  const res = await fetch(API_ROUTES.joinLobby, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lobbyId }),
  });
  return res.json();
}

export async function listLobbies(): Promise<PrecisionLobby[]> {
  const res = await fetch(API_ROUTES.lobbies, { cache: "no-store" });
  const data = await res.json();
  return Array.isArray(data.lobbies) ? data.lobbies : [];
}

export async function getMatch(
  matchId: string,
): Promise<{ match: PrecisionState | null }> {
  const res = await fetch(
    `${API_ROUTES.getMatch}?matchId=${encodeURIComponent(matchId)}`,
    { cache: "no-store" },
  );
  return res.json();
}

export async function pushState(
  matchId: string,
  state: PrecisionState,
): Promise<void> {
  // Fire-and-forget — same posture as `pushPoolState`.
  fetch(API_ROUTES.updateState, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, state }),
  }).catch(() => {});
}

export async function resignMatch(
  matchId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(API_ROUTES.resign, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId }),
  });
  return res.json();
}

export interface MarkReadyResponse {
  success: boolean;
  ready?: boolean;
  bothReady?: boolean;
  alreadyAdvanced?: boolean;
  phase?: string;
  match?: PrecisionState;
  error?: string;
}

/**
 * POST `/api/precision/ready` — atomically mark a player as Ready in a
 * `ready_up` match. See `markPlayerReady` in `src/lib/precision/serverStore.ts`
 * for the underlying logic.
 */
export async function markReady(
  matchId: string,
  userId: string,
): Promise<MarkReadyResponse> {
  const res = await fetch(API_ROUTES.ready, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, userId }),
  });
  return res.json();
}

/**
 * POST `/api/precision/round-stop` — submit a single player's STOP
 * signal for the current round. The body intentionally carries ONLY
 * `{ matchId, userId }`. The server stamps the STOP instant at receive
 * time, computes elapsed as `stopInstant - match.roundGoInstant`, and
 * independently decides the round winner after BOTH seats have
 * submitted. The client CANNOT supply `stopMs` (or any earlier-locked
 * client-side timing input). The route ignores any numeric field a
 * tampered client adds to the body.
 *
 * NOTE: This REST helper is kept for backwards compatibility with any
 * outbound caller that still POSTs through Next.js without a socket,
 * but the in-app match page no longer calls it — it emits via
 * `emitStop(socket, matchId, onAck)` over the realtime socket (which
 * proxies to the same route).
 */
export async function recordRoundStop(
  matchId: string,
  userId: string,
  roundId: string,
  nonce: string,
): Promise<PrecisionRoundStopResponse> {
  const res = await fetch(API_ROUTES.roundStop, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, userId, roundId, nonce }),
  });
  return res.json();
}

/** Shape of the `/api/precision/finish-match` response. The endpoint
 *  is idempotent — repeating the call for an already-paid-out match
 *  returns `alreadyProcessed: true` with the original payout data
 *  so the page can re-sync after a polling blip or reload. */
export interface FinishMatchResponse {
  success: boolean;
  alreadyProcessed?: boolean;
  payout?: number;
  newBalance?: number;
  finalScore?: { seat1: number; seat2: number } | null;
  winnerUserId?: string | null;
  winnerSeat?: 1 | 2 | null;
  localSeat?: 1 | 2 | null;
  didLocalWin?: boolean;
  payoutMultiplier?: number;
  error?: string;
}

/**
 * POST `/api/precision/finish-match` — triggers the server-authoritative
 * payout when a Precision match is finished. The page fires this
 * exactly once per page load when it observes `state.phase === "finished"`
 * + `state.winnerSeat !== null`. The server-side helper
 * `processMatchFinishedPayout` in
 * `src/lib/precision/finishMatch.ts` is the only caller of the
 * balance update + leaderboard helper; this client-side wrapper just
 * surfaces the response so the page can render the Winner / Score /
 * Prize rows.
 */
export async function fetchFinishMatch(
  matchId: string,
): Promise<FinishMatchResponse> {
  const res = await fetch(API_ROUTES.finishMatch, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId }),
  });
  return res.json();
}

// ── Socket helpers ───────────────────────────────────────────────────────
//
// The realtime server already supports the generic `join_room`,
// `leave_room`, and `room_event` channels (see realtime-server/server.js).
// We wrap those into named helpers so individual pages don't have to know
// the namespacing.

export function joinLobbyRoom(socket: RealtimeSocket, lobbyId: string): void {
  socket.emit("join_room", { roomId: SOCKET_NAMESPACE.lobbyListRoom(lobbyId) });
}

export function leaveLobbyRoom(socket: RealtimeSocket, lobbyId: string): void {
  socket.emit("leave_room", { roomId: SOCKET_NAMESPACE.lobbyListRoom(lobbyId) });
}

export function joinMatchRoom(socket: RealtimeSocket, matchId: string): void {
  socket.emit("join_room", { roomId: SOCKET_NAMESPACE.matchRoom(matchId) });
}

export function leaveMatchRoom(socket: RealtimeSocket, matchId: string): void {
  socket.emit("leave_room", { roomId: SOCKET_NAMESPACE.matchRoom(matchId) });
}

export function joinEndReplayRoom(socket: RealtimeSocket, matchId: string): void {
  socket.emit("join_room", { roomId: SOCKET_NAMESPACE.endReplayRoom(matchId) });
}

export function leaveEndReplayRoom(socket: RealtimeSocket, matchId: string): void {
  socket.emit("leave_room", { roomId: SOCKET_NAMESPACE.endReplayRoom(matchId) });
}

export function emitLobbyListUpdate(socket: RealtimeSocket | null | undefined): void {
  // Null-safe: callers don't have to guard against an unhydrated socket.
  if (!socket) return;
  // Notifies all peers of the public lobby list that something changed.
  socket.emit("room_event", {
    roomId: "lobby:precision",
    event: SOCKET_NAMESPACE.lobbyUpdateEvent,
  });
}

export function emitEndReplayRequest(socket: RealtimeSocket, matchId: string) {
  socket.emit("room_event", {
    roomId: SOCKET_NAMESPACE.endReplayRoom(matchId),
    event: SOCKET_NAMESPACE.endReplayRequestEvent,
    payload: { matchId },
  });
}

export function emitEndReturn(socket: RealtimeSocket, matchId: string) {
  socket.emit("room_event", {
    roomId: SOCKET_NAMESPACE.endReplayRoom(matchId),
    event: SOCKET_NAMESPACE.endReturnEvent,
    payload: { matchId },
  });
}

/** Server-to-caller Socket.IO ACK callback payload shape. The realtime
 *  server's `precision:stop` handler invokes the callback once it has
 *  either successfully proxied the stop to Next.js OR a domain validation
 *  failure caused it to refuse the stop (e.g. user not a participant,
 *  internal fetch error). */
export interface PrecisionStopAck {
  success: boolean;
  error?: string;
}

/** Maximum time we'll wait for the realtime-server's ACK callback before
 *  surfacing a network-timeout error to the caller. Mirrors the
 *  AbortController timeout that the realtime-server's Next.js proxy
 *  uses internally — both client and server must agree on the same
 *  bound so the player UI doesn't strand `stopSubmitting=true` on a
 *  half-broken connection. */
export const STOP_ACK_TIMEOUT_MS = 4000;

/**
 * Fire the per-player reaction-time stop event over the realtime socket.
 * The client sends ONLY a `{ matchId }` payload — no stopMs. The
 * realtime server validates participation and HTTP-proxies the call to
 * the Next.js `/api/precision/round-stop` route, where the canonical
 * `recordRoundStop` server-stamps the STOP instant and computes elapsed
 * time authoritatively. The matching round-result broadcast lands back
 * in the precision match room (only after BOTH seats have submitted)
 * and the existing `roundResultEvent` listener updates the page state.
 *
 * Single-click enforcement lives on the page (see handleStopClick +
 * stopLockedThisRoundRef), so this helper trusts the caller.
 *
 * ── Audit fix: bounded ACK wait via Socket.IO `socket.timeout()` ──
 * Without `.timeout(STOP_ACK_TIMEOUT_MS)`, a network blip that drops
 * the ACK could strand the page's `stopSubmitting=true` flag forever
 * (the existing client-side handler is gated on the ACK callback ever
 * firing). The timeout wrapper forwards the `err` slot as an
 * `{ success: false, error: ... }` payload so the page's existing
 * handleStopClick ACK handling can flip the button back to enabled.
 * Matches the realtime-server-side `AbortController` (also 4s) so the
 * client and server sides agree on the same bound.
 */
export function emitStop(
  socket: RealtimeSocket,
  matchId: string,
  roundId: string,
  nonce: string,
  onAck?: (ack: PrecisionStopAck) => void,
): void {
  if (onAck) {
    socket.timeout(STOP_ACK_TIMEOUT_MS).emit(
      SOCKET_NAMESPACE.stopEvent,
      { matchId, roundId, nonce },
      (err: Error | null, ack?: PrecisionStopAck) => {
        if (err) {
          onAck({
            success: false,
            error:
              "Network timeout \\u2014 server didn't ACK within " +
              String(STOP_ACK_TIMEOUT_MS) +
              "ms. Please try again.",
          });
          return;
        }
        onAck(ack ?? { success: false, error: "Empty ACK from server." });
      },
    );
    return;
  }
  socket.emit(SOCKET_NAMESPACE.stopEvent, { matchId, roundId, nonce });
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function opponentOf(
  player: PrecisionPlayer,
  players: PrecisionPlayer[],
): PrecisionPlayer | null {
  return players.find((p) => p.seat !== player.seat) ?? null;
}

export function isLocalPlayerTurn(
  state: PrecisionState,
  localSeat: 1 | 2,
): boolean {
  return state.phase === "active" && state.turn === localSeat;
}

export function buildMatchSummary(
  state: PrecisionState,
  summary: Partial<PrecisionMatchSummary> & { result: "win" | "loss" | "draw"; reason: PrecisionMatchSummary["reason"] },
): PrecisionMatchSummary {
  return {
    matchId: state.matchId,
    phase: state.phase,
    winnerSeat: summary.winnerSeat ?? null,
    result: summary.result,
    reason: summary.reason,
    wager: state.wager,
    payout: summary.payout ?? 0,
    endedAt: summary.endedAt ?? Date.now(),
    finalScore: summary.finalScore,
  };
}
