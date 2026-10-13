/**
 * Speed Typing performance evaluator (src/lib/speed-typing/*).
 *
 * WHY THIS IS A PERFORMANCE REPORT, NOT AN "EXACT" ONE
 * ---------------------------------------------------
 * Speed Typing is not a game of moves: there is nothing to search and no
 * objectively better action (the passage is fixed and the fastest correct
 * completion wins). What IS checkable is arithmetic — how many characters a seat
 * typed, how many were wrong, and how long it took. So this evaluator produces
 * `analysisType: "performance"` with deterministic metrics only. It never emits
 * move classifications, best moves, centipawn loss or an invented skill rating.
 *
 * ── THE TRUST BOUNDARY (verified against the game, not assumed) ─────────────
 * The client may only ever say WHAT IT TYPED. Everything else is server-derived:
 *   - the passage text comes from `passageForRow(row)` — the row stores only
 *     `(passage_id, passage_version)` (or the seed), and the text lives in code
 *     (src/lib/speed-typing/passages.ts). A client cannot supply or change it.
 *   - the counts come from `race_state.seats.*` (jsonb), which the store writes
 *     from `verifyTypedText` (src/lib/speed-typing/rules.ts) — never from a
 *     client-supplied total. `speed_typing_matches.player*_chars_typed` /
 *     `player*_errors` are a denormalised mirror of the same numbers, and this
 *     evaluator CROSS-CHECKS the two.
 *   - `go_at` and every seat `finished_at` are absolute SERVER instants; the
 *     frozen `elapsed/wpm/accuracy` are computed at finish from the server clock.
 *   - settlement is idempotent (the first verified finish resolves the race
 *     inside the row-locked transaction; a replay is a `duplicate`), so the
 *     stored result cannot be rewritten by a second submission.
 *
 * So a metric is recomputed from those trusted raw inputs wherever possible,
 * rather than blindly echoing a stored aggregate — and when the stored aggregate
 * and the recomputation DISAGREE, the row is treated as inconsistent and no
 * report is produced (never a number that is "half trusted").
 *
 * ── WHAT IS NOT AVAILABLE ──────────────────────────────────────────────────
 * There is no per-round history: a race is ONE passage, checkpointed at a
 * throttle and never stored per keystroke (migration 0191). So no round-by-round
 * breakdown is emitted — it is not invented.
 */

import { eq } from "drizzle-orm";

import { db } from "../../../db/client";
import { speedTypingMatches } from "../../../db/schema";
import { passageForRow } from "../../speed-typing/passages";
import {
  RACE_LIMIT_MS,
  MATCH_STATUS,
  SEAT,
} from "../../speed-typing/constants";
import { coerceRaceState, instantFromDate } from "../../speed-typing/rules";
import {
  GAME_REPORT_SCHEMA_VERSION,
  metric,
  metricOrUnavailable,
  type GameReportMetric,
  type GameReportV1,
} from "../gameReport";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GAME_KEY = "speed-typing";

// ════════════════════════════════════════════════════════════════════
// Reason codes (machine-readable; the service maps them to HTTP)
// ════════════════════════════════════════════════════════════════════

export type SpeedTypingUnavailableReason =
  | "game_not_found"
  | "match_not_finished"
  | "passage_unavailable"
  | "inconsistent_counters"
  | "database_error";

// ════════════════════════════════════════════════════════════════════
// Formulas (one definition each — documented and unit-tested)
// ════════════════════════════════════════════════════════════════════
//
// correctChars  = max(0, charsTyped − errors)
//                 (both server-monotonic; errors never exceeds charsTyped)
// accuracy%     = round(correctChars ÷ charsTyped × 100), undefined at 0 typed
// words/min     = round(correctChars ÷ 5 ÷ (elapsedMs ÷ 60_000))
//                 the standard "five characters to a word" convention the game
//                 itself uses (see `raceMetrics` in src/lib/speed-typing/rules.ts)
// elapsedMs     = finishedAt − goAt, for a seat that FINISHED (server instants)
// progress%     = round(charsTyped ÷ passageLength × 100)
//
// A non-finisher gets NO wpm and NO completion time: they did not complete the
// passage, so a "words per minute" for them would be a fabricated skill number.
// Their accuracy and progress are still exact from the raw counts.

/** Characters typed correctly — the numerator behind wpm and accuracy. */
export function correctCharsFor(charsTyped: number, errors: number): number {
  return Math.max(0, Math.floor(charsTyped) - Math.floor(errors));
}

