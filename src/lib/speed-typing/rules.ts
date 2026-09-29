// src/lib/speed-typing/rules.ts
//
// The PURE race rules for Speed Typing — no database, no clock of its own, no
// socket. Every function takes the state (or a row) plus the server's own
// instants as arguments, so each rule is testable as arithmetic rather than by
// racing two browsers.
//
// THIS IS THE TRUST BOUNDARY of the whole game, and the model is one sentence:
//
//   a client may only ever say WHAT IT TYPED. Everything else — how far that
//   is, whether it is correct, when it happened, whether the race is over, who
//   won, the final WPM, the rating, the trophies — is derived here and in
//   ./serverStore.ts from the server's own passage and the server's own clock.
//
// There is therefore no function anywhere that accepts a winner, a completion
// time, a progress count, a WPM, an Elo delta or a trophy count from a caller.
// `verifyTypedText` is the only way progress is ever produced, and it needs the
// server's passage to do it.
//
// The state shape below is what lands in `speed_typing_matches.race_state`
// (jsonb) and what the denormalised `player*_chars_typed` / `player*_errors` /
// `player*_completed_at` columns mirror. Keystrokes are NEVER rows: a race
// writes a bounded stream of throttled checkpoints plus at most one verified
// finish per seat.

import {
  DEAD_HEAT_TOLERANCE_MS,
  PROGRESS_MIN_ADVANCE,
  RACE_LIMIT_MS,
  RESOLUTION,
  SEAT,
  type ResolutionReason,
  type SeatKey,
} from "./constants";
import { passageForRow, passageMeta, type PassageMeta } from "./passages";

/** The authoritative per-seat race state. */
export type SeatRace = {
  /** How far into the passage this seat has got, per the server's own compare. */
  charsTyped: number;
  /** Wrong characters typed at the furthest prefix seen. Never decreases. */
  errors: number;
  /** True once the seat's submission verified as the complete passage. */
  finished: boolean;
  /** Server instant of the verified finish, or null. */
  finishedAtMs: number | null;
  /** Frozen server-derived elapsed ms at finish (null until finished). */
  elapsedMs: number | null;
  /** Frozen server-derived words-per-minute at finish (null until finished). */
  wpm: number | null;
  /** Frozen server-derived accuracy percentage at finish (null until finished). */
  accuracy: number | null;
  /** True when the seat left/disconnected and the race was decided without it. */
  forfeited: boolean;
  /** Server instant of the last authoritative write for this seat. */
  updatedAtMs: number;
};

/** The authoritative race state persisted on the match row. */
export type RaceState = {
  /** Monotonic per authoritative write; mirrors `speed_typing_matches.revision`. */
  version: number;
  seats: Record<SeatKey, SeatRace>;
  /** Server instant the race ended, or null while it is live. */
  resolvedAtMs: number | null;
  /** How it ended. Null while live. */
  resolutionReason: ResolutionReason | null;
};

export type RaceVerification = {
  /** Cursor position: characters of the passage reached, capped at its length. */
  charsTyped: number;
  /** How many of those characters were wrong. Never exceeds `charsTyped`. */
  errors: number;
  /** How many of them were right (`charsTyped - errors`) — the WPM numerator. */
  correctChars: number;
  /** True only when the submission IS the complete passage. */
  ok: boolean;
  /** Index of the first wrong character, or -1. Useful for a 409 message. */
  firstMismatch: number;
  /** The passage length, so a caller never has to re-measure it. */
  length: number;
};

export type RaceOutcome = {
  /** True when the race is over and a result should be recorded. */
  settled: boolean;
  /** "player1" | "player2", or null for a genuine dead heat. */
  winnerSeat: SeatKey | null;
  /** How the server ended it (only meaningful when `settled`). */
  resolutionReason: ResolutionReason | null;
  /** Server instant of resolution. */
  resolvedAtMs: number | null;
};

