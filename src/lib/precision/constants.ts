// ── Shared constants for the Precision PvP casino game ──────────────────
//
// Visual / gameplay-shape constants live here so that pages and components
// stay in sync. Real numerical tuning should happen in the eventual
// `engine.ts` (gameplay) — this file is the API surface.

export const GAME_KEY = "precision" as const;

// Default wager options shown on the lobby page. Multipliers of 10 in the
// same vein as Pool / Uno lobby presets.
export const DEFAULT_WAGER_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_WAGER = 10;

// Wager bounds — used by both the lobby input validation and the API
// guard rails. Single source of truth.
export const MIN_WAGER = 1;
export const MAX_WAGER = 1000;

// Number of seats in a Precision match. The gameplay is strictly 1v1 for
// now (no variant other than 2 players). Surfaced as a constant so the
// waiting-room / seat UI isn't littered with magic numbers.
export const SEAT_COUNT = 2;

// Match lifecycle timings. These mirror Unity-style pooling and timeouts
// used by Pool / Hex Duel implementations.
export const LOBBY_POLL_INTERVAL_MS = 1200;
export const LOBBY_LIST_POLL_INTERVAL_MS = 3000;
// The realtime server pushes round-arm/round-result/match-finished
// events to the match room, so this HTTP poll is a reconcile/safety net
// rather than the primary sync path. Held at 2s (kept tighter than other
// games because precision's STOP timing is sensitive) to cut match-time
// status reads ~25% vs. the old 1500ms.
export const MATCH_POLL_INTERVAL_MS = 2000;

// Fast re-poll cadence used ONLY for the moment the pre-round countdown
// expires. The server flips `arming` → `active` at `countdownEndsAt`, but
// the client otherwise learns about it on the next `MATCH_POLL_INTERVAL_MS`
// tick (or a `precision:roundArmStart` broadcast, which is emitted when the
// NEXT round is armed — not when it opens). That left the countdown parked
// on 0 (previously 1) for up to two seconds every single round — reported as
// "the timer gets stuck on 0". While the stamped countdown has elapsed we
// re-poll at this cadence, so the round + its target open within ~250ms of
// the countdown hitting zero. `ARMING_FAST_POLL_MAX_ATTEMPTS` bounds the
// burst (a stalled/exhausted match falls back to the normal cadence rather
// than hammering the route forever).
export const ARMING_FAST_POLL_INTERVAL_MS = 250;
export const ARMING_FAST_POLL_MAX_ATTEMPTS = 12;

// Lobby TTL — after this a lobby is auto-pruned (server-side). Mirrors the
// 5 minute TTL used for Pool lobbies.
export const LOBBY_TTL_MS = 5 * 60 * 1000;

// Finished-match TTL — after this a TERMINAL match row is auto-pruned
// (server-side, by `sweepPrecisionGames`). Without this finished rows would
// accumulate forever. Set high enough that the end-replay window (RESULT_POPUP_
// REPLAY_WINDOW_MS = 15s) plus a 60s grace period fits comfortably.
export const MATCH_FINISHED_TTL_MS = 60 * 60 * 1000;

// Abandoned-match TTL — after this an UNFINISHED match with no activity is
// torn down server-side. A player who quits mid-match (closes the tab, taps
// "Lobby" on a live round, or abandons a `ready_up` match neither seat ever
// readies) can leave the row unfinished forever: the finish-based sweep above
// never sees it because `phase` never becomes "finished".
//
// The common exits are handled immediately (`/api/precision/leave`, the
// disconnect grace timer's forfeit, and the practice-match removal), so this
// sweep is pure storage hygiene — a stranded row can no longer mis-route
// anyone, because a paired id is never handed out again (the lobby it came
// from is `active`, and any id that already has a match row is refused by
// `/api/precision/join-lobby`). The window is therefore generous: long enough
// that a LIVE match — even one sitting in `ready_up` while the opponent takes
// their time — is never pruned underneath the players.
export const MATCH_ABANDONED_TTL_MS = 6 * 60 * 60 * 1000;

// End-popup replay window. Mirrors the 15 second window used by Uno's
// `endPopup` flow so the user experience feels consistent.
export const RESULT_POPUP_REPLAY_WINDOW_MS = 15_000;