/** Accuracy percent, or null when nothing was typed (0/0 is undefined). */
export function accuracyPercentFor(correctChars: number, charsTyped: number): number | null {
  if (!Number.isFinite(charsTyped) || charsTyped <= 0) return null;
  return Math.round((correctChars / charsTyped) * 100);
}

/** Words per minute, or null for a zero/absent duration (never divide by 0). */
export function wpmFor(correctChars: number, elapsedMs: number | null): number | null {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return Math.round(correctChars / 5 / (elapsedMs / 60_000));
}

// ════════════════════════════════════════════════════════════════════
// Pure analysis (unit-testable without a database)
// ════════════════════════════════════════════════════════════════════

export type SpeedTypingSeatInput = {
  charsTyped: number;
  errors: number;
  finished: boolean;
  finishedAtMs: number | null;
  /** The FROZEN aggregate the store wrote at finish (null until finished). */
  elapsedMs: number | null;
  wpm: number | null;
  accuracy: number | null;
  forfeited: boolean;
};

export type SpeedTypingMatchInput = {
  matchId: string;
  player1Id: string;
  player2Id: string | null;
  winnerId: string | null;
  status: string | null;
  result: string | null;
  isAi: boolean;
  /** Server instants (ms). */
  goAtMs: number | null;
  resolvedAtMs: number | null;
  resolutionReason: string | null;
  passageId: string | null;
  passageVersion: number | null;
  /** The passage length the server resolved from the catalog, or null. */
  passageCharCount: number | null;
  endedAtIso: string | null;
  seats: { player1: SpeedTypingSeatInput; player2: SpeedTypingSeatInput };
  /** The denormalised mirror columns, cross-checked against `seats`. */
  mirror: {
    player1CharsTyped: number;
    player1Errors: number;
    player2CharsTyped: number;
    player2Errors: number;
  };
};

function emptySeat(): SpeedTypingSeatInput {
  return {
    charsTyped: 0,
    errors: 0,
    finished: false,
    finishedAtMs: null,
    elapsedMs: null,
    wpm: null,
    accuracy: null,
    forfeited: false,
  };
}

function emptyReport(
  input: SpeedTypingMatchInput,
  reason: SpeedTypingUnavailableReason,
): GameReportV1 {
  const participants = [input.player1Id, input.player2Id].filter(
    (id): id is string => Boolean(id),
  );
  return {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: GAME_KEY,
    analysisType: "performance",
    status: "unavailable",
    match: {
      matchId: input.matchId,
      result: input.result ?? null,
      finishedAt: input.endedAtIso ?? null,
      participants,
    },
    metrics: [],
    unavailableReason: reason,
  };
}

/** The outcome token a seat gets from the settled result. */
function outcomeFor(result: string | null, seatKey: "player1" | "player2"): string {
  if (result !== "player1" && result !== "player2") return "draw";
  return result === seatKey ? "win" : "loss";
}

/**
 * Whether the stored frozen aggregates agree with the recomputation.
 *
 * They are written by the same formula from the same server instants, so any
 * disagreement means the row was tampered with or partially written — and a
 * half-trusted number is worse than no number.
 */
function frozenMetricsAgree(
  seat: SpeedTypingSeatInput,
  goAtMs: number | null,
  passageCharCount: number,
): boolean {
  if (!seat.finished) return true;
  if (seat.elapsedMs == null && seat.wpm == null && seat.accuracy == null) {
    // A finish with no frozen metrics is a legacy/partial write; the raw counts
    // are still trusted, so this is not treated as an inconsistency.
    return true;
  }
  if (goAtMs == null || seat.finishedAtMs == null) return true;
  const elapsed = Math.max(0, seat.finishedAtMs - goAtMs);
  const correct = correctCharsFor(passageCharCount, seat.errors);
  const expectedWpm = wpmFor(correct, elapsed);
  const expectedAccuracy = accuracyPercentFor(correct, passageCharCount);
  if (seat.elapsedMs != null && seat.elapsedMs !== elapsed) return false;
  if (seat.wpm != null && seat.wpm !== expectedWpm) return false;
  if (seat.accuracy != null && seat.accuracy !== expectedAccuracy) return false;
  return true;
}