/** A read model for ONE participant. Never built for a non-participant. */
export type RaceView = {
  passageId: string | null;
  passageVersion: number | null;
  /** The exact text both seats race on. Participant-only, by construction. */
  passageText: string;
  /**
   * Non-secret metadata for that text (difficulty, language, size). The
   * selection inputs — the race seed and the catalog index — are NOT here: a
   * client is told which prompt it races, never how the server chose it.
   */
  prompt: PassageMeta | null;
  /** Absolute server instants: when typing opens, and when it is too late. */
  goAtMs: number | null;
  deadlineMs: number;
  /** The viewer's own seat: 1 | 2. */
  seat: 1 | 2;
  seatKey: SeatKey;
  /** The viewer's own authoritative state, and the opponent's public one. */
  you: SeatRace;
  opponent: SeatRace;
  /** Live server-derived numbers for both seats (never client-supplied). */
  metrics: {
    you: { elapsedMs: number; wpm: number; accuracy: number; remainingMs: number };
    opponent: { elapsedMs: number; wpm: number; accuracy: number; remainingMs: number };
  };
  /** Monotonic row revision, so a stale client can tell it is stale. */
  revision: number;
  resolvedAtMs: number | null;
  resolutionReason: ResolutionReason | null;
};

// ── Numeric hygiene ───────────────────────────────────────────────────────

