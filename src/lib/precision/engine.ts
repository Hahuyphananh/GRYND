// ── Pure game engine for the Precision reaction-stop duel ───────────────
//
// Every rule that DECIDES something lives here as a plain function over
// plain data:
//   * what a fresh match looks like (`makeInitialMatch`),
//   * what arming a round stamps, and when an armed round becomes due
//     (`armRoundState` / `isArmedRoundDue` / `revealArmedRoundState`),
//   * which seat takes a round from the two server-stamped stops, and
//     whether that ends the match (`evaluateRound`),
//   * how a match is closed out (`finishMatchState`).
//
// NO database, NO timers, NO `globalThis`. This module is what makes the
// serverless refactor possible: the store persists the RESULT of these
// functions and re-derives every transition from stored instants, so a
// frozen instance can never strand a round. It is also the only part of the
// game that can be unit-tested without a database.
//
// INVARIANTS (unchanged from the in-memory implementation these were
// extracted from — the security model depends on them):
//   * `roundGoInstant` is server-stamped, and the client's own frozen elapsed
//     at the click is what a stop is GRADED at (`resolveStopElapsedMs`) — the
//     number the player was watching, so the delivery lag between the click
//     and the packet landing is never charged to their reaction time. The
//     server's own measurement is the ceiling (a stop cannot have happened
//     after we received it) and `MIN_STOP_MS` the floor.
//   * The rolled target is never public while a round is arming. It lives
//     in a server-only column and is copied onto `state.targetMs` only at
//     the reveal.
//   * A tie (equal |elapsed - target|) replays the SAME `currentRound` with
//     a fresh `roundSequence` / `roundId` / nonce, so an old packet can
//     never be replayed into the replay.

import {
  MAX_STOP_MS,
  MAX_TARGET_MS,
  MIN_STOP_MS,
  MIN_TARGET_MS,
  ROUND_COUNTDOWN_MS,
  TARGET_WINS,
} from "./constants";
import type {
  PlayerSeat,
  PrecisionPlayer,
  PrecisionScore,
  PrecisionState,
} from "./types";

/** Server-stamped telemetry for ONE seat's stop in ONE round. Mirrors the
 *  shape persisted in `precision_matches.pending_stops` — every field is
 *  measured by the server, never sent by a client. */
export interface PrecisionStopTelemetry {
  stopInstant: number;
  elapsedMs: number;
  diffMs: number;
}

/** Construct the initial state for a new match.
 *
 *  Both the PvP matchmaking path and the practice (vs AI) path build their
 *  state through here so the two can never drift apart. The match starts in
 *  `ready_up` in BOTH cases: neither route may pre-arm the round, because an
 *  arming countdown stamped before the player's page has loaded is already
 *  expired when it renders (the reported "countdown stuck on 0"). */
export function makeInitialMatch(
  matchId: string,
  wager: number,
  players: PrecisionPlayer[],
  phase: PrecisionState["phase"] = "ready_up",
  currentTurn: PrecisionState["turn"] = 1,
  isAiGame = false,
): PrecisionState {
  return {
    matchId,
    phase,
    wager,
    isAiGame,
    // No bot stop has been observed yet (AI matches only ever populate this
    // when the bot's stored stop instant is applied on the server).
    aiStop: null,
    players,
    turn: currentTurn,
    score: { seat1: 0, seat2: 0 },
    currentRound: 1,
    // Replay-attack envelope — stamped by `armRoundState` on each arm.
    roundSequence: 0,
    roundId: null,
    roundNonce: null,
    // Revealed only at the arm→active transition.
    targetMs: null,
    winnerSeat: null,
    lastRoundWinnerSeat: null,
    // Stamped together with `lastRoundStops` when a round is decided.
    lastRoundTargetMs: null,
    armingStartedAt: null,
    countdownEndsAt: null,
    roundGoInstant: null,
    lastRoundStops: null,
    version: 1,
  };
}

/** Rolls a fresh server-only target in the inclusive integer range
 *  `[MIN_TARGET_MS, MAX_TARGET_MS]`. Millisecond precision — 3821, 6158,
 *  9475. `Math.random()` is sufficient for fairness; a production-grade RNG
 *  swap can happen here without touching any caller. */
export function rollRandomTarget(random: () => number = Math.random): number {
  const range = MAX_TARGET_MS - MIN_TARGET_MS + 1;
  return MIN_TARGET_MS + Math.floor(random() * range);
}

