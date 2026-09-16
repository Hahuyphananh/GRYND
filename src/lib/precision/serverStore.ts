// ── Server-side state for the Precision game (scaffold only) ────────────
//
// Mirrors `src/lib/unoRoomStore.js`: anchored on `globalThis` so that
// multiple API route modules share the same in-memory store across hot
// reloads. This is *only* meant to keep the scaffold navigable. A real
// implementation needs a database-backed implementation identical to the
// other PvP games (e.g. /api/pool/*).
//
// IMPORTANT: This module installs a Node `setInterval` and assumes the
// Node.js runtime. Do NOT import it from client components, server
// components running in the React Server Components stream, or
// `runtime = "edge"` API routes. Only import from regular `runtime`
// API route handlers under `src/app/api/precision/**`.

import { LOBBY_TTL_MS, MATCH_FINISHED_TTL_MS, MAX_STOP_MS, MIN_STOP_MS, MAX_TARGET_MS, MIN_TARGET_MS, ROUND_COUNTDOWN_MS, TARGET_WINS } from "./constants";
import {
  clearAnomalyLedgerForMatch,
  flushLedgerForMatch,
  recordAnomalySample,
} from "./anomalyDetection";
import type { PrecisionAnomalySample } from "./anomalyDetection";
import { mirrorPrecisionTransition } from "./canonicalLifecycle";
import type {
  PlayerSeat,
  PrecisionLobby,
  PrecisionPlayer,
  PrecisionScore,
  PrecisionState,
} from "./types";

/** Per-seat stop telemetry for a single round. Recorded server-side as
 *  the canonical proof of when each player's STOP arrived, plus the
 *  authoritative elapsed time. Never accepts a client-supplied ms. */
export interface PrecisionStopTelemetry {
  stopInstant: number;
  elapsedMs: number;
  diffMs: number;
}

const globalForPrecision = globalThis as typeof globalThis & {
  __precisionStableLobbies?: Map<string, PrecisionLobby>;
  __precisionStableMatches?: Map<string, PrecisionState>;
  /** Pending per-round telemetry, keyed by matchId then by userId.
   *  Server-only — never sent to clients. Resets on every round end. */
  __precisionPendingStops?: Map<string, Map<string, PrecisionStopTelemetry>>;
  /** Server-only Node `setTimeout` handles for the random pre-round
   *  arming delay, keyed by matchId. The timer fires server-side and
   *  flips `phase` from `arming` to `active`. Cleared on round-end,
   *  match-finish, or resign. */
  __precisionArmingTimers?: Map<string, NodeJS.Timeout>;
  /** Server-only random per-round target in milliseconds, keyed by
   *  matchId. Servered ROLLED at arm-start (in `armMatchRound`) and
   *  held privately until the arming→active timer reveals it onto the
   *  public match state. After the reveal, the live target lives on
   *  `match.targetMs` and this entry is cleared to free memory. Never
   *  exposed to clients. */
  __precisionRoundTargets?: Map<string, number>;
  /** Server-only `finishedAt` epoch (ms) per matchId. The TTL sweep
   *  below uses this to drop FINISHED matches older than
   *  `MATCH_FINISHED_TTL_MS` so an abandoned never-replayed match
   *  can't leak memory in a long-lived process. Set when phase
   *  flips to "finished" by `recordRoundStop` (matchwon branch) or
   *  by the resign route handler. NEVER sent to clients. */
  __precisionMatchFinishedAt?: Map<string, number>;
  /** Server-only AI stop timers, keyed by match id. */
  __precisionAiTimers?: Map<string, NodeJS.Timeout>;
  __precisionSweepInstalled?: boolean;
};

if (!globalForPrecision.__precisionStableLobbies) {
  globalForPrecision.__precisionStableLobbies = new Map();
}
if (!globalForPrecision.__precisionStableMatches) {
  globalForPrecision.__precisionStableMatches = new Map();
}
if (!globalForPrecision.__precisionPendingStops) {
  globalForPrecision.__precisionPendingStops = new Map();
}
if (!globalForPrecision.__precisionArmingTimers) {
  globalForPrecision.__precisionArmingTimers = new Map();
}
if (!globalForPrecision.__precisionRoundTargets) {
  globalForPrecision.__precisionRoundTargets = new Map();
}
if (!globalForPrecision.__precisionMatchFinishedAt) {
  globalForPrecision.__precisionMatchFinishedAt = new Map();
}
if (!globalForPrecision.__precisionAiTimers) {
  globalForPrecision.__precisionAiTimers = new Map();
}

export const precisionLobbyStore = globalForPrecision.__precisionStableLobbies;
export const precisionMatchStore = globalForPrecision.__precisionStableMatches;
export const precisionPendingStops =
  globalForPrecision.__precisionPendingStops;
export const precisionArmingTimers =
  globalForPrecision.__precisionArmingTimers;
export const precisionRoundTargets =
  globalForPrecision.__precisionRoundTargets;
export const precisionMatchFinishedAt =
  globalForPrecision.__precisionMatchFinishedAt;
export const precisionAiTimers = globalForPrecision.__precisionAiTimers;

export const PRECISION_AI_USER_ID = "AI_BOT";

export function isPrecisionAiMatch(match: PrecisionState | null | undefined): boolean {
  return Boolean(match?.isAiGame) && match.players.some((p) => p.seat === 2 && p.userId === PRECISION_AI_USER_ID);
}

/** Clears the pending-stops map for a match — called by `recordRoundStop`
 *  after both seats have submitted for a round (round decided or match
 *  finished). Centralising this keeps the cleanup path auditable. */
