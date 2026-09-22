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
  /** Display name for the host seat, resolved from the signed-in Clerk
   *  user. Display only — the route takes the host's IDENTITY from the
   *  session, never from this payload. */
  hostName?: string;
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
  /** Display name for the joining seat (seat 2). Display only — the route
   *  takes the joiner's IDENTITY from the Clerk session. */
  playerName?: string,
): Promise<{ success: boolean; matchId?: string; error?: string }> {
  const res = await fetch(API_ROUTES.joinLobby, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lobbyId, playerName }),
  });
  return res.json();
}

/**
 * POST `/api/precision/leave` — tell the server this player is done with a
 * Precision game id: a waiting lobby they host is cancelled, a practice
 * (vs AI) match is removed, and a live PvP match is forfeited to the
 * opponent. Fire-and-forget from the match page's exit paths; the endpoint
 * is idempotent, so a retry or a double-fire (button + `sendBeacon` on
 * unload) is harmless.
 */
export async function leaveGame(
  matchId: string,
): Promise<{ success: boolean; action?: string; error?: string }> {
  const res = await fetch(API_ROUTES.leave, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ matchId }),
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

/** Maximum time we'll wait for the realtime-server's ACK callback before we
 *  stop trusting the socket and re-submit the stop over HTTPS.
 *
 *  Deliberately LONGER than the realtime-server's own 4s forward bound
 *  (`realtime-server/server.js` → `precision:stop`): the proxy always answers
 *  with its own `{ success: false, error }` when Next.js doesn't reply in
 *  time, and that verdict is more useful than giving up first. When the full
 *  window passes with no ACK at all, the SOCKET is what failed — see the
 *  HTTPS fallback in `emitStop`. */
export const STOP_ACK_TIMEOUT_MS = 6000;

/** Bound on the HTTPS fallback so a STOP can never hang the button. */
export const STOP_HTTP_TIMEOUT_MS = 8000;

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
 *
 * ── Bug fix: a missing ACK re-submits over HTTPS ──
 * "Network timeout — server didn't ACK within 4000ms. Please try again."
 * was the wrong answer for a stop that never made it: `socket.timeout()`
 * only proves the SOCKET answered, not that the stop reached the server.
 * Socket.IO buffers emits while the transport is down and replays them on
 * reconnect, so a blip at the wrong instant produced (a) this error and
 * (b) the same packet landing much later — graded against an elapsed time
 * that has nothing to do with the click, or refused outright. Either way
 * the round was lost for a click the player actually made.
 *
 * So an ACK timeout now re-submits the SAME stop (same `roundId` +
 * `nonce`, so the replay envelope still validates) over HTTPS via
 * `submitStopOverHttp`, which needs no socket. That is safe because the
 * server keeps one stop per seat per round: a stop already recorded comes
 * back as `alreadySubmitted`, which we report to the caller as success.
 *
 * An explicit refusal from the realtime server (`err === null`,
 * `success: false`) is authoritative and is NOT retried — that covers a
 * stale roundId/nonce, a duplicate, a non-participant caller, and the
 * proxy's own timeout, where re-submitting behind the player's back could
 * only produce a confusing second verdict.
 */
/**
 * The elapsed the local client froze at when STOP was clicked, rounded to a
 * whole millisecond and dropped when unusable. This is the ONLY timing value
 * the client ever reports, and the server treats it as a bounded hint (see
 * `resolveStopElapsedMs`): it can cancel the delivery lag between the click
 * and the packet landing, and nothing else.
 */
export function stopElapsedHint(elapsedMs?: number | null): number | null {
  // `null`/`undefined` mean "there is no frozen elapsed to report" — an explicit
  // absence, never a stop at 0ms. (`Number(null)` is 0, so the numeric
  // coercion below alone shipped a bogus `elapsedMs: 0` for every caller that
  // passed null to say "none".)
  if (elapsedMs === null || elapsedMs === undefined) return null;
  const value = Number(elapsedMs);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

export function emitStop(
  socket: RealtimeSocket,
  matchId: string,
  roundId: string,
  nonce: string,
  elapsedMs?: number | null,
  onAck?: (ack: PrecisionStopAck) => void,
): void {
  const hint = stopElapsedHint(elapsedMs);
  const packet =
    hint === null ? { matchId, roundId, nonce } : { matchId, roundId, nonce, elapsedMs: hint };
  if (!onAck) {
    socket.emit(SOCKET_NAMESPACE.stopEvent, packet);
    return;
  }

  socket.timeout(STOP_ACK_TIMEOUT_MS).emit(
    SOCKET_NAMESPACE.stopEvent,
    packet,
    (err: Error | null, ack?: PrecisionStopAck) => {
      if (!err) {
        onAck(ack ?? { success: false, error: "Empty ACK from server." });
        return;
      }
      // No ACK at all — the socket, not the request, failed. Re-submit over
      // HTTPS so the click is never silently thrown away mid-round.
      void submitStopOverHttp(matchId, roundId, nonce, hint)
        .then((result) => {
          if (result?.success === true || result?.alreadySubmitted === true) {
            onAck({ success: true });
            return;
          }
          onAck({
            success: false,
            error:
              result?.error ||
              "Network timeout — the server did not confirm your stop within " +
                String(STOP_ACK_TIMEOUT_MS) +
                "ms. Please try again.",
          });
        })
        .catch(() => {
          onAck({
            success: false,
            error:
              "Network timeout — server didn't ACK within " +
              String(STOP_ACK_TIMEOUT_MS) +
              "ms, and the backup request failed. Please try again.",
          });
        });
    },
  );
}

/**
 * Re-submit a stop straight to `/api/precision/round-stop` — no socket in the
 * path. Used by `emitStop` when the realtime ACK never arrives, and available
 * to any caller that has to stop a round without a live socket.
 *
 * The caller is authenticated by the Clerk session cookie (the route derives
 * the userId itself and ignores any id in the body), so this is the same
 * server-authoritative `recordRoundStop` path the socket proxy uses — just a
 * different transport. The replay envelope (`roundId` + `nonce`) is passed
 * through untouched, so a stop that races the socket packet is rejected as a
 * duplicate rather than double-counted. The frozen elapsed rides along as the
 * same bounded hint the socket packet carries.
 */
export async function submitStopOverHttp(
  matchId: string,
  roundId: string,
  nonce: string,
  elapsedMs?: number | null,
): Promise<PrecisionRoundStopResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOP_HTTP_TIMEOUT_MS);
  const hint = stopElapsedHint(elapsedMs);
  try {
    const res = await fetch(API_ROUTES.roundStop, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(
        hint === null ? { matchId, roundId, nonce } : { matchId, roundId, nonce, elapsedMs: hint },
      ),
      signal: controller.signal,
    });
    return (await res.json()) as PrecisionRoundStopResponse;
  } finally {
    clearTimeout(timer);
  }
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