/** Server-rolled cryptographic nonce for a round. Uses Web Crypto when
 *  available (Node 19+, modern browsers) and falls back to a high-entropy
 *  base-36 token. Clients must echo it back with their stop packet; the
 *  server rejects any mismatch, which is what makes a cross-round replay
 *  impossible even if an attacker guesses the `roundId`. */
export function generateRoundNonce(): string {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Transition a match into the `arming` phase, in place.
 *
 *  Stamps the countdown window (`armingStartedAt` + `countdownEndsAt` —
 *  clients render the live countdown from the absolute end instant so both
 *  screens stay in sync), bumps the monotonic `roundSequence`, and stamps a
 *  fresh `roundId` / `roundNonce` envelope.
 *
 *  `revealMs` is the round-result cooldown the countdown must WAIT BEHIND
 *  (0 for the first round, `ROUND_RESULT_REVEAL_MS` for every round that
 *  follows a decision). It is folded into `countdownEndsAt` rather than stored
 *  separately: the round opens at one absolute instant, and both sides can
 *  order the two windows from it alone (`countdownEndsAt - ROUND_COUNTDOWN_MS`
 *  is the instant the countdown itself begins). Without the gate the countdown
 *  started while the round-result overlay was still up, so the round could
 *  open behind it — the timer was already running when the player got their
 *  screen back.
 *
 *  `state.targetMs` is deliberately set to null: the rolled target stays in
 *  the server-only column until the reveal, so a client cannot pre-read it
 *  during the countdown.
 *
 *  NOTE — there is no timer here (and none anywhere anymore). When the
 *  countdown elapses, the next read performs `revealArmedRoundState`. */
export function armRoundState(
  state: PrecisionState,
  nonce: string,
  nowMs: number = Date.now(),
  revealMs: number = 0,
): void {
  const reveal = Number.isFinite(revealMs) ? Math.max(0, Math.floor(revealMs)) : 0;
  state.phase = "arming";
  state.armingStartedAt = nowMs;
  state.countdownEndsAt = nowMs + reveal + ROUND_COUNTDOWN_MS;
  state.targetMs = null;
  // The previous round's bot stop (AI practice only) belongs to the round
  // that just ended — clear it so the new round starts with both rockets
  // on the launch pad.
  state.aiStop = null;
  state.roundSequence = (state.roundSequence ?? 0) + 1;
  state.roundId = `m-${state.matchId}-r-${state.roundSequence}`;
  state.roundNonce = nonce;
  state.version += 1;
}

/** True when an armed round's countdown has elapsed and the round must be
 *  revealed. A no-op for every other phase, and for a match that already
 *  has a declared winner. */
export function isArmedRoundDue(
  state: PrecisionState,
  nowMs: number = Date.now(),
): boolean {
  if (state.phase !== "arming") return false;
  if (state.winnerSeat !== null) return false;
  const endsAt = state.countdownEndsAt;
  if (typeof endsAt !== "number" || endsAt > nowMs) return false;
  return true;
}

/** Reveal an armed round, in place: flip to `active`, publish the rolled
 *  target, stamp the authoritative GO instant, and drop the countdown
 *  stamps.
 *
 *  `roundGoInstant` is the ONLY clock source for scoring — `elapsedMs` is
 *  `stopInstant - roundGoInstant`. `roundId` / `roundNonce` intentionally
 *  stay populated for the whole round so clients can echo them back.
 *
 *  Idempotent and state-guarded by the caller (`isArmedRoundDue`). */
export function revealArmedRoundState(
  state: PrecisionState,
  targetMs: number,
  nowMs: number = Date.now(),
): void {
  state.phase = "active";
  state.targetMs = targetMs;
  state.armingStartedAt = null;
  state.countdownEndsAt = null;
  state.roundGoInstant = nowMs;
  state.version += 1;
}

/** Server-measured telemetry for a stop that just arrived. `diffMs` starts
 *  at 0 and is graded once both seats have submitted (the target is
 *  irrelevant until the round is decided). */
export function computeStopTelemetry(
  roundGoInstant: number,
  stopInstant: number,
): PrecisionStopTelemetry {
  return {
    stopInstant,
    elapsedMs: stopInstant - roundGoInstant,
    diffMs: 0,
  };
}

/** True when a server-measured elapsed is inside the accepted window. The
 *  route rejects anything outside it, so a pathological clock or a
 *  programmatic stop can never reach the scoring maths. */
export function isStopElapsedInRange(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= MIN_STOP_MS && elapsedMs <= MAX_STOP_MS;
}

/**
 * The elapsed a STOP is finally GRADED at — the CLICK instant.
 *
 * `clientElapsedMs` is the elapsed the player's client froze the moment they
 * hit STOP. It is measured on the server's own clock frame (`roundClock.ts`
 * anchors the display to the server's GO instant and corrects for the device's
 * clock skew), so it is directly comparable with the server's own measurement
 * and is exactly the number the player was watching when they clicked.
 *
 * It is authoritative, because anything else grades the player on a number
 * their screen never showed them:
 *
 *   * `serverElapsedMs` is `arrival - roundGoInstant`, i.e. the click PLUS the
 *     whole delivery (browser → realtime server → route, then any retry). That
 *     lag is not the player's reaction time and must not be charged to it. A
 *     bounded credit could not fix that — it only capped the damage, so any
 *     delay past the allowance (a dead socket falling back to HTTPS costs
 *     seconds) still landed in full on the score, turning a dead-on click into
 *     a miss and declaring the wrong winner.
 *
 * Only two bounds survive, and both are physical rather than budgeted:
 *   * never LATER than the server's own measurement — a stop cannot have
 *     happened after we had already received it. A claim past it (a device
 *     clock skewed high, or a fabricated value) is discarded in favour of our
 *     measurement.
 *   * never below `MIN_STOP_MS` — a pathological 0 is not a stop anyone made,
 *     and the floor is what keeps a programmatic instant out of the scoring
 *     maths. Anything unusable (missing, non-finite, below the floor) falls
 *     back to the server's measurement, so a client that reports nothing is
 *     graded exactly as it was before `elapsedMs` existed.
 *
 * The unverifiable surface is unchanged in kind from the old credit: the
 * allowance only ever bounded how far a client could move its own stop, and
 * the stop it moves is still one it had to wait out on a clock the server
 * anchored. A credit larger than a fixed allowance is the price of not
 * silently charging honest players for the network; `STOP_LAG_ANOMALY_MS`
 * keeps an observational record of how much of it is actually being asked for.
 */
export function resolveStopElapsedMs(input: {
  /** Server-measured elapsed: arrival instant minus the round's GO. */
  serverElapsedMs: number;
  /** The client's frozen elapsed at the click, or null/undefined. */
  clientElapsedMs?: number | null;
}): number {
  const { serverElapsedMs, clientElapsedMs } = input;
  if (!Number.isFinite(serverElapsedMs)) return serverElapsedMs;
  // The click instant, bounded only by "not after we received it".
  const graded =
    !Number.isFinite(clientElapsedMs) || Number(clientElapsedMs) < MIN_STOP_MS
      ? serverElapsedMs
      : Math.min(serverElapsedMs, Number(clientElapsedMs));
  // The floor is applied LAST and never raises a below-floor arrival into a
  // recordable stop on its own account: it keeps this function's contract
  // (`>= MIN_STOP_MS`) identical to before, and the caller's range check is
  // still what decides whether an out-of-bounds packet is dropped.
  return Math.max(MIN_STOP_MS, graded);
}

/**
 * How much delivery lag a graded stop was credited, in ms: the gap between the
 * instant we received the packet and the instant the player actually clicked.
 *
 * Observational only. It exists so the store can keep a record of how much lag
 * is really being asked for — the credit is no longer capped by a fixed
 * allowance, so a spike here is the signal that something is wrong on the wire
 * (rather than, as before, silently being charged to the player's score).
 */
export function stopDeliveryLagMs(
  serverElapsedMs: number,
  gradedElapsedMs: number,
): number {
  if (!Number.isFinite(serverElapsedMs) || !Number.isFinite(gradedElapsedMs)) return 0;
  return Math.max(0, serverElapsedMs - gradedElapsedMs);
}

export interface EvaluateRoundInput {
  score: PrecisionScore;
  seat1: { userId: string; stop: PrecisionStopTelemetry };
  seat2: { userId: string; stop: PrecisionStopTelemetry };
  /** The round's revealed target — server-stamped, never client-supplied. */
  targetMs: number;
}

export interface EvaluateRoundResult {
  /** Round winner, or null on a true tie (which replays the round). */
  roundWinnerSeat: PlayerSeat | null;
  /** Score AFTER applying the round (unchanged on a tie). */
  score: PrecisionScore;
  /** True once a seat reached `TARGET_WINS`. */
  matchFinished: boolean;
  /** Seat that took the MATCH when `matchFinished` — higher score wins a
   *  pathological double-reach. */
  matchWinnerSeat: PlayerSeat | null;
  /** Per-seat telemetry for the decided round, graded with `diffMs`. */
  lastRoundStops: NonNullable<PrecisionState["lastRoundStops"]>;
  /** The target the decided round was graded against. Carried on the result
   *  so the server can stamp it onto the public state together with the
   *  stops — a client can then render the round-result reveal from the
   *  decision snapshot ALONE, without having had to observe the round's live
   *  `targetMs` first (fresh mount, reconnect, or a poll that landed after
   *  the round closed). */
  lastRoundTargetMs: number;
}

/** Decide a round from the two server-stamped stops. Pure — no mutation of
 *  the inputs — and the single place the round/win rules exist.
 *
 *  Rules:
 *    * the seat with the SMALLEST `|elapsed - target|` takes the round;
 *    * equal diffs (including a byte-identical race) are a TIE — the same
 *      `currentRound` is re-armed with a fresh target and envelope;
 *    * the first seat to `TARGET_WINS` rounds ends the match. */
export function evaluateRound(input: EvaluateRoundInput): EvaluateRoundResult {
  const { score, seat1, seat2, targetMs } = input;
  const diff1 = Math.abs(seat1.stop.elapsedMs - targetMs);
  const diff2 = Math.abs(seat2.stop.elapsedMs - targetMs);
  const graded1: PrecisionStopTelemetry = { ...seat1.stop, diffMs: diff1 };
  const graded2: PrecisionStopTelemetry = { ...seat2.stop, diffMs: diff2 };

  let roundWinnerSeat: PlayerSeat | null = null;
  if (diff1 < diff2) roundWinnerSeat = 1;
  else if (diff2 < diff1) roundWinnerSeat = 2;

  const newScore: PrecisionScore = { ...score };
  if (roundWinnerSeat === 1) newScore.seat1 += 1;
  else if (roundWinnerSeat === 2) newScore.seat2 += 1;

  const matchFinished =
    newScore.seat1 >= TARGET_WINS || newScore.seat2 >= TARGET_WINS;

  let matchWinnerSeat: PlayerSeat | null = null;
  if (matchFinished) {
    const seat1Won = newScore.seat1 >= TARGET_WINS;
    const seat2Won = newScore.seat2 >= TARGET_WINS;
    if (seat1Won && !seat2Won) matchWinnerSeat = 1;
    else if (seat2Won && !seat1Won) matchWinnerSeat = 2;
    else if (seat1Won && seat2Won) {
      matchWinnerSeat =
        newScore.seat1 > newScore.seat2
          ? 1
          : newScore.seat2 > newScore.seat1
            ? 2
            : roundWinnerSeat;
    }
  }

  return {
    roundWinnerSeat,
    score: newScore,
    matchFinished,
    matchWinnerSeat,
    lastRoundTargetMs: targetMs,
    lastRoundStops: {
      seat1: {
        stopInstant: graded1.stopInstant,
        elapsedMs: graded1.elapsedMs,
        diffMs: graded1.diffMs,
        userId: seat1.userId,
      },
      seat2: {
        stopInstant: graded2.stopInstant,
        elapsedMs: graded2.elapsedMs,
        diffMs: graded2.diffMs,
        userId: seat2.userId,
      },
    },
  };
}

/** Persist the outcome of a decided round onto the state, in place. Callers
 *  then either finish the match or arm the next round. */
export function applyRoundResult(
  state: PrecisionState,
  result: EvaluateRoundResult,
): void {
  state.score = result.score;
  state.lastRoundWinnerSeat = result.roundWinnerSeat;
  state.lastRoundStops = result.lastRoundStops;
  // The target this round was graded against. Kept across the next arm (like
  // `lastRoundStops`) so the reveal + end-of-match recap always have it.
  state.lastRoundTargetMs = result.lastRoundTargetMs;
  state.version += 1;
}

/** Close the match out, in place: declare the winner, clear the arming
 *  stamps and the round-replay envelope so a late packet can't be replayed
 *  against a finished match. */
export function finishMatchState(
  state: PrecisionState,
  winnerSeat: PlayerSeat | null,
): void {
  state.winnerSeat = winnerSeat;
  state.phase = "finished";
  state.armingStartedAt = null;
  state.countdownEndsAt = null;
  state.roundId = null;
  state.roundNonce = null;
  state.targetMs = null;
  state.aiStop = null;
  state.version += 1;
}