function clearPendingStops(matchId: string): void {
  precisionPendingStops.delete(matchId);
}

/** Cancels any pending arming timer for a match AND drops any pending
 *  per-round target value the server rolled for that match (so a
 *  re-arm rolls a fresh one). Idempotent teardown of all arming-related
 *  state — call from resign, disconnect, or any future cancel path
 *  without re-arming. Used by `armMatchRound` to roll a fresh arm
 *  (idempotent pre-arm cleanup) and exported for other routes.
 *
 *  Also clears the round's `roundId` and `roundNonce` from the public
 *  match state when called outside `armMatchRound` (e.g. from resign),
 *  so a client can't replay an old packet against a cancelled round.
 *  When `armMatchRound` calls this internally it then immediately
 *  re-stamps fresh values. */
export function cancelArming(matchId: string): void {
  // Clear the timer if one was scheduled — bail if not, but STILL drop
  // any orphan target slot so an explicit teardown from resign /
  // disconnect / resetGame works even when the timer already fired.
  const aiTimer = precisionAiTimers.get(matchId);
  if (aiTimer) {
    clearTimeout(aiTimer);
    precisionAiTimers.delete(matchId);
  }
  const timer = precisionArmingTimers.get(matchId);
  if (timer) {
    clearTimeout(timer);
    precisionArmingTimers.delete(matchId);
  }
  precisionRoundTargets.delete(matchId);
  // Strip the per-round replay-attack envelope from the public match
  // so a tampered client can't reuse a stale `roundId`/`nonce` if the
  // server was unable to enter `active`. `armMatchRound` clears this
  // BEFORE restamping fresh values, so the timing is safe both for
  // the resign and the re-arm paths.
  const match = precisionMatchStore.get(matchId);
  if (match) {
    match.roundId = null;
    match.roundNonce = null;
  }
}

/** Forfeit a match whose player has been confirmed-disconnected (the
 *  realtime server's disconnect grace timer expired). The opponent is
 *  declared the winner exactly like a natural match finish: phase →
 *  "finished", winnerSeat = opponent, arming canceled, pending stops
 *  cleared, anomaly ledger flushed, finishedAt stamped. No balances
 *  move — Precision's PvP wagering is not implemented yet (the resign
 *  route is a scaffold for the same reason), so a forfeit is scored
 *  like any other finish. Idempotent: already-finished matches are
 *  returned untouched so the caller's retry loop stops. */
export function forfeitMatch(
  matchId: string,
  loserUserId: string,
): { ok: boolean; match?: PrecisionState; reason?: string } {
  const match = precisionMatchStore.get(matchId);
  if (!match) return { ok: false, reason: "Match not found" };
  const loser = match.players.find((p) => p.userId === loserUserId);
  if (!loser) return { ok: false, reason: "Caller is not a participant" };
  if (match.phase === "finished") {
    // Already resolved (opponent won naturally, or a prior forfeit) —
    // treat as a successful no-op so the retry loop stops.
    return { ok: true, match };
  }
  const winnerSeat: PlayerSeat = loser.seat === 1 ? 2 : 1;
  match.winnerSeat = winnerSeat;
  match.phase = "finished";
  mirrorPrecisionTransition({
    matchId,
    status: "completed",
    playerCount: match.players.length,
  });
  cancelArming(matchId);
  clearPendingStops(matchId);
  flushLedgerForMatch(matchId);
  precisionMatchFinishedAt.set(matchId, Date.now());
  match.version += 1;
  return { ok: true, match };
}

/** Generates a server-only cryptographic nonce for a fresh round.
 *  Uses Web Crypto (`globalThis.crypto.randomUUID`) when available
 *  (Node 19+ and modern browsers) — otherwise falls back to a high-
 *  randomness base-36 token. The nonce is embedded into
 *  `match.roundNonce` and broadcast via `precision:roundArmStart` so
 *  the client can echo it back in its stop packet; the server
 *  REJECTS any stop whose nonce doesn't match. The fallback only
 *  fires on legacy runtimes where Web Crypto is missing; modern
 *  deployments always take the `randomUUID` path. */