/** A non-negative finite integer, or 0. Every stored count passes through here. */
export function coerceCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function coerceInstant(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * A stored FINAL metric (elapsed, WPM, accuracy), or null when it is absent or
 * not a finite, non-negative number.
 *
 * Distinct from `coerceCount`: an unreadable elapsed time must read as "not
 * recorded", never as 0 — a race that finished in zero milliseconds and a race
 * whose numbers are missing are different facts.
 */
function coerceMetric(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** An empty per-seat state. */
export function emptySeatRace(): SeatRace {
  return {
    charsTyped: 0,
    errors: 0,
    finished: false,
    finishedAtMs: null,
    elapsedMs: null,
    wpm: null,
    accuracy: null,
    forfeited: false,
    updatedAtMs: 0,
  };
}

/** A fresh race state for a match that has just been armed. */
export function createRaceState({ version = 0 } = {}): RaceState {
  return {
    version: coerceCount(version),
    seats: { [SEAT.PLAYER1]: emptySeatRace(), [SEAT.PLAYER2]: emptySeatRace() },
    resolvedAtMs: null,
    resolutionReason: null,
  };
}

/**
 * Tolerant parse of a stored race state.
 *
 * Every field is coerced, so a legacy row (no race state at all), a partially
 * written state, or anything a human edited by hand can never make the rules
 * throw — an unreadable state simply reads as an empty race.
 */
export function coerceRaceState(raw: unknown): RaceState {
  const base = createRaceState();
  if (!raw || typeof raw !== "object") return base;
  const source = raw as Partial<RaceState> & { seats?: Record<string, unknown> };
  const seats = (source.seats ?? {}) as Record<string, unknown>;

  for (const seat of [SEAT.PLAYER1, SEAT.PLAYER2] as const) {
    const value = seats[seat];
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<SeatRace>;
    base.seats[seat] = {
      charsTyped: coerceCount(entry.charsTyped),
      errors: coerceCount(entry.errors),
      finished: entry.finished === true,
      finishedAtMs: coerceInstant(entry.finishedAtMs),
      elapsedMs: coerceMetric(entry.elapsedMs),
      wpm: coerceMetric(entry.wpm),
      accuracy: coerceMetric(entry.accuracy),
      forfeited: entry.forfeited === true,
      updatedAtMs: coerceCount(entry.updatedAtMs),
    };
  }

  base.version = coerceCount(source.version);
  base.resolvedAtMs = coerceInstant(source.resolvedAtMs);
  base.resolutionReason =
    source.resolutionReason == null ? null : (String(source.resolutionReason) as ResolutionReason);
  return base;
}

// ── Seats ─────────────────────────────────────────────────────────────────

/** Which seat `userId` occupies, or null when they are not in this match. */
export function seatForUser(
  match: { player1Id?: unknown; player2Id?: unknown },
  userId: unknown,
): SeatKey | null {
  if (typeof userId !== "string" || !userId) return null;
  if (match.player1Id === userId) return SEAT.PLAYER1;
  if (match.player2Id === userId) return SEAT.PLAYER2;
  return null;
}

/** The other seat. Only ever called with a seat that exists. */
export function oppositeSeat(seat: SeatKey): SeatKey {
  return seat === SEAT.PLAYER1 ? SEAT.PLAYER2 : SEAT.PLAYER1;
}

/** The clerk id occupying a seat, or null when the seat is empty. */
export function userIdForSeat(
  match: { player1Id?: unknown; player2Id?: unknown },
  seat: SeatKey,
): string | null {
  const value = seat === SEAT.PLAYER1 ? match.player1Id : match.player2Id;
  return typeof value === "string" && value ? value : null;
}

/** 1-based seat number, as the DTO speaks about it. */
export function seatNumber(seat: SeatKey): 1 | 2 {
  return seat === SEAT.PLAYER1 ? 1 : 2;
}

// ── The server clock ──────────────────────────────────────────────────────

/** The absolute server instant a match's race closes at. */
export function raceDeadlineMs(
  match: { goAt?: unknown },
  limitMs = RACE_LIMIT_MS,
): number {
  const goAt = instantFromDate(match?.goAt);
  if (goAt == null) return 0;
  return goAt + limitMs;
}

/** A `Date` or ms number or ISO string → ms, or null. Never throws. */
export function instantFromDate(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return coerceInstant(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The number of characters a seat has typed CORRECTLY: its cursor position
 * minus every mistake it has made.
 *
 * Both inputs are monotonic (see `evaluateCheckpoint`) and `errors` can never
 * exceed `charsTyped`, so this is a clean, non-negative measure of "how much of
 * the passage does this seat really have". It is the character count behind WPM
 * and accuracy, and — because a clock-decided race must reward typing rather
 * than key-mashing — the measure `resolveRace` compares at the deadline. A seat
 * that sprays characters it never gets right gains nothing here.
 */
export function correctCharsFor(
  seat: Pick<SeatRace, "charsTyped" | "errors"> | null | undefined,
): number {
  return Math.max(0, coerceCount(seat?.charsTyped) - coerceCount(seat?.errors));
}

/**
 * Server-derived race numbers for one seat.
 *
 * `elapsedMs` is measured from the SERVER's GO instant to the SERVER's now (or
 * to the frozen finish instant). It is the only completion time this game has;
 * a client never supplies one.
 *
 * WPM uses the standard convention — five characters to a word, over elapsed
 * minutes — and counts only CORRECT characters, so spraying keys fast cannot
 * beat typing accurately. Accuracy is correct ÷ typed (both server-derived).
 */
export function raceMetrics({
  seat,
  goAtMs,
  nowMs,
}: {
  seat: SeatRace;
  goAtMs: number | null;
  nowMs: number;
}): { elapsedMs: number; wpm: number; accuracy: number; remainingMs: number } {
  const from = goAtMs == null ? null : goAtMs;
  const endMs = seat.finishedAtMs ?? nowMs;
  const elapsedMs =
    from == null || endMs == null ? 0 : Math.max(0, Math.floor(endMs - from));
  const correctChars = correctCharsFor(seat);
  const minutes = elapsedMs > 0 ? elapsedMs / 60_000 : 0;
  const wpm = minutes > 0 ? Math.round(correctChars / 5 / minutes) : 0;
  const typed = coerceCount(seat.charsTyped);
  const accuracy = typed > 0 ? Math.round((correctChars / typed) * 100) : 0;
  const remainingMs = from == null ? 0 : Math.max(0, from + RACE_LIMIT_MS - nowMs);
  return { elapsedMs, wpm, accuracy, remainingMs };
}

// ── Verification (the ONE way progress is produced) ────────────────────────

/**
 * Normalise a submission for comparison.
 *
 * Bare CR is dropped and CRLF becomes LF, so a client's line-ending convention
 * cannot cost a rated race; everything else is compared EXACTLY, including
 * spacing and punctuation. No case folding, no whitespace collapsing: the race
 * is "type this text", not "type something like it".
 */
export function normalizeTypedText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Compare what a seat typed against the SERVER's passage.
 *
 * This is the only function that turns client input into progress, and it needs
 * the server's own text to do it.
 *
 * THE TYPING RULES (decided here, once, for the whole game):
 *
 *   * The comparison is EXACT and positional: `typed[i]` must equal
 *     `passage[i]` at the same index. No case folding, no whitespace
 *     collapsing, no Unicode normalisation — the race is "type this text", not
 *     "type something like it". CRLF is the one exception (see
 *     `normalizeTypedText`), because a client's line-ending convention must not
 *     cost a rated race.
 *   * `charsTyped` is the CURSOR position: how far into the passage the
 *     submission reaches, capped at the passage length, so text past the end
 *     can neither help nor be double-counted.
 *   * `errors` counts every position in that span that does NOT match, and
 *     `correctChars = charsTyped - errors`. The pair is what the seat's WPM and
 *     accuracy are derived from — never a number the client sent.
 *   * Completion (`ok`) requires the WHOLE passage, exactly: every position
 *     matched AND the submission reached the end. One wrong character anywhere
 *     means "not complete", which is what makes correcting a mistake the only
 *     way to finish.
 *   * BACKSPACE AND CORRECTION are therefore first-class, harmless actions. A
 *     player who deletes and retypes sends a SHORTER `typedText`; the
 *     authoritative counters are monotonic, so that can never rewind progress
 *     and can never erase the mistake it fixes (see `evaluateCheckpoint`). The
 *     error stays on the record for the rest of the race: accuracy measures the
 *     whole attempt, not its final frame.
 *   * UNICODE is compared as UTF-16 code units — exactly what a browser's
 *     `input.value` and an index are. An astral character costs two positions.
 *     The shipped catalog is ASCII-only (enforced by
 *     tests/speed-typing-race.test.mjs), so this only ever matters for
 *     malformed client input, which it must never throw on.
 */
export function verifyTypedText({
  passageText,
  typedText,
}: {
  passageText: unknown;
  typedText: unknown;
}): RaceVerification {
  const passage = normalizeTypedText(passageText);
  const typed = normalizeTypedText(typedText);
  const length = passage.length;

  let firstMismatch = -1;
  let matched = 0;
  const capped = typed.slice(0, length);
  for (let i = 0; i < capped.length; i += 1) {
    if (capped[i] !== passage[i]) {
      if (firstMismatch === -1) firstMismatch = i;
    } else {
      matched += 1;
    }
  }

  const charsTyped = capped.length;
  const errors = Math.max(0, charsTyped - matched);
  const ok = firstMismatch === -1 && charsTyped === length && length > 0;

  return { charsTyped, errors, correctChars: matched, ok, firstMismatch, length };
}

// ── Checkpoints (throttled, monotonic, never a row per keystroke) ──────────

export type CheckpointDecision = {
  accept: boolean;
  reason:
    | "accepted"
    | "resolved"
    | "seat_closed"
    | "before_go"
    | "past_deadline"
    | "unarmed"
    | "no_advance"
    | "below_threshold";
  seat: SeatRace;
};

/**
 * Whether a checkpoint is worth persisting, and what it would store.
 *
 * Rejections are deliberate and cheap — the socket layer calls this at whatever
 * rate keystrokes arrive, and the store only writes when this says `accepted`,
 * which is why a race costs a handful of writes instead of thousands:
 *
 *   * nothing before GO is counted, so a client cannot pre-buffer the passage
 *     and submit it complete the instant the race opens;
 *   * nothing after the deadline is counted (the deadline resolution owns it);
 *   * a seat that has finished or forfeited is closed;
 *   * a resolved race accepts nothing at all;
 *   * `charsTyped` is MONOTONIC — a later, shorter submission can never move a
 *     seat backwards, so a burst of out-of-order packets is harmless;
 *   * `errors` is monotonic too: fixing a letter does not erase the fact it was
 *     mistyped, so accuracy reflects the whole race rather than the last frame.
 */
export function evaluateCheckpoint({
  state,
  seat,
  verification,
  nowMs,
  goAtMs,
  minAdvance = PROGRESS_MIN_ADVANCE,
}: {
  state: RaceState;
  seat: SeatKey;
  verification: RaceVerification;
  nowMs: number;
  goAtMs: number | null;
  minAdvance?: number;
}): CheckpointDecision {
  const current = state.seats[seat] ?? emptySeatRace();
  const deny = (reason: CheckpointDecision["reason"]): CheckpointDecision => ({
    accept: false,
    reason,
    seat: current,
  });

  if (state.resolvedAtMs != null) return deny("resolved");
  if (goAtMs == null) return deny("unarmed");
  if (current.finished || current.forfeited) return deny("seat_closed");
  if (nowMs < goAtMs) return deny("before_go");
  if (nowMs > goAtMs + RACE_LIMIT_MS) return deny("past_deadline");

  const charsTyped = Math.max(current.charsTyped, coerceCount(verification.charsTyped));
  const errors = Math.max(current.errors, coerceCount(verification.errors));
  if (charsTyped === current.charsTyped && errors === current.errors) {
    return deny("no_advance");
  }
  if (charsTyped - current.charsTyped < coerceCount(minAdvance) && !verification.ok) {
    return deny("below_threshold");
  }

  return {
    accept: true,
    reason: "accepted",
    seat: { ...current, charsTyped, errors, updatedAtMs: Math.floor(nowMs) },
  };
}

// ── Finishing ─────────────────────────────────────────────────────────────

export type FinishDecision = {
  accept: boolean;
  reason:
    | "accepted"
    | "duplicate"
    | "resolved"
    | "seat_closed"
    | "before_go"
    | "past_deadline"
    | "unarmed"
    | "incomplete";
  seat: SeatRace;
  /** First wrong character index from the submission, or -1. */
  firstMismatch: number;
};

/**
 * Whether a finish submission is accepted, and the frozen seat state it stores.
 *
 * A finish is accepted only when the submitted text IS the passage, checked
 * against the text the server resolved for this match. A repeat submission from
 * a seat that already finished is `duplicate` — the row lock in the store plus
 * this check is what makes a replayed finish a no-op instead of a second result.
 *
 * The frozen `elapsedMs` / `wpm` / `accuracy` are computed HERE, from the
 * server's GO instant and the server's current instant. They are written once
 * and never recomputed from anything a client said.
 */
export function evaluateFinish({
  state,
  seat,
  verification,
  nowMs,
  goAtMs,
}: {
  state: RaceState;
  seat: SeatKey;
  verification: RaceVerification;
  nowMs: number;
  goAtMs: number | null;
}): FinishDecision {
  const current = state.seats[seat] ?? emptySeatRace();
  const deny = (
    reason: FinishDecision["reason"],
    firstMismatch = verification.firstMismatch,
  ): FinishDecision => ({ accept: false, reason, seat: current, firstMismatch });

  if (state.resolvedAtMs != null) return deny("resolved");
  if (goAtMs == null) return deny("unarmed");
  if (current.forfeited) return deny("seat_closed");
  // Already finished: the stored verdict stands (idempotency, at the rule level).
  if (current.finished) return deny("duplicate");
  if (nowMs < goAtMs) return deny("before_go");
  if (nowMs > goAtMs + RACE_LIMIT_MS) return deny("past_deadline");
  if (!verification.ok) return deny("incomplete");

  // The race's error count is carried forward, so the frozen accuracy reflects
  // every mistake made on the way — not just the ones in the final submission.
  const errors = Math.max(current.errors, verification.errors);
  const metrics = raceMetrics({
    seat: { ...current, charsTyped: verification.length, errors, finishedAtMs: Math.floor(nowMs) },
    goAtMs,
    nowMs,
  });

  return {
    accept: true,
    reason: "accepted",
    firstMismatch: -1,
    seat: {
      charsTyped: verification.length,
      errors,
      finished: true,
      finishedAtMs: Math.floor(nowMs),
      elapsedMs: metrics.elapsedMs,
      wpm: metrics.wpm,
      accuracy: metrics.accuracy,
      forfeited: false,
      updatedAtMs: Math.floor(nowMs),
    },
  };
}

/** Freeze the seat a FORFEIT closes out, preserving whatever progress it had. */
export function forfeitSeatRace(seat: SeatRace, nowMs: number): SeatRace {
  return { ...seat, forfeited: true, updatedAtMs: Math.floor(nowMs) };
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * The race's verdict, from the authoritative state only.
 *
 * `reason` says WHY we are resolving (both finished / the limit passed / a seat
 * left), and the rule for each is fixed:
 *
 *   * both finished → the EARLIER verified finish wins. A gap at or under
 *     DEAD_HEAT_TOLERANCE_MS is a photo-finish: a draw, so the result never
 *     turns on which packet arrived first;
 *   * one finished, the other did not → the finished seat wins;
 *   * a forfeit → the seat still present wins (both forfeited → a draw);
 *   * the deadline → the seat with more CORRECTLY typed characters wins (see
 *     `correctCharsFor`); a dead level is a draw, as is a race where nobody
 *     typed anything at all.
 */
export function resolveRace({
  state,
  reason,
  nowMs,
}: {
  state: RaceState;
  reason: ResolutionReason;
  nowMs: number;
}): RaceOutcome {
  const p1 = state.seats[SEAT.PLAYER1] ?? emptySeatRace();
  const p2 = state.seats[SEAT.PLAYER2] ?? emptySeatRace();
  const at = Math.floor(nowMs);
  const done = (outcome: Partial<RaceOutcome> & { settled: boolean }): RaceOutcome => ({
    winnerSeat: null,
    resolutionReason: null,
    resolvedAtMs: at,
    ...outcome,
  });

  // A seat that left hands the race to the other one, unless both left.
  if (p1.forfeited && p2.forfeited) {
    return done({ settled: true, winnerSeat: null, resolutionReason: RESOLUTION.DRAW });
  }
  if (p1.forfeited) {
    return done({ settled: true, winnerSeat: SEAT.PLAYER2, resolutionReason: RESOLUTION.FORFEIT });
  }
  if (p2.forfeited) {
    return done({ settled: true, winnerSeat: SEAT.PLAYER1, resolutionReason: RESOLUTION.FORFEIT });
  }

  const finished = [p1, p2].filter((seat) => seat.finished).length;
  if (finished === 2) {
    const gap = Math.abs((p1.finishedAtMs ?? 0) - (p2.finishedAtMs ?? 0));
    if (gap <= DEAD_HEAT_TOLERANCE_MS) {
      return done({ settled: true, winnerSeat: null, resolutionReason: RESOLUTION.DRAW });
    }
    const winnerSeat =
      (p1.finishedAtMs ?? Number.MAX_SAFE_INTEGER) < (p2.finishedAtMs ?? Number.MAX_SAFE_INTEGER)
        ? SEAT.PLAYER1
        : SEAT.PLAYER2;
    return done({ settled: true, winnerSeat, resolutionReason: RESOLUTION.FINISH });
  }
  if (finished === 1) {
    return done({
      settled: true,
      winnerSeat: p1.finished ? SEAT.PLAYER1 : SEAT.PLAYER2,
      resolutionReason: reason === RESOLUTION.FORFEIT ? RESOLUTION.FORFEIT : RESOLUTION.FINISH,
    });
  }

  // Nobody finished: the deadline decides on CORRECT progress, not on how many
  // keys were pressed. Comparing raw `charsTyped` would let a seat win the clock
  // by spraying characters it never got right; comparing `charsTyped - errors`
  // means a mash of 300 wrong characters loses to an honest 20. A dead level is
  // still a draw.
  const p1Correct = correctCharsFor(p1);
  const p2Correct = correctCharsFor(p2);
  if (p1Correct === p2Correct) {
    return done({ settled: true, winnerSeat: null, resolutionReason: RESOLUTION.DRAW });
  }
  return done({
    settled: true,
    winnerSeat: p1Correct > p2Correct ? SEAT.PLAYER1 : SEAT.PLAYER2,
    resolutionReason: RESOLUTION.DEADLINE,
  });
}

/** True when the race is armed (has a GO instant) but not yet resolved. */
export function isRaceLive(
  match: { status?: unknown; goAt?: unknown; raceState?: unknown },
  nowMs: number,
): boolean {
  const state = coerceRaceState(match?.raceState);
  if (state.resolvedAtMs != null) return false;
  const goAt = instantFromDate(match?.goAt);
  if (goAt == null) return false;
  return nowMs <= goAt + RACE_LIMIT_MS && String(match?.status) === "playing";
}

/** True when the hard limit has passed for an armed, unresolved race. */
export function isRaceDue(
  match: { goAt?: unknown; raceState?: unknown },
  nowMs: number,
): boolean {
  const state = coerceRaceState(match?.raceState);
  if (state.resolvedAtMs != null) return false;
  const goAt = instantFromDate(match?.goAt);
  if (goAt == null) return false;
  return nowMs >= goAt + RACE_LIMIT_MS;
}

// ── Read model ────────────────────────────────────────────────────────────

/**
 * The participant view of a race.
 *
 * Callers must resolve the seat first: `matchViewFor` in ./serverStore.ts only
 * builds this for a real participant, which is the ONLY place the passage text
 * leaves the server. A non-participant gets no race object at all rather than a
 * redacted one, so there is no way to forget to strip a field.
 */
export function raceViewFor({
  match,
  seat,
  nowMs,
}: {
  match: {
    goAt?: unknown;
    revision?: unknown;
    raceState?: unknown;
    passageId?: unknown;
    passageVersion?: unknown;
    raceSeed?: unknown;
  };
  seat: SeatKey;
  nowMs: number;
}): RaceView {
  const state = coerceRaceState(match?.raceState);
  const goAtMs = instantFromDate(match?.goAt);
  const you = state.seats[seat] ?? emptySeatRace();
  const opponent = state.seats[oppositeSeat(seat)] ?? emptySeatRace();
  const passage = passageForRow(match);

  return {
    passageId: passage?.id ?? null,
    passageVersion: passage ? Number(match?.passageVersion ?? null) || null : null,
    passageText: passage?.text ?? "",
    prompt: passageMeta(passage),
    goAtMs,
    deadlineMs: goAtMs == null ? 0 : goAtMs + RACE_LIMIT_MS,
    seat: seatNumber(seat),
    seatKey: seat,
    you,
    opponent,
    metrics: {
      you: raceMetrics({ seat: you, goAtMs, nowMs }),
      opponent: raceMetrics({ seat: opponent, goAtMs, nowMs }),
    },
    revision: coerceCount(match?.revision),
    resolvedAtMs: state.resolvedAtMs,
    resolutionReason: state.resolutionReason,
  };
}