// ── Best-of-5 win condition ─────────────────────────────────────────────
//
// First player to win TARGET_WINS rounds ends the match. Score lives on
// `PrecisionState.score` and is server-authoritative; the client MUST
// treat it as read-only. See `recordRoundStop` in `serverStore.ts`.
export const TARGET_WINS = 3;
export const MAX_ROUNDS = 5;

// ── Random per-round target ──────────────────────────────────────────────
//
// The server rolls a fresh target in [MIN_TARGET_MS, MAX_TARGET_MS] for
// EVERY round (inclusive on both ends, millisecond precision — examples:
// 3821, 6158, 9475). The target is stored in the SERVER-ONLY
// `precision_matches.server_target_ms` column and is NEVER exposed on
// `PrecisionState.targetMs` during the `arming` phase. The arm→active
// reveal is the moment the target is copied onto the public state, so both
// polling clients see the same revealed value at the same time. See
// `armRound` / `applyDueTransitions` in `serverStore.ts`.
export const MIN_TARGET_MS = 2_500;
export const MAX_TARGET_MS = 10_000;

/** Backend placeholder kept for back-compat: matchmaking / get-match used
 *  to publish a single fixed target on the match state. Now that the
 *  server stores the rolled target on a private map, the PUBLIC state
 *  field is `null` until the round starts. Renamed to make it clear this
 *  constant is ONLY the placeholder default the player-input field
 *  shows in the active UI before the user picks a value. */
export const PLAYER_STOP_INPUT_DEFAULT_MS = 5_000;

// Round stop time bounds — the API rejects submissions outside this range
// so a misbehaving client can't (e.g.) submit 0ms or 30 seconds.
export const MIN_STOP_MS = 50;
export const MAX_STOP_MS = 60_000;

// ── Anomaly-detection thresholds ─────────────────────────────────────────
//
// All four numbers below define the soft signal that fires `console.warn`
// lines from `anomalyDetection.ts` whenever a player's stop packet looks
// suspicious. The MIN_STOP_MS hard-reject ABOVE is the canonical gating
// point; everything below is observational / audit-only.
//
// `PRECISION_IMPOSSIBLE_REACTION_MS` is intentionally STRICTER than
// MIN_STOP_MS: 80ms is below the threshold for casual human reaction
// (signal-propagation + processing time) regardless of prior knowledge
// of the target. MIN_STOP_MS=50 only stops packets that are programmatically
// generated / below-machine-noise; 50–80ms represents a domain where a
// pre-cog or tampering device could plausibly land, so we log but do not
// reject.
//
// Variance thresholds are coefficient-of-variation (CV = stddev / mean):
//   - LOW_VARIANCE_CV = 0.01  → robotic consistency (signal-bot)
//   - HIGH_VARIANCE_CV = 0.8  → wildly inconsistent (multi-input juggling)
// `VARIANCE_MIN_SAMPLES = 3` requires at least three samples to compute
// variance — a per-match Precision game can only resolve up to MAX_ROUNDS
// (5) rounds, so we need to be lenient about minimum samples or the flag
// will never fire on tiny matches.
//
// These constants are intentionally tunable — see the related server logs
// in `anomalyDetection.ts` for the structures.
export const PRECISION_IMPOSSIBLE_REACTION_MS = 80;
export const PRECISION_LOW_VARIANCE_CV = 0.01;
// `HIGH_VARIANCE_CV = 1.0` reflects the SPEC's "extremely abnormal" wording —
// stddev at-or-greater than the mean is chaotic behaviour. We chose 1.0
// (not 0.8) to give first-time / distracted users a buffer: casual
// mis-taps can momentarily land at CV ~0.8 without crossing the
// threshold. 1.0 is conservative enough that legitimate extreme
// variability still fires while casual noise doesn't. Operators can
// tighten this if they observe too-many false positives.
export const PRECISION_HIGH_VARIANCE_CV = 1.0;
export const PRECISION_VARIANCE_MIN_SAMPLES = 3;
/** Upper bound on per-user per-match samples retained in the in-memory
 *  anomaly ledger. Set safety-net against accidental runaway memory use
 *  in matches with pathological arms. The cap is high enough that no
 *  real Precision match (max 5 rounds × 2 seats = 10 stops) would be
 *  truncated. */
export const PRECISION_ANOMALY_LEDGER_MAX_PER_MATCH = 64;