function generateRoundNonce(): string {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Drops the private rolled target for a match. Always clears the entry
 *  — if the timer already fired and revealed it onto the public state,
 *  that copy is the live one from now on; if it hadn't fired yet, the
 *  target is garbage. Idempotent. */
function clearRoundTarget(matchId: string): void {
  precisionRoundTargets.delete(matchId);
}

/** Rolls a fresh server-only target in the inclusive integer range
 *  `[MIN_TARGET_MS, MAX_TARGET_MS]`. Millisecond precision — examples:
 *  3821, 6158, 9475. `Math.random()` is sufficient for fairness; a
 *  production-grade RNG swap can happen here without touching caller
 *  code. */
function rollRandomTarget(): number {
  const range = MAX_TARGET_MS - MIN_TARGET_MS + 1;
  return MIN_TARGET_MS + Math.floor(Math.random() * range);
}

/** Flips an ARMED round into the `active` phase — the reveal step the
 *  arming `setTimeout` performs when it fires. Extracted so the SAME
 *  transition can also be driven from a request path (see
 *  `promoteArmedRoundIfDue`), which is what guarantees a round can never
 *  be stranded in `arming` when the Node timer doesn't fire (a frozen
 *  serverless instance, a process restart between rounds, etc.).
 *
 *  Idempotent and state-guarded: a no-op unless the match is still
 *  `arming` with no declared winner. Reveals the privately rolled target
 *  onto `match.targetMs`, clears the arming stamps, stamps the
 *  authoritative `roundGoInstant` (from the server clock — clients never
 *  participate in scoring), resets the per-round pending-stops bucket,
 *  disarms the arming timer slot, and schedules the AI stop for AI
 *  matches. Returns `true` when the match actually transitioned. */
function revealArmedRound(matchId: string): boolean {
  const match = precisionMatchStore.get(matchId);
  if (!match) return false;
  // Defensive: if the match was finished/resigned while we were pending
  // (e.g. an opponent resigned during arming), don't flip the phase back
  // to active. The private rolled target is dropped regardless — its
  // lifetime ended with this transition.
  if (match.phase !== "arming") {
    clearRoundTarget(matchId);
    return false;
  }
  if (match.winnerSeat !== null) {
    clearRoundTarget(matchId);
    return false;
  }
  // The arming timer slot (if any) is moot — the transition happens here.
  // `clearTimeout` on a timer that is already executing is a harmless
  // no-op for the timer-driven path.
  const pending = precisionArmingTimers.get(matchId);
  if (pending) {
    clearTimeout(pending);
    precisionArmingTimers.delete(matchId);
  }
  // REVEAL the rolled target onto the public state so both polling
  // clients read the SAME value at the SAME moment. The private copy is
  // then cleared — the public field becomes the source of truth.
  const rolled = precisionRoundTargets.get(matchId);
  clearRoundTarget(matchId);
  if (rolled !== undefined) {
    match.targetMs = rolled;
  }
  match.phase = "active";
  match.armingStartedAt = null;
  match.countdownEndsAt = null;
  // Authoritative GO instant for this round — stamped server-side so
  // client clocks never participate in scoring. The pending-stops bucket
  // for this round is also reset so the per-round telemetry boundary is
  // clean (the previous round's stop data is already captured in
  // `lastRoundStops`).
  match.roundGoInstant = Date.now();
  precisionPendingStops.delete(matchId);
  // `roundId` and `roundNonce` STAY populated throughout the round so the
  // client can read them from the public state and echo them back in its
  // stop packet. They're cleared on resign / cancel / match-finish via
  // `cancelArming` and the dedicated `matchFinished` branch.
  match.version += 1;
  schedulePrecisionAiStop(match);
  return true;
}

/** Self-healing arming → active transition for READ paths.
 *
 *  The arming round is promoted by a Node `setTimeout` created inside
 *  `armMatchRound`. That timer is the fast path, but it is NOT a guarantee:
 *  a serverless instance can be frozen (or recycled) between the arm-start
 *  response and the moment the countdown expires, and a process restart
 *  loses it outright. When that happens the match sat in `arming` forever —
 *  both clients' countdowns reached 0 and never opened a round ("the timer
 *  is stuck on 0").
 *
 *  Because `countdownEndsAt` is stamped on the public state, any reader can
 *  deterministically tell that the countdown has elapsed. Callers invoke
 *  this before publishing a match snapshot, so the FIRST request after the
 *  countdown ends performs the reveal the timer was going to perform —
 *  independently of whether that timer ever fired. It never promotes early
 *  (the `countdownEndsAt > now` guard keeps the arming phase honest) and is
 *  idempotent, so concurrent readers are safe. Returns `true` when THIS
 *  call performed the transition. */
export function promoteArmedRoundIfDue(matchId: string): boolean {
  const match = precisionMatchStore.get(matchId);
  if (!match) return false;
  if (match.phase !== "arming") return false;
  if (match.winnerSeat !== null) return false;
  const endsAt = match.countdownEndsAt;
  // An unstamped/!numeric countdown can't be evaluated — leave that round
  // to the arming timer rather than opening it on a guess.
  if (typeof endsAt !== "number" || endsAt > Date.now()) return false;
  return revealArmedRound(matchId);
}

/** Transition a match into the `arming` phase with a server-side
 *  `setTimeout` for a FIXED 5-second countdown (`ROUND_COUNTDOWN_MS`).
 *  Cancels any prior timer for the same match before scheduling the
 *  new one (idempotent re-arm). Returns `true` if armed, `false` if
 *  the match is missing or already finished.
 *
 *  Server behavior:
 *  - Public state exposes `armingStartedAt` and `countdownEndsAt`
 *    (when the countdown ends) plus a new random target (held
 *    privately). Both clients render the countdown from the same
 *    absolute `countdownEndsAt` instant, so the timer + target appear
 *    simultaneously on both screens when the server fires.
 *  - At arm-start, a fresh random target in `[MIN_TARGET_MS,
 *    MAX_TARGET_MS]` is rolled and stored ONLY in
 *    `precisionRoundTargets` (server-only).
 *  - When the countdown timer fires, the rolled target is REVEALED
 *    onto `match.targetMs` so both polling clients see the same value
 *    at the same moment. The private entry is then dropped.
 *
 *  The timer is only the FAST PATH for that reveal: the same
 *  transition is also driven from request paths via
 *  `promoteArmedRoundIfDue`, so a lost timer can never strand a round
 *  in `arming` (see that function for the failure mode). */
export function armMatchRound(matchId: string): boolean {
  const match = precisionMatchStore.get(matchId);
  if (!match) return false;
  if (match.phase === "finished") return false;
  if (match.winnerSeat !== null) return false;
  // Idempotent: cancel any existing timer (and its private target)
  // before scheduling a new one. Re-arming always produces a fresh
  // target — there is no scenario where a queued timer should reveal
  // a value from a previous arm. `cancelArming` already drops the
  // private target entry, so no separate clearRoundTarget call here.
  cancelArming(matchId);
  // Fixed 5-second countdown — the warning before the timer starts.
  // The per-round target (revealed only at active) defeats anticipatory
  // clicking, so the countdown itself needs no randomness.
  const delay = ROUND_COUNTDOWN_MS;
  // Roll the round target NOW and stash it in the server-only map.
  // The public `match.targetMs` stays `null` until the timer fires so
  // a client cannot pre-read it during the arming phase.
  const targetMs = rollRandomTarget();
  precisionRoundTargets.set(matchId, targetMs);
  match.phase = "arming";
  match.armingStartedAt = Date.now();
  // Stamp the absolute instant the countdown ends — clients render the
  // live 5…4…3…2…1 from this value so both screens stay in sync.
  match.countdownEndsAt = match.armingStartedAt + ROUND_COUNTDOWN_MS;
  // Public target stays hidden — server-only map holds the live value.
  match.targetMs = null;
  // ── Replay-attack protection ─────────────────────────────────────
  // Stamp a FRESH, monotonically-increasing `roundSequence`, a
  // human-readable `roundId`, and a server-only cryptographic `nonce`
  // for this round. The client must include `roundId` AND `nonce` in
  // its stop packet; the server REJECTS packets whose values don't
  // match `match.roundId` / `match.roundNonce` (replay from previous
  // rounds) and REJECTS duplicate stops in the same round via the
  // per-round bucket. Both values flow to the client in this same
  // `match` snapshot — broadcast via `precision:roundArmStart` from
  // the realtime server.
  //
  // `roundSequence` is monotonic AND round-independent of
  // `currentRound` (which does NOT advance on ties — ties replay the
  // same `currentRound` count but get a NEW roundSequence + new
  // roundId + new nonce). This means an attacker can't replay a tied
  // round's stop packet either — their old `roundId`/`nonce` won't
  // match the live ones.
  match.roundSequence = (match.roundSequence ?? 0) + 1;
  match.roundId = `m-${matchId}-r-${match.roundSequence}`;
  match.roundNonce = generateRoundNonce();
  match.version += 1;
  const timer = setTimeout(() => {
    precisionArmingTimers.delete(matchId);
    revealArmedRound(matchId);
  }, delay);
  precisionArmingTimers.set(matchId, timer);
  // Don't hold the Node process alive during graceful shutdown.
  timer.unref?.();
  return true;
}

// ── TTL sweep for abandoned queue entries ─────────────────────────────────
//
// Waiting lobbies that no player ever comes back to, AND finished
// matches that no client ever opens again in the end-replay window,
// would otherwise leak forever. `unref()` keeps this interval from
// holding the Node event loop open during graceful shutdown. 30s sweep
// interval matches the cadence used by pool/dice/farkle stores in
// `realtime-server/server.js`.
//
// On a finished-match prune we ALSO drop the per-match server-side
// state: pending stops, arming timer slot (defensive), per-round
// target (defensive), and the anomaly ledger — otherwise each
// finished match would still leak 5 records into the global ThisMap.
if (!globalForPrecision.__precisionSweepInstalled) {
  globalForPrecision.__precisionSweepInstalled = true;
  const interval = setInterval(() => {
    const now = Date.now();
    // 1. Drop abandoned waiting lobbies.
    for (const [id, lobby] of precisionLobbyStore) {
      if (
        lobby.status === "waiting" &&
        now - lobby.createdAt > LOBBY_TTL_MS
      ) {
        precisionLobbyStore.delete(id);
      }
    }
    // 2. Drop finished matches whose replay window has lapsed.
    for (const [matchId, finishedAt] of precisionMatchFinishedAt) {
      if (now - finishedAt > MATCH_FINISHED_TTL_MS) {
        precisionMatchStore.delete(matchId);
        precisionMatchFinishedAt.delete(matchId);
        precisionPendingStops.delete(matchId);
        precisionArmingTimers.delete(matchId);
        precisionRoundTargets.delete(matchId);
        // Free the per-match anomaly ledger so its samples don't leak.
        clearAnomalyLedgerForMatch(matchId);
      }
    }
  }, 30_000);
  // Don't hold the Node process alive during graceful shutdown.
  interval.unref?.();
}

/** Explicit cancel hook used by clients on leave/cancel. Only succeeds
 *  if the caller is the original host and the lobby is STILL waiting
 *  at the moment of deletion. The status re-check after Map.get guards
 *  against racing with `tryAutoMatch` which can flip status to "active"
 *  between ownership checks. */
export function cancelQueueEntry(
  lobbyId: string,
  hostUserId: string,
): boolean {
  const lobby = precisionLobbyStore.get(lobbyId);
  if (!lobby) return false;
  if (lobby.hostUserId !== hostUserId) return false;
  if (lobby.status !== "waiting") return false;
  // Atomic delete after all checks — re-check happened as close to the
  // delete as is possible in single-threaded JS.
  if (precisionLobbyStore.get(lobbyId)?.status !== "waiting") return false;
  return precisionLobbyStore.delete(lobbyId);
}

/** Atomically mark a single player as Ready inside a `ready_up` match.
 *  Idempotent: re-clicking Ready from the same player is a no-op.
 *  When BOTH players have `isReady === true`, advances the match to
 *  `phase: "active"` and bumps the version so polling clients detect the
 *  transition. Returns diagnostic flags so the route handler can decide
 *  whether to emit the `matchStart` socket event. */
export function markPlayerReady(
  matchId: string,
  userId: string,
): {
  match: PrecisionState | null;
  playerReady: boolean;
  bothReady: boolean;
  alreadyAdvanced: boolean;
} {
  const match = precisionMatchStore.get(matchId);
  if (!match) {
    return {
      match: null,
      playerReady: false,
      bothReady: false,
      alreadyAdvanced: false,
    };
  }
  // If the match has already advanced past ready-up, return the current
  // state without mutating. The client can use the version to nudge a
  // render if its state was lagging behind.
  if (match.phase !== "ready_up") {
    return {
      match,
      playerReady: true,
      bothReady: false,
      alreadyAdvanced: true,
    };
  }
  let touched = false;
  for (const p of match.players) {
    if (p.userId === userId && !p.isReady) {
      p.isReady = true;
      touched = true;
    }
  }
  const allReady =
    match.players.length >= 2 && match.players.every((p) => p.isReady);
  if (allReady) {
    // Both players ready → arm the FIRST round. The server runs the
    // fixed 5-second countdown (`ROUND_COUNTDOWN_MS`) and transitions
    // the match through `arming` → `active` automatically. Clients
    // render the countdown from the server-stamped `countdownEndsAt`.
    armMatchRound(matchId);
  } else if (touched) {
    // Bump the version on a single Ready so the opponent's polling sees
    // the change one tick sooner.
    match.version += 1;
  }
  return {
    match,
    playerReady: touched || match.players.some((p) => p.userId === userId && p.isReady),
    bothReady: allReady,
    alreadyAdvanced: false,
  };
}

/** Result of a single `recordRoundStop` call. The caller (route handler)
 *  uses these flags to decide which socket events to emit and which
 *  diagnostics to surface to the client. */
export interface RecordRoundStopResult {
  match: PrecisionState | null;
  /** True once THIS caller had previously recorded a stop for the current
   *  round and submitted again (no-op re-submission). */
  alreadySubmitted: boolean;
  /** True once both players have submitted for the current round. */
  bothStopped: boolean;
  /** Seat that won the just-decided round, or null on tie / before both
   *  stops arrive. */
  roundWinnerSeat: PlayerSeat | null;
  /** True once the server has advanced the match to `phase: "finished"`
   *  because one seat's score reached `TARGET_WINS`. */
  matchFinished: boolean;
  /** True when rejection was a numeric-input validation failure (out of
   *  range, NaN, etc.). Routes use this to choose 400 over 409 without
   *  fragile string matching. */
  validationError: boolean;
  /** Specific reason the call was rejected (participant not found,
   *  match not active, stop out of range, etc.). */
  error?: string;
}

function schedulePrecisionAiStop(match: PrecisionState): void {
  if (!isPrecisionAiMatch(match) || match.phase !== "active") return;
  if (precisionAiTimers.has(match.matchId)) return;
  const target = Number(match.targetMs);
  if (!Number.isFinite(target)) return;
  // The bot aims near the server-revealed target with a small natural
  // error. The STOP itself is still stamped by recordRoundStop; this
  // delay only schedules when the bot sends its signal.
  const reactionError = 80 + Math.floor(Math.random() * 241);
  const timer = setTimeout(() => {
    precisionAiTimers.delete(match.matchId);
    const live = precisionMatchStore.get(match.matchId);
    if (!live || live.phase !== "active" || live.roundId === null || live.roundNonce === null) return;
    recordRoundStop(live.matchId, PRECISION_AI_USER_ID, live.roundId, live.roundNonce);
  }, Math.max(100, target + reactionError));
  timer.unref?.();
  precisionAiTimers.set(match.matchId, timer);
}

/**
 *  Atomically records a single player's STOP signal and captures the
 * SERVER-side timestamp at receive time. The elapsed time is computed
 * authoritatively as `stopInstant - match.roundGoInstant` — clients
 * never participate in scoring (no stopMs is accepted from them). When
 * BOTH players have submitted for the current round, the server
 * computes the round winner INDEPENDENTLY from its own `match.targetMs`
 * (the client has no way to influence which seat wins), increments
 * that seat's `match.score`, advances the match to `phase: "finished"`
 * if either seat hit `TARGET_WINS`, and otherwise increments
 * `currentRound` (and arms the next round via `armMatchRound`, which
 * will stamp a fresh `roundGoInstant`).
 *
 * ── Replay-attack protection (this signature) ──
 *   - `roundId` must match the LIVE `match.roundId`. A tampered
 *     client that replays a packet from a PREVIOUS round will fail
 *     this check because `match.roundId` is monotonic and re-stamped
 *     on every `armMatchRound` call (including ties, which re-arm
 *     the SAME `currentRound` but with a NEW roundSequence + new
 *     `roundId` + new `nonce`).
 *   - `nonce` must match the LIVE `match.roundNonce`. This is a
 *     cryptographic nonce rolled server-side (`crypto.randomUUID`)
 *     and broadcast to clients via `precision:roundArmStart`. The
 *     server-only nonce is the bulwark against an attacker who
 *     mutates the `roundId` field but can't predict `roundNonce`.
 *   - Duplicate stop packet from same `userId` for same round:
 *     REJECTED. The bucket is NOT overwritten with the second
 *     packet's telemetry — replaying simply yields `{ alreadySubmitted:
 *     true, error: "..." }`. The previous recordRoundStop call
 *     REFRESHED the bucket on replay, which let an attacker iterate
 *     their telemetry until their preferred timing produced a
 *     favourable diff; the new behavior hard-stops that strategy.
 *
 * All server-stored values per-round:
 *   - `match.roundGoInstant`    — when the round opened (arm→active).
 *   - `bucket[userId].stopInstant` — when each seat's STOP arrived.
 *   - `bucket[userId].elapsedMs`  — server-computed `stopInstant - goInstant`.
 *   - `match.lastRoundStops` after decision — { seat1, seat2 } telemetry.
 *
 * Concurrency: under Node's single-threaded model, two simultaneous
 * STOPs from both players execute serially. The first to arrive records
 * its stop; the second sees the bucket already populated and triggers
 * the round evaluation. The `version` bump lets the polling clients
 * detect the change without missing the round transition.
 */
export function recordRoundStop(
  matchId: string,
  userId: string,
  roundId: string,
  nonce: string,
): RecordRoundStopResult {
  const match = precisionMatchStore.get(matchId);
  if (!match) {
    return {
      match: null,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: "Match not found.",
    };
  }
  if (match.phase !== "active") {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: match.phase === "finished"
        ? "Match is already finished."
        : `Match is not active (phase=${match.phase}).`,
    };
  }
  if (match.winnerSeat !== null) {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: true,
      validationError: false,
      error: "Match is already finished.",
    };
  }
  // Resolve caller's seat from `match.players` so a stray client cannot
  // pick which seat it's "playing" — "never trust the client".
  const caller = match.players.find((p) => p.userId === userId);
  if (!caller) {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: "Caller is not a participant in this match.",
    };
  }
  if (match.players.length < 2) {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: "Match is incomplete (only one participant).",
    };
  }
  // The round must have a server-stamped GO instant before a STOP is
  // acceptable. roundGoInstant is set in armMatchRound's timer callback
  // the instant phase flips arming → active. null here means the timer
  // hasn't fired yet (or has been reset by a phase transition out of
  // "active") and the STOP arrived out of order.
  if (match.roundGoInstant === null) {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: "Round is not open yet (no server GO instant).",
    };
  }
  // ── Replay-attack protection #1 (roundId) ──
  // A tampered client cannot submit a stop from a previous round —
  // the live `match.roundId` is the only valid value. The client
  // read this off the `precision:roundArmStart` broadcast (or the
  // polled state when `arming → active` flipped).
  if (typeof roundId !== "string" || roundId.length === 0) {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: "Missing roundId.",
    };
  }
  if (roundId !== match.roundId) {
    console.warn(
      "[precision] rejecting stop with stale roundId from user",
      userId,
      "matchId",
      matchId,
      "got",
      roundId,
      "live",
      match.roundId,
    );
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: "Round ID mismatch. Stop packet from a previous round rejected.",
    };
  }
  // ── Replay-attack protection #2 (nonce) ──
  // Even if the `roundId` matches (because the attacker replayed an
  // old packet that ALSO had a matching `roundId` — only possible
  // during the brief window BEFORE the next arm-start clears the
  // value), the cryptographically-random `nonce` differs across
  // rounds BY CONSTRUCTION. A previous-round packet's nonce will
  // never equal the live nonce.
  if (typeof nonce !== "string" || nonce.length === 0) {
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: "Missing nonce.",
    };
  }
  if (nonce !== match.roundNonce) {
    console.warn(
      "[precision] rejecting stop with stale nonce from user",
      userId,
      "matchId",
      matchId,
    );
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: "Nonce mismatch. Stop packet rejected (possible replay).",
    };
  }
  // Server-stamped STOP instant — this is the only clock source for
  // timing. Clients NEVER supply elapsed.
  const stopInstant = Date.now();
  if (stopInstant < match.roundGoInstant) {
    // Server clock went backwards (e.g. NTP correction). Reject so
    // negative-elapsedMs never reaches the bucket.
    return {
      match,
      alreadySubmitted: false,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: "Server clock produced a negative elapsed (unlikely).",
    };
  }
  const elapsedMs = stopInstant - match.roundGoInstant;

  // Per-seat bucket stores the per-stop telemetry so a partial-stop
  // submission survives even if the opponent hasn't arrived yet. Each
  // entry is now a { stopInstant, elapsedMs, diffMs? } object — the
  // server is the only source of these fields. `diffMs` is set
  // authoritatively below, AFTER the round's revealed target is read
  // from `match.targetMs`. We start with 0 here (un-grading) and
  // overwrite before broadcasting.
  //
  // ── Replay-attack protection #3 (single stop packet) ──
  // If the bucket already has an entry for this user, REJECT the
  // packet — DO NOT overwrite. The legacy behavior refreshed the
  // bucket on every call, which let an attacker iterate their
  // `stopInstant` until they liked the resulting `elapsedMs`. The
  // new behavior stops the round's first submission in stone and
  // surfaces a deterministic `alreadySubmitted: true` response so
  // the client knows to stop clicking. Note that `roundId` +
  // `nonce` checks above already filtered cross-round replays;
  // this is the third (and final) layer.
  const bucket =
    precisionPendingStops.get(matchId) ?? new Map<string, PrecisionStopTelemetry>();
  if (bucket.has(userId)) {
    return {
      match,
      alreadySubmitted: true,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: "A stop packet has already been submitted for this round.",
    };
  }
  const alreadySubmitted = false;
  bucket.set(userId, { stopInstant, elapsedMs, diffMs: 0 });
  precisionPendingStops.set(matchId, bucket);

  // Validate the elapsed against the server-defined bounds. The
  // existing MIN_STOP_MS / MAX_STOP_MS constants now bound the
  // server-measured elapsed rather than client-supplied ms.
  if (elapsedMs < MIN_STOP_MS || elapsedMs > MAX_STOP_MS) {
    return {
      match,
      alreadySubmitted,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: true,
      error: `Server-measured elapsedMs (${elapsedMs}) is outside [${MIN_STOP_MS}, ${MAX_STOP_MS}].`,
    };
  }

  // Wait for the OPPONENT to also submit. The first arrival only records
  // and returns — NO score mutation, NO round evaluation. This is what
  // makes the design "never trust the client": the opponent's stop is
  // independently POSTed by their own client.
  //
  // We deliberately do NOT bump `version` here — the round isn't
  // decided yet, so a "new version" hint with no semantic diff would
  // cause needless reconciliation in polling clients.
  if (bucket.size < 2) {
    return {
      match,
      alreadySubmitted,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
    };
  }

  // Both seats have submitted — compute round winner INDEPENDENTLY.
  const seat1 = match.players.find((p) => p.seat === 1);
  const seat2 = match.players.find((p) => p.seat === 2);
  const stopSeat1 = seat1 ? bucket.get(seat1.userId) ?? null : null;
  const stopSeat2 = seat2 ? bucket.get(seat2.userId) ?? null : null;
  const stopSeat1_userId = seat1?.userId;
  const stopSeat2_userId = seat2?.userId;
  if (stopSeat1 === null || stopSeat2 === null) {
    // Shouldn't happen because we just confirmed bucket.size >= 2, but
    // be defensive: leave the bucket intact so retry can succeed.
    return {
      match,
      alreadySubmitted,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: "Stop data is incomplete.",
    };
  }

  // `recordRoundStop` only proceeds past the `phase !== "active"` guard
  // once `armMatchRound`'s timer has fired, which is the exact moment
  // the rolled target is revealed onto `match.targetMs`. So at this
  // point `match.targetMs` is guaranteed to be a number, not null —
  // but TypeScript can't see that invariant, so we narrow defensively.
  if (match.targetMs === null) {
    return {
      match,
      alreadySubmitted,
      bothStopped: false,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
      error: "Round target not yet revealed (server glitch).",
    };
  }
  const revealedTarget = match.targetMs;
  // Differences are computed from server-stamped elapsed, never from
  // client-supplied values. The seat with the SMALLEST absolute
  // difference is the round winner. Ties (diff1 === diff2) replay
  // the round: the cube-rolled `precisionRoundTargets` rolling logic
  // in `armMatchRound` picks a fresh target so neither seat can claim
  // the round from a pseudo-tie. Diff math is done HERE ONCE and
  // stored in the per-stop bucket — the client receives the diff via
  // `match.lastRoundStops` and never recomputes anything locally.
  const diff1 = Math.abs(stopSeat1.elapsedMs - revealedTarget);
  const diff2 = Math.abs(stopSeat2.elapsedMs - revealedTarget);
  stopSeat1.diffMs = diff1;
  stopSeat2.diffMs = diff2;
  bucket.set(stopSeat1_userId!, stopSeat1);
  bucket.set(stopSeat2_userId!, stopSeat2);
  // Re-stamp the freshly-graced bucket so the broadcast below sees
  // the diffMs values; without this the bucket holds the un-graded
  // zero-diffMs entries we wrote at receive time.
  precisionPendingStops.set(matchId, bucket);
  let roundWinnerSeat: PlayerSeat | null = null;
  if (diff1 < diff2) roundWinnerSeat = 1;
  else if (diff2 < diff1) roundWinnerSeat = 2;
  // Ties (diff1 === diff2) -> REPLAY the round. The currentRound is
  // NOT advanced, the score is unchanged, and `armMatchRound` below
  // rolls a fresh random target and re-enters the arming cycle for
  // the SAME round. Per-seat telemetry in `lastRoundStops` remains
  // visible during the replay so the user can verify the tied
  // values.

  const newScore: PrecisionScore = { ...match.score };
  if (roundWinnerSeat === 1) newScore.seat1 += 1;
  else if (roundWinnerSeat === 2) newScore.seat2 += 1;

  // matchFinished is computed off `newScore` AFTER applying any
  // increment — for a tie `newScore` is unchanged so `matchFinished`
  // is always false here; we never declare a match winner on a tie.
  const matchFinished =
    newScore.seat1 >= TARGET_WINS || newScore.seat2 >= TARGET_WINS;

  match.score = newScore;
  match.lastRoundWinnerSeat = roundWinnerSeat;
  // Persist the just-decided round's per-seat timing data so the
  // post-round result popup — and the replay banner during the
  // arming cycle on a tie — can show each player's server-measured
  // elapsed without re-querying. Replaced on the next non-tie round
  // decision. `diffMs` is server-graded here so the client never
  // needs to recompute `|elapsed - target|` for display.
  if (seat1 && seat2) {
    match.lastRoundStops = {
      seat1: {
        stopInstant: stopSeat1.stopInstant,
        elapsedMs: stopSeat1.elapsedMs,
        diffMs: stopSeat1.diffMs,
        userId: seat1.userId,
      },
      seat2: {
        stopInstant: stopSeat2.stopInstant,
        elapsedMs: stopSeat2.elapsedMs,
        diffMs: stopSeat2.diffMs,
        userId: seat2.userId,
      },
    };
  }

  // ── Anomaly-detection ledger ────────────────────────────────────────────────
  // Both seats have just submitted for the round and the per-stop
  // telemetry is fully server-stamped. Push a sample into the per-match
  // ledger so `recordAnomalySample` can compute impossible-reaction,
  // low-variance, and high-variance flags on the fly. The ledger is
  // AUDIT-ONLY — it does NOT affect gameplay decisions. Flags fire
  // `console.warn` lines but never reject stop packets or change the
  // round winner. Flushed at match-finish below via
  // `flushLedgerForMatch`.
  const roundSequenceForAnomaly =
    match.roundSequence ?? 0;
  // Build a labelled candidates array so the recording loop doesn't
  // rely on positional index ↔ seat ordering. Each candidate carries
  // the player record + the telemetry sample so the loop reads them
  // directly. The `userId` check filters out the rare same-user-across-
  // seats pathological case (e.g. a placeholder), and an empty-string
  // userId would otherwise slip through.
  const candidates: Array<{
    user: PrecisionPlayer | undefined;
    sample: PrecisionAnomalySample;
  }> = [];
  if (seat1) {
    candidates.push({
      user: seat1,
      sample: {
        roundSequence: roundSequenceForAnomaly,
        elapsedMs: stopSeat1.elapsedMs,
        diffMs: stopSeat1.diffMs,
        stopInstant: stopSeat1.stopInstant,
      },
    });
  }
  if (seat2 && seat2.userId !== seat1?.userId) {
    candidates.push({
      user: seat2,
      sample: {
        roundSequence: roundSequenceForAnomaly,
        elapsedMs: stopSeat2.elapsedMs,
        diffMs: stopSeat2.diffMs,
        stopInstant: stopSeat2.stopInstant,
      },
    });
  }
  for (const { user, sample } of candidates) {
    const uid = user?.userId;
    if (typeof uid !== "string" || uid.length === 0) continue;
    recordAnomalySample({ matchId, userId: uid, sample });
  }

  if (roundWinnerSeat === null) {
    // TIE — REPLAY this round. No score increment (already reflected
    // in `newScore`), no `currentRound` advance, no winnerSeat on a
    // match. We re-roll the per-round target via `armMatchRound`:
    // it cancels any pre-existing timer (none for this branch since
    // we just transitioned out of `active`), picks a fresh random
    // target in [MIN_TARGET_MS, MAX_TARGET_MS], writes
    // `phase = "arming"` + `armingStartedAt = Date.now()` +
    // `targetMs = null` (the new target stays server-only in
    // `precisionRoundTargets` until the arm→active timer fires),
    // and schedules the timer that will flip phase back to
    // `active` after a random delay. The realtime-server's
    // precision:stop handler propagates the resulting state back to
    // the precision match room via `precision:roundResult` +
    // `precision:roundArmStart` so both clients flip to the
    // arming UI immediately without waiting for the next 1.5s poll.
    match.version += 1;
    armMatchRound(matchId);
    return {
      match,
      alreadySubmitted,
      bothStopped: true,
      roundWinnerSeat: null,
      matchFinished: false,
      validationError: false,
    };
  }

  if (matchFinished) {
    // Determine which seat hit TARGET_WINS. If both exceeded it (only
    // possible if TARGET_WINS <= 0, which would be a config bug), pick
    // the higher-scoring seat, falling back to first-arriver order.
    const seat1Won = newScore.seat1 >= TARGET_WINS;
    const seat2Won = newScore.seat2 >= TARGET_WINS;
    let winnerSeat: PlayerSeat | null = null;
    if (seat1Won && !seat2Won) winnerSeat = 1;
    else if (seat2Won && !seat1Won) winnerSeat = 2;
    else if (seat1Won && seat2Won) {
      winnerSeat =
        newScore.seat1 > newScore.seat2 ? 1
          : newScore.seat2 > newScore.seat1 ? 2
          : roundWinnerSeat;
    }
    match.winnerSeat = winnerSeat;
    match.phase = "finished";
    // Cancel any scheduled arming timer so a late-firing one doesn't
    // erroneously flip phase back to "active" on a finished match.
    // `cancelArming` ALSO clears `match.roundId` / `match.roundNonce`
    // — defense-in-depth so a tampered client can't reuse the last
    // round's envelope against a finished match (recordRoundStop's
    // phase guard already rejects, but belt + braces).
    cancelArming(matchId);
    // No pending state needs cleaning — match is terminal. Leaving the
    // bucket in place is harmless (recordRoundStop rejects new POSTs
    // once phase !== "active"), but we clear it for hygiene.
    clearPendingStops(matchId);
    // Flush the per-match anomaly ledger. The summary log line is
    // emitted only if any user landed at least one flag (impossible-
    // reaction / low-variance / high-variance) — otherwise the flush
    // is silent. This is the operator-facing audit trail; auto-ban
    // is intentionally NOT a part of this spec.
    flushLedgerForMatch(matchId);
    // ── Audit fix: stamp finishedAt so the TTL sweep below knows
    // when to drop this match. Without this entry, a long-lived
    // process would accumulate finished matches indefinitely.
    precisionMatchFinishedAt.set(matchId, Date.now());
  } else {
    // Round decided but match continues. Bump the round counter and arm
    // the next round; `armMatchRound` clears pending stops, sets
    // phase=`arming`, schedules the random-delay timer, and will flip
    // phase back to `active` on its own when the timer fires.
    match.currentRound += 1;
    armMatchRound(matchId);
  }

  match.version += 1;
  if (match.phase === "active") schedulePrecisionAiStop(match);
  return {
    match,
    alreadySubmitted,
    bothStopped: true,
    roundWinnerSeat,
    matchFinished,
    validationError: false,
  };
}