function seatMetrics(
  seat: SpeedTypingSeatInput,
  seatKey: "player1" | "player2",
  result: string | null,
  goAtMs: number | null,
  passageCharCount: number,
): GameReportMetric[] {
  const typed = Math.max(0, Math.floor(seat.charsTyped));
  const errors = Math.max(0, Math.floor(seat.errors));
  const correct = correctCharsFor(typed, errors);
  const elapsedMs =
    seat.finished && seat.finishedAtMs != null && goAtMs != null
      ? Math.max(0, seat.finishedAtMs - goAtMs)
      : null;
  const wpm = seat.finished ? wpmFor(correct, elapsedMs) : null;
  const accuracy = accuracyPercentFor(correct, typed);
  const progress =
    passageCharCount > 0
      ? Math.round((typed / passageCharCount) * 100)
      : null;

  return [
    metric("outcome", "Outcome", outcomeFor(result, seatKey)),
    metric("completed", "Completed the passage", seat.finished),
    metric("charsTyped", "Characters typed", typed, "count"),
    metric("errors", "Wrong characters typed", errors, "count"),
    metric("correctChars", "Correct characters (typed − errors)", correct, "count"),
    metricOrUnavailable(
      "accuracyPercent",
      "Accuracy (correct chars ÷ typed chars)",
      accuracy,
      "No characters were typed, so accuracy is undefined.",
      "percent",
    ),
    metricOrUnavailable(
      "progressPercent",
      "Progress (typed chars ÷ passage length)",
      progress,
      "The passage length is unavailable for this match.",
      "percent",
    ),
    metricOrUnavailable(
      "completionTimeMs",
      "Completion time (finished − GO)",
      elapsedMs,
      seat.finished
        ? "The completion instant is unavailable for this seat."
        : "This seat did not complete the passage.",
      "ms",
    ),
    metricOrUnavailable(
      "wpm",
      "Words per minute (correct chars ÷ 5 ÷ minutes)",
      wpm,
      seat.finished
        ? "No measurable duration, so words per minute is undefined."
        : "This seat did not complete the passage.",
      "wpm",
    ),
  ];
}

/**
 * The pure analysis. Deterministic: the same input always yields the same
 * report (asserted by a repeat-evaluation test).
 */
export function analyzeSpeedTypingGame(input: SpeedTypingMatchInput): GameReportV1 {
  if (String(input.status ?? "") !== MATCH_STATUS.FINISHED) {
    return emptyReport(input, "match_not_finished");
  }
  if (
    input.passageCharCount == null ||
    !Number.isFinite(input.passageCharCount) ||
    input.passageCharCount <= 0
  ) {
    // The server could not resolve the passage this match raced on. Without it,
    // neither progress nor accuracy can be grounded — so nothing is reported.
    return emptyReport(input, "passage_unavailable");
  }
  const passageLength = input.passageCharCount;

  // The denormalised mirror must agree with the authoritative race state, and
  // no count may exceed the passage.
  const mirrors: Array<[SpeedTypingSeatInput, number, number, string]> = [
    [input.seats.player1, input.mirror.player1CharsTyped, input.mirror.player1Errors, "player1"],
    [input.seats.player2, input.mirror.player2CharsTyped, input.mirror.player2Errors, "player2"],
  ];
  for (const [seat, charsTyped, errors] of mirrors) {
    if (
      seat.charsTyped !== charsTyped ||
      seat.errors !== errors ||
      seat.charsTyped > passageLength ||
      seat.errors > seat.charsTyped
    ) {
      return emptyReport(input, "inconsistent_counters");
    }
  }
  if (
    !frozenMetricsAgree(input.seats.player1, input.goAtMs, passageLength) ||
    !frozenMetricsAgree(input.seats.player2, input.goAtMs, passageLength)
  ) {
    return emptyReport(input, "inconsistent_counters");
  }

  const raceDurationMs =
    input.goAtMs != null && input.resolvedAtMs != null
      ? Math.max(0, input.resolvedAtMs - input.goAtMs)
      : null;

  const metrics: GameReportMetric[] = [
    metric("passageLength", "Passage length", passageLength, "count"),
    metric("winnerSeat", "Result", input.result ?? "unknown"),
    metricOrUnavailable(
      "resolutionReason",
      "How the race ended",
      input.resolutionReason,
      "The resolution reason was not recorded.",
    ),
    metricOrUnavailable(
      "raceDurationMs",
      "Race duration (resolved − GO)",
      raceDurationMs,
      "The server GO/resolved instants are unavailable.",
      "ms",
    ),
    metric("timeLimitMs", "Race time limit", RACE_LIMIT_MS, "ms"),
    metric("isPractice", "Practice match", input.isAi),
  ];

  const players: NonNullable<GameReportV1["players"]> = [
    {
      playerId: input.player1Id,
      role: "player1",
      metrics: seatMetrics(input.seats.player1, "player1", input.result, input.goAtMs, passageLength),
    },
  ];
  if (input.player2Id) {
    players.push({
      playerId: input.player2Id,
      role: "player2",
      metrics: seatMetrics(input.seats.player2, "player2", input.result, input.goAtMs, passageLength),
    });
  }

  return {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: GAME_KEY,
    analysisType: "performance",
    status: "complete",
    match: {
      matchId: input.matchId,
      result: input.result,
      finishedAt: input.endedAtIso ?? null,
      participants: [input.player1Id, input.player2Id].filter(
        (id): id is string => Boolean(id),
      ),
    },
    metrics,
    players,
    // No rounds (a race is one passage), no moves (no moves exist), no engine.
    engine: null,
    ai: null,
    unavailableReason: null,
  };
}