// ── Pre-round countdown (PvP + solo test) ────────────────────────────────
//
// Between rounds (and before the first round after ready-up), the server
// places the match in phase `arming` for a FIXED 5-second countdown. The
// client renders the live countdown from the server-stamped
// `countdownEndsAt` (`armingStartedAt + ROUND_COUNTDOWN_MS`), so both
// players see the same 5…4…3…2…1 and the timer + target appear at the
// same moment on both screens. The reveal itself is performed by the next
// read (`applyDueTransitions` in `serverStore.ts`) — there are no timers any
// more, so a recycled instance can never strand a round at 0 — and the
// countdown display stays purely visual; all round timing remains
// server-authoritative.
//
// The solo practice page (`/casino/precision/test`) mirrors this exact
// 5-second countdown client-side so practice rounds feel identical to a
// real PvP match.
//
// The target itself is only revealed when the phase flips to `active`
// (see `revealArmedRoundState`), so a predictable countdown start does not enable
// anticipatory clicking — the per-round target in [MIN_TARGET_MS,
// MAX_TARGET_MS] is still unknown until the timer starts.
export const ROUND_COUNTDOWN_MS = 5_000;

// Visual sizing for the eventual game board. The exact dimensions will
// be tuned in a future change; this is the canonical reference so any
// placeholder UIs (waiting room, results popup) can size correctly.
export const PANEL_MAX_WIDTH = "max-w-6xl";

// ── Socket / channel naming ──────────────────────────────────────────────
//
// All clients and any future server-side handlers MUST use these names so
// the public surface is consistent. Mirrors hexDuel:join / hexDuel:action
// conventions.
export const SOCKET_NAMESPACE = {
  lobbyListRoom: (lobbyId: string) => `precision:lobby:${lobbyId}`,
  matchRoom: (matchId: string) => `precision:match:${matchId}`,
  endReplayRoom: (matchId: string) => `precision:end:${matchId}`,
  lobbyListEvent: "precision:lobby:list",
  lobbyUpdateEvent: "precision:lobby:updated",
  opponentReadyEvent: "precision:opponent:ready",
  opponentDisconnectedEvent: "precision:opponent:disconnected",
  opponentResignedEvent: "precision:opponent:resigned",
  // Ready-up phase events — broadcast on the match room so both players
  // see each other's Ready clicks without waiting for the next poll.
  playerReadyEvent: "precision:playerReady",
  matchStartEvent: "precision:matchStart",
  // Per-player reaction-time submission. The client emits this once per
  // round (the STOP button is race-proof single-click). The realtime
  // server validates the caller is a participant of the requested
  // precision match, then proxies the stopMs to the Next.js
  // /api/precision/round-stop endpoint which holds the canonical match
  // state and computes the round winner via `recordRoundStop`. The
  // server uses the Socket.IO ACK callback to deliver
  // `{ success, error? }` back to the caller; the updated match state
  // is rebroadcast back to the match room when BOTH seats have
  // submitted so the sender keeps their "STOP SENT" UI until the
  // round actually resolves.
  stopEvent: "precision:stop",
  // Best-of-5 round + match events. Polling still works as the source of
  // truth (and finalises the result popup), but for a reaction game the
  // 1.5s poll cadence would feel laggy for round-decided notifications.
  roundResultEvent: "precision:roundResult",
  matchFinishedEvent: "precision:matchFinished",
  // Round-arm events — emitted when the server-side timer flips phase
  // arming back to active. Polling is the source of truth; this just
  // removes the 1.5s lag for the input form to appear.
  roundArmStartEvent: "precision:roundArmStart",
  endReplayRequestEvent: "precision:end:replay",
  endReturnEvent: "precision:end:return",
  stateSyncRequestEvent: "precision:requestSync",
  stateSyncEvent: "precision:syncState",
} as const;

// ── API route names (mirrors src/app/api/pool/*) ─────────────────────────
//
// Centralised so the lobby / match pages and stub API routes agree.
export const API_ROUTES = {
  createLobby: "/api/precision/create-lobby",
  createAi: "/api/precision/create-ai",
  joinLobby: "/api/precision/join-lobby",
  lobbies: "/api/precision/lobbies",
  getMatch: "/api/precision/get-match",
  ready: "/api/precision/ready",
  roundStop: "/api/precision/round-stop",
  finishMatch: "/api/precision/finish-match",
  updateState: "/api/precision/update-state",
  resign: "/api/precision/resign",
  leave: "/api/precision/leave",
} as const;