// ════════════════════════════════════════════════════════════════════
// Database entry point
// ════════════════════════════════════════════════════════════════════

/**
 * Evaluates one finished Speed Typing match.
 *
 * Loads `speed_typing_matches` (the ONLY table — there is no move/keystroke
 * log), resolves the passage from the row's own `(id, version)`, and runs the
 * pure analysis above. Returns an `unavailable` report (never fabricated
 * numbers and never a throw for an expected condition) when the match is
 * missing, not finished, unarmed/unresolvable, or its counters disagree.
 */
export async function evaluateSpeedTypingMatch(matchId: string): Promise<GameReportV1> {
  const id = String(matchId ?? "").trim();
  const missing: SpeedTypingMatchInput = {
    matchId: id,
    player1Id: "",
    player2Id: null,
    winnerId: null,
    status: null,
    result: null,
    isAi: false,
    goAtMs: null,
    resolvedAtMs: null,
    resolutionReason: null,
    passageId: null,
    passageVersion: null,
    passageCharCount: null,
    endedAtIso: null,
    seats: { player1: emptySeat(), player2: emptySeat() },
    mirror: {
      player1CharsTyped: 0,
      player1Errors: 0,
      player2CharsTyped: 0,
      player2Errors: 0,
    },
  };
  if (!UUID_RE.test(id)) return emptyReport(missing, "game_not_found");

  try {
    const [match] = await db
      .select({
        id: speedTypingMatches.id,
        player1Id: speedTypingMatches.player1Id,
        player2Id: speedTypingMatches.player2Id,
        winnerId: speedTypingMatches.winnerId,
        status: speedTypingMatches.status,
        result: speedTypingMatches.result,
        isAi: speedTypingMatches.isAi,
        passageId: speedTypingMatches.passageId,
        passageVersion: speedTypingMatches.passageVersion,
        raceSeed: speedTypingMatches.raceSeed,
        goAt: speedTypingMatches.goAt,
        resolutionReason: speedTypingMatches.resolutionReason,
        raceState: speedTypingMatches.raceState,
        player1CharsTyped: speedTypingMatches.player1CharsTyped,
        player1Errors: speedTypingMatches.player1Errors,
        player2CharsTyped: speedTypingMatches.player2CharsTyped,
        player2Errors: speedTypingMatches.player2Errors,
        endedAt: speedTypingMatches.endedAt,
      })
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, id))
      .limit(1);

    if (!match) return emptyReport({ ...missing, matchId: id }, "game_not_found");

    const state = coerceRaceState(match.raceState);
    const passage = passageForRow(match);

    return analyzeSpeedTypingGame({
      matchId: String(match.id),
      player1Id: String(match.player1Id),
      player2Id: match.player2Id ? String(match.player2Id) : null,
      winnerId: match.winnerId ? String(match.winnerId) : null,
      status: match.status ?? null,
      result: match.result ?? null,
      isAi: Boolean(match.isAi),
      goAtMs: instantFromDate(match.goAt),
      resolvedAtMs: state.resolvedAtMs,
      resolutionReason: match.resolutionReason ?? state.resolutionReason ?? null,
      passageId: match.passageId ? String(match.passageId) : null,
      passageVersion: match.passageVersion == null ? null : Number(match.passageVersion),
      passageCharCount: passage ? passage.charCount : null,
      endedAtIso: match.endedAt ? new Date(match.endedAt).toISOString() : null,
      seats: {
        player1: { ...emptySeat(), ...state.seats[SEAT.PLAYER1] },
        player2: { ...emptySeat(), ...state.seats[SEAT.PLAYER2] },
      },
      mirror: {
        player1CharsTyped: Number(match.player1CharsTyped ?? 0),
        player1Errors: Number(match.player1Errors ?? 0),
        player2CharsTyped: Number(match.player2CharsTyped ?? 0),
        player2Errors: Number(match.player2Errors ?? 0),
      },
    });
  } catch (err) {
    console.error("[evaluation] speed-typing evaluation failed:", err);
    return emptyReport({ ...missing, matchId: id }, "database_error");
  }
}
