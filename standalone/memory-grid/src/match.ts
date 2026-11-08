// standalone/memory-grid/src/match.ts
//
// The standalone Memory Grid match controller: ONE local match, the player
// against the app's own bot, NO server.
//
// This is the only part of the match lifecycle that had to be rewritten for a
// static build, and it is deliberately thin. Every rule and every number still
// comes from the shared engine, so the standalone game and the GRYND game are
// the same game:
//
//   the round ladder        ROUND_CONFIGS / roundConfig / TIEBREAK_CONFIG
//   a round's pattern       generatePattern (the server's own generator)
//   the round's phases      PHASES, memorize duration, RECONSTRUCT window
//   scoring                 assessReconstruction + computeFinalRoundScore
//   the round's winner      roundWinnerFromScores
//   the match's winner      matchWinnerFromTotals
//   the bot                 chooseAiReconstruction + aiSubmissionDelayMs
//   the verdict             viewerOutcome
//
// There is NO second rules engine here and there must never be one: a round
// score is exactly what `computeFinalRoundScore` returns for the player's picks
// against the round's pattern, and the match result is exactly what
// `matchWinnerFromTotals` says about the two totals.
//
// What is deliberately absent: no database, no auth, no `fetch`, no socket, no
// Elo/trophy/coin/escrow call, no persistence. `serverStore.js` is not imported
// and must never be — it is the one module that would drag Postgres, Drizzle,
// the wager policy and the settlement stack into the bundle. `seeds.js` is not
// imported either: its SHA-256 commitment exists to prove a pattern to an
// opponent, and a local match has none.
//
// WHAT CHANGED FROM THE SERVER (and why it is safe):
//
//   * The server advances phases when a status request arrives, because it has
//     no scheduler. Here `tick(match, now)` does the same job on demand, driven
//     by the caller's clock, and it LOOPS until it has caught up — so a
//     backgrounded tab that wakes up 30 s late still resolves exactly the
//     phases whose absolute deadlines passed, in the right order.
//   * Phase windows stay ANCHORED TO ABSOLUTE TIMESTAMPS, never to tick counts:
//     reconstruct starts at the memorize deadline (that is the authoritative
//     pattern-hide instant) and the result window starts when the round
//     resolves. A slow tick can therefore never lengthen a player's memorize
//     preview or shorten their reconstruction.
//   * Totals are accumulated rounded to one decimal place, which is the local
//     analogue of the server's exact numeric columns: without it, float noise
//     (`83.3 + 16.7`) could make two equal totals compare unequal and skip the
//     tiebreak round.
//
// Everything in this file is a pure function of (match, now, picks): it never
// reads the clock unless the caller omits `nowMs`, and it never mutates the
// match it is handed.

import { coerceAiDifficulty, type AiDifficulty } from "../../../src/lib/aiDifficulty";
import {
  MATCH_STATUS,
  PHASES,
  READY_WINDOW_MS,
  RECONSTRUCT_DEADLINE_MS,
  RESULT,
  RESULT_WINDOW_MS,
  ROUNDS_PER_MATCH,
  TIEBREAK_ROUND_NUMBER,
  aiSubmissionDelayMs,
  assessReconstruction,
  chooseAiReconstruction,
  computeFinalRoundScore,
  generatePattern,
  matchWinnerFromTotals,
  reconstructDeadlineFromStart,
  roundConfig,
  roundWinnerFromScores,
  speedMultiplierFromCompletion,
} from "../../../src/lib/memory-grid/constants";
import { hashSeed } from "../../../src/lib/physics2d/deterministic";
import { viewerOutcome, type ViewerOutcome } from "../../../src/lib/results/viewerOutcome";

/** The two seats. The human is always `player1` locally; the bot is `player2`. */
export type Seat = "player1" | "player2";

/** The round's pattern — grid size + the lit tile indices, row-major. */
export type Pattern = {
  size: number;
  total: number;
  active: number[];
};

/** One seat's finished reconstruction for a round. */
export type ReconstructionFlip = {
  seat: Seat;
  picks: number[];
  score: number;
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  accuracyPct: number;
  completionTimeMs: number;
  speedTier: string;
  autoLocked: boolean;
};

/** A completed round, exactly what the round-result screen renders. */
export type RoundSnapshot = {
  roundNumber: number;
  boardSnapshot: Pattern;
  flips: ReconstructionFlip[];
  p1RoundScore: number;
  p2RoundScore: number;
  roundWinner: string;
};

/**
 * The bot's pre-computed reconstruction: when it submits and what it picked.
 *
 * INTERNAL. It must never reach the view — the player may not learn the bot's
 * picks before the round resolves, which is exactly why `viewForMatch` is the
 * only thing the UI is allowed to render.
 */
type AiPlan = { dueAtMs: number; picks: number[] };

export type LocalMatch = {
  /** The match seed every round's pattern derives from. */
  seed: number;
  difficulty: AiDifficulty;
  status: string;
  phase: string | null;
  roundNumber: number;
  roundsPerMatch: number;
  pattern: Pattern;
  /** Absolute instant the current phase ends. */
  phaseDeadlineMs: number | null;
  p1Submitted: boolean;
  p2Submitted: boolean;
  p1RoundScore: number;
  p2RoundScore: number;
  /** Cumulative round-score points (each round scores /100). */
  p1Total: number;
  p2Total: number;
  /** Rounds won. */
  p1Score: number;
  p2Score: number;
  rounds: RoundSnapshot[];
  result: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  /** The current round's submissions (both seats, once each). */
  liveFlips: ReconstructionFlip[];
  aiPlan: AiPlan | null;
};

/** The only shape the UI may render — scrubbed of anything hidden. */
export type LocalMatchView = {
  status: string;
  phase: string | null;
  roundNumber: number;
  roundsPerMatch: number;
  isTiebreak: boolean;
  gridSize: number;
  activeCount: number;
  memorizeMs: number;
  phaseStartedAtMs: number | null;
  phaseDeadlineMs: number | null;
  msLeft: number | null;
  patternVisible: boolean;
  pattern: Pattern | null;
  p1Submitted: boolean;
  p2Submitted: boolean;
  playerSubmitted: boolean;
  botSubmitted: boolean;
  p1RoundScore: number;
  p2RoundScore: number;
  p1Total: number;
  p2Total: number;
  p1Score: number;
  p2Score: number;
  rounds: RoundSnapshot[];
  result: string | null;
  viewerOutcome: ViewerOutcome | null;
  difficulty: AiDifficulty;
  startedAtMs: number;
  endedAtMs: number | null;
};

/** Submitter-only feedback: the authoritative assessment of their round. */
export type SubmitFeedback = {
  score: number;
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  accuracyPct: number;
  completionTimeMs: number;
  speedTier: string;
  speedMultiplier: number;
  active: number[];
  roundNumber: number;
};

export type SubmitResult = {
  match: LocalMatch;
  error: string | null;
  feedback: SubmitFeedback | null;
};

type RoundConfigShape = { gridSize: number; activeCount: number; memorizeMs: number };

function configFor(roundNumber: number): RoundConfigShape {
  const cfg = roundConfig(roundNumber) as unknown as RoundConfigShape | undefined;
  return {
    gridSize: Number(cfg?.gridSize) || 3,
    activeCount: Number(cfg?.activeCount) || 0,
    memorizeMs: Number(cfg?.memorizeMs) || 0,
  };
}

/**
 * The deterministic per-round seed.
 *
 * The app derives this from a committed server seed via SHA-256 so both players
 * can verify it after the match. A local match needs the same determinism (so a
 * round's pattern cannot change mid-round, and a replay is possible from the
 * seed alone) but none of the commitment, so a cheap hash of the match seed and
 * round number is enough.
 */
export function deriveRoundSeed(seed: number, roundNumber: number): number {
  const round = Math.max(1, Math.trunc(Number(roundNumber) || 1));
  return hashSeed(`${Number(seed) >>> 0}:round:${round}`) >>> 0;
}

/**
 * The bot's reconstruction picks.
 *
 * The engine's option type is inferred from a numeric `seed` default, but its
 * implementation stringifies whatever it is given — and the server passes a
 * string (`"<matchId>:<serverSeed>"`) too. Going through this helper keeps the
 * string seed the app uses without restating a cast at every call site.
 */
function botPicks(options: {
  pattern: Pattern;
  roundNumber: number;
  seed: string;
  difficulty: string;
}): number[] {
  return chooseAiReconstruction(
    options as unknown as Parameters<typeof chooseAiReconstruction>[0],
  ) as number[];
}

function patternFor(seed: number, roundNumber: number): Pattern {
  const pattern = generatePattern(roundNumber, {
    seed: deriveRoundSeed(seed, roundNumber),
  }) as unknown as Pattern;
  return {
    size: Number(pattern.size),
    total: Number(pattern.total),
    active: [...pattern.active],
  };
}

/** The duration of the match's CURRENT phase (0 when no phase is live). */
export function phaseDurationMs(match: LocalMatch): number {
  if (match.phase === PHASES.MEMORIZE) return configFor(match.roundNumber).memorizeMs;
  if (match.phase === PHASES.RECONSTRUCT) return RECONSTRUCT_DEADLINE_MS;
  if (match.phase === PHASES.RESULT) return RESULT_WINDOW_MS;
  return 0;
}

/**
 * The authoritative start of the reconstruct window.
 *
 * The match row stores only the phase DEADLINE; the server recovers the start as
 * `deadline − window` so both players' completion times are measured from the
 * same absolute instant. Null outside the reconstruct phase.
 */
export function reconstructStartMs(match: LocalMatch): number | null {
  if (match.phase !== PHASES.RECONSTRUCT) return null;
  if (match.phaseDeadlineMs === null) return null;
  return match.phaseDeadlineMs - RECONSTRUCT_DEADLINE_MS;
}

function totalWith(total: number, roundScore: number): number {
  return Number((Number(total) + Number(roundScore)).toFixed(1));
}

// ──────────────────────────────────────────────────────────────────────────
// Creation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Start a local match.
 *
 * Mirrors the server's `createAiMatch`: the row opens in `ready` with a
 * countdown deadline, the bot occupies seat 2 at the chosen tier, and round 1's
 * pattern is generated up front from the match seed. `readyMs: 0` removes the
 * countdown, which is what the tests and the scaffold's self-check use.
 */
export function createLocalMatch({
  difficulty,
  seed,
  nowMs = Date.now(),
  readyMs = READY_WINDOW_MS,
}: {
  difficulty?: unknown;
  seed: number;
  nowMs?: number;
  readyMs?: number;
}): LocalMatch {
  const normalizedSeed = Number(seed) >>> 0;
  const countdownMs = Math.max(0, Math.trunc(Number(readyMs) || 0));

  return {
    seed: normalizedSeed,
    difficulty: coerceAiDifficulty(difficulty),
    status: MATCH_STATUS.READY,
    phase: null,
    roundNumber: 1,
    roundsPerMatch: ROUNDS_PER_MATCH,
    pattern: patternFor(normalizedSeed, 1),
    phaseDeadlineMs: nowMs + countdownMs,
    p1Submitted: false,
    p2Submitted: false,
    p1RoundScore: 0,
    p2RoundScore: 0,
    p1Total: 0,
    p2Total: 0,
    p1Score: 0,
    p2Score: 0,
    rounds: [],
    result: null,
    startedAtMs: nowMs,
    endedAtMs: null,
    liveFlips: [],
    aiPlan: null,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Phase transitions
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deal a round and open its memorize phase for both seats.
 *
 * This is the server's `dealNextRound` + `openMemorize` in one step: a fresh
 * pattern from the derived seed, the per-round state (submissions and round
 * scores) cleared, and the memorize deadline stamped as `now + memorizeMs`.
 */
function startRound(match: LocalMatch, roundNumber: number, nowMs: number): LocalMatch {
  const cfg = configFor(roundNumber);
  return {
    ...match,
    status: MATCH_STATUS.ACTIVE,
    phase: PHASES.MEMORIZE,
    roundNumber,
    pattern: patternFor(match.seed, roundNumber),
    phaseDeadlineMs: nowMs + cfg.memorizeMs,
    p1Submitted: false,
    p2Submitted: false,
    p1RoundScore: 0,
    p2RoundScore: 0,
    liveFlips: [],
    aiPlan: null,
  };
}

/**
 * Hide the pattern and open the reconstruct window for both seats.
 *
 * The deadline is anchored on the MEMORIZE DEADLINE, not on `nowMs`: that
 * instant is the authoritative pattern-hide moment, so a tick that discovers the
 * transition late (background tab, any tick cadence) cannot move the window.
 *
 * The bot's reconstruction is planned here — due time and picks — but stays
 * internal until it is submitted; see `viewForMatch`.
 */
function openReconstruct(match: LocalMatch, nowMs: number): LocalMatch {
  const startMs = match.phaseDeadlineMs ?? nowMs;
  const deadline = reconstructDeadlineFromStart(
    startMs,
    RECONSTRUCT_DEADLINE_MS,
  ) as Date | null;
  const deadlineMs = deadline ? deadline.getTime() : startMs + RECONSTRUCT_DEADLINE_MS;
  const delayMs = Number(
    aiSubmissionDelayMs({ roundNumber: match.roundNumber, matchId: match.seed }),
  );
  const dueAtMs = Math.min(startMs + Math.max(0, delayMs || 0), deadlineMs);

  return {
    ...match,
    phase: PHASES.RECONSTRUCT,
    phaseDeadlineMs: deadlineMs,
    aiPlan: {
      dueAtMs,
      picks: botPicks({
        pattern: match.pattern,
        roundNumber: match.roundNumber,
        seed: `${match.seed}:${match.roundNumber}`,
        difficulty: match.difficulty,
      }),
    },
  };
}

/**
 * Record one seat's reconstruction and resolve the round once BOTH are in.
 *
 * `submittedAtMs` is when the seat's submission happened (the bot's scheduled
 * instant, the reconstruct deadline for an AFK lock, or the click instant);
 * `nowMs` is when the round actually resolves, which only ever matters for the
 * result window's own deadline.
 */
function submitSeat(
  match: LocalMatch,
  seat: Seat,
  picks: number[],
  { autoLocked = false, submittedAtMs, nowMs }: {
    autoLocked?: boolean;
    submittedAtMs: number;
    nowMs: number;
  },
): { match: LocalMatch; flip: ReconstructionFlip } {
  const startMs = reconstructStartMs(match) ?? submittedAtMs;
  const completionTimeMs = Math.max(
    0,
    Math.min(RECONSTRUCT_DEADLINE_MS, Math.round(submittedAtMs - startMs)),
  );
  const assessment = assessReconstruction(picks, match.pattern) as {
    total: number;
    correct: number;
    incorrect: number;
    accuracy: number;
    accuracyPct: number;
  };
  const speed = speedMultiplierFromCompletion(
    completionTimeMs,
    RECONSTRUCT_DEADLINE_MS,
  ) as { tier: string; multiplier: number };

  // An empty reconstruction scores 0 (the AFK guard inside the shared scorer)
  // even though its true-negative accuracy is high.
  const score = Number(
    computeFinalRoundScore({
      accuracy: Number(assessment.accuracy) || 0,
      pickedCount: picks.length,
    }),
  );

  const flip: ReconstructionFlip = {
    seat,
    picks: [...picks],
    score,
    total: Number(assessment.total) || 0,
    correct: Number(assessment.correct) || 0,
    incorrect: Number(assessment.incorrect) || 0,
    accuracy: Number(assessment.accuracy) || 0,
    accuracyPct: Number(assessment.accuracyPct) || 0,
    completionTimeMs,
    speedTier: speed?.tier ?? "very_slow",
    autoLocked: Boolean(autoLocked),
  };

  const next: LocalMatch = {
    ...match,
    p1Submitted: seat === "player1" ? true : match.p1Submitted,
    p2Submitted: seat === "player2" ? true : match.p2Submitted,
    p1RoundScore: seat === "player1" ? score : match.p1RoundScore,
    p2RoundScore: seat === "player2" ? score : match.p2RoundScore,
    liveFlips: [...match.liveFlips, flip],
  };

  return {
    match: next.p1Submitted && next.p2Submitted ? completeRound(next, nowMs) : next,
    flip,
  };
}

/**
 * Award the completed round and enter the round-result phase.
 *
 * The server's `completeRound`, unchanged in behaviour: the higher round score
 * wins the round (a tie awards nobody), the winner's rounds-won tally goes up,
 * both round scores are added to the cumulative totals, and the result window
 * opens for RESULT_WINDOW_MS so both screens can show the answer key.
 */
function completeRound(match: LocalMatch, nowMs: number): LocalMatch {
  const p1RoundScore = match.p1RoundScore;
  const p2RoundScore = match.p2RoundScore;
  const roundWinner = roundWinnerFromScores(p1RoundScore, p2RoundScore) as string;

  const snapshot: RoundSnapshot = {
    roundNumber: match.roundNumber,
    boardSnapshot: match.pattern,
    flips: match.liveFlips,
    p1RoundScore,
    p2RoundScore,
    roundWinner,
  };

  return {
    ...match,
    phase: PHASES.RESULT,
    phaseDeadlineMs: nowMs + RESULT_WINDOW_MS,
    p1Score: match.p1Score + (roundWinner === RESULT.PLAYER1 ? 1 : 0),
    p2Score: match.p2Score + (roundWinner === RESULT.PLAYER2 ? 1 : 0),
    p1Total: totalWith(match.p1Total, p1RoundScore),
    p2Total: totalWith(match.p2Total, p2RoundScore),
    rounds: [...match.rounds, snapshot],
  };
}

/**
 * Close the round-result window: deal the next round, deal the tiebreak, or
 * finish the match.
 *
 * Mirrors the server exactly, including the one rule that is easy to get wrong:
 * the tiebreak round is dealt when the CUMULATIVE TOTALS are equal after round 5
 * — not when the rounds-won tally is level — and a tiebreak round that ALSO ties
 * finishes the match as a draw instead of dealing round 6 again.
 */
function advanceAfterResult(match: LocalMatch, nowMs: number): LocalMatch {
  if (match.roundNumber >= ROUNDS_PER_MATCH) {
    const tied = match.p1Total === match.p2Total;
    if (match.roundNumber < TIEBREAK_ROUND_NUMBER && tied) {
      return startRound(match, TIEBREAK_ROUND_NUMBER, nowMs);
    }
    return {
      ...match,
      status: MATCH_STATUS.FINISHED,
      phase: null,
      phaseDeadlineMs: null,
      result: matchWinnerFromTotals(match.p1Total, match.p2Total) as string,
      endedAtMs: nowMs,
    };
  }
  return startRound(match, match.roundNumber + 1, nowMs);
}

/**
 * Advance the match to `nowMs`.
 *
 * Loops until no phase deadline is in the past, so one call after a long sleep
 * performs every phase transition that should have happened, in order. Each
 * iteration is a real transition, and the guard bounds the loop (a finished
 * match returns immediately; a mis-built state can never spin).
 *
 * The bot submits at its scheduled instant — which, on a catch-up tick, is in
 * the past — BEFORE the AFK lock runs, so a backgrounded tab resolves a round
 * with the reconstruction the bot would have played, not with an empty grid. The
 * player has no such plan: an unreached submission at the deadline is locked as
 * empty, exactly as the server's AFK lock does.
 */
export function tick(match: LocalMatch, nowMs: number = Date.now()): LocalMatch {
  let next = match;

  for (let guard = 0; guard < 32; guard += 1) {
    const deadline = next.phaseDeadlineMs;

    if (next.status === MATCH_STATUS.READY) {
      if (deadline !== null && nowMs < deadline) return next;
      next = startRound(next, 1, nowMs);
      continue;
    }

    if (next.status !== MATCH_STATUS.ACTIVE || !next.phase) return next;

    if (next.phase === PHASES.MEMORIZE) {
      if (deadline === null || nowMs < deadline) return next;
      next = openReconstruct(next, nowMs);
      continue;
    }

    if (next.phase === PHASES.RECONSTRUCT) {
      if (next.aiPlan && !next.p2Submitted && nowMs >= next.aiPlan.dueAtMs) {
        next = submitSeat(next, "player2", next.aiPlan.picks, {
          submittedAtMs: next.aiPlan.dueAtMs,
          nowMs,
        }).match;
        continue;
      }
      if (deadline === null || nowMs < deadline) return next;
      if (!next.p1Submitted) {
        next = submitSeat(next, "player1", [], {
          autoLocked: true,
          submittedAtMs: deadline,
          nowMs,
        }).match;
        continue;
      }
      if (!next.p2Submitted) {
        next = submitSeat(next, "player2", [], {
          autoLocked: true,
          submittedAtMs: deadline,
          nowMs,
        }).match;
        continue;
      }
      return next;
    }

    if (next.phase === PHASES.RESULT) {
      if (deadline === null || nowMs < deadline) return next;
      next = advanceAfterResult(next, nowMs);
      continue;
    }

    return next;
  }

  return next;
}

// ──────────────────────────────────────────────────────────────────────────
// The player's submission
// ──────────────────────────────────────────────────────────────────────────

/**
 * Submit the player's reconstruction for the current round.
 *
 * Validation mirrors the API route + store, in the same order and with the same
 * messages: the match must be awaiting a reconstruction, the seat may submit
 * once, and the picks must be distinct non-negative tile indices inside the
 * current grid (any number of them — over-selection is penalised by the
 * full-grid scoring, not rejected).
 *
 * A submission landing just after the memorize deadline but before any tick has
 * opened the reconstruct phase is ACCEPTED, and the phase is advanced anchored
 * on that same deadline — exactly what the server's submit path does, so a fast
 * player is never told "Reconstruction hasn't started yet" by a lazy clock.
 */
export function submitReconstruction(
  match: LocalMatch,
  picks: unknown,
  nowMs: number = Date.now(),
): SubmitResult {
  if (match.status === MATCH_STATUS.FINISHED || match.result) {
    return { match, error: "The match is already over", feedback: null };
  }

  let current = match;
  if (
    current.status === MATCH_STATUS.ACTIVE &&
    current.phase === PHASES.MEMORIZE &&
    current.phaseDeadlineMs !== null &&
    nowMs >= current.phaseDeadlineMs
  ) {
    current = openReconstruct(current, nowMs);
  }

  if (current.status !== MATCH_STATUS.ACTIVE) {
    return { match: current, error: "Match is not awaiting a reconstruction", feedback: null };
  }
  if (current.phase !== PHASES.RECONSTRUCT) {
    return { match: current, error: "Reconstruction hasn't started yet", feedback: null };
  }
  if (current.p1Submitted) {
    return { match: current, error: "You already submitted this round", feedback: null };
  }
  if (!Array.isArray(picks)) {
    return { match: current, error: "picks must be an array of tile indices", feedback: null };
  }

  const seen = new Set<number>();
  for (const value of picks) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) {
      return {
        match: current,
        error: "picks must be distinct non-negative tile indices",
        feedback: null,
      };
    }
    seen.add(index);
  }

  const total = Number(current.pattern?.total) || 0;
  if (seen.size > total) {
    return {
      match: current,
      error: `You can pick at most ${total} tiles this round`,
      feedback: null,
    };
  }
  for (const index of seen) {
    if (index >= total) {
      return {
        match: current,
        error: "Tile index out of range for this grid",
        feedback: null,
      };
    }
  }

  const { match: next, flip } = submitSeat(current, "player1", [...seen], {
    submittedAtMs: nowMs,
    nowMs,
  });

  return {
    match: next,
    error: null,
    feedback: {
      score: flip.score,
      total: flip.total,
      correct: flip.correct,
      incorrect: flip.incorrect,
      accuracy: flip.accuracy,
      accuracyPct: flip.accuracyPct,
      completionTimeMs: flip.completionTimeMs,
      speedTier: flip.speedTier,
      speedMultiplier:
        Number(
          speedMultiplierFromCompletion(flip.completionTimeMs, RECONSTRUCT_DEADLINE_MS)
            ?.multiplier,
        ) || 1,
      active: [...current.pattern.active],
      roundNumber: current.roundNumber,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────

export function isOver(match: LocalMatch): boolean {
  return match.result !== null;
}

/**
 * The UI projection.
 *
 * Scrubbed exactly like the server's `normaliseMatchForViewer`:
 *   * the pattern is visible while the memorize window is open, during the
 *     round-result phase, and once the match is finished — and NEVER during
 *     reconstruction. The memorize check is against the absolute deadline, so
 *     the answer disappears on time even before the next tick lands;
 *   * round snapshots (both seats' picks and scores) are only present during the
 *     result phase and after the match, so nothing about the bot can leak while
 *     the player is still reconstructing;
 *   * the bot's plan is not on the view at all.
 */
export function viewForMatch(
  match: LocalMatch,
  nowMs: number = Date.now(),
): LocalMatchView {
  const cfg = configFor(match.roundNumber);
  const playing = match.status === MATCH_STATUS.ACTIVE;
  const finished = match.status === MATCH_STATUS.FINISHED;
  const deadline = match.phaseDeadlineMs;
  const msLeft = deadline === null ? null : Math.max(0, deadline - nowMs);

  const memorizeVisible =
    playing && match.phase === PHASES.MEMORIZE && msLeft !== null && msLeft > 0;
  const patternVisible =
    finished || (playing && (match.phase === PHASES.RESULT || memorizeVisible));
  const showRounds = finished || (playing && match.phase === PHASES.RESULT);
  const duration = phaseDurationMs(match);

  return {
    status: match.status,
    phase: match.phase,
    roundNumber: match.roundNumber,
    roundsPerMatch: match.roundsPerMatch,
    isTiebreak: match.roundNumber > match.roundsPerMatch,
    gridSize: cfg.gridSize,
    activeCount: cfg.activeCount,
    memorizeMs: cfg.memorizeMs,
    phaseStartedAtMs: deadline === null ? null : deadline - duration,
    phaseDeadlineMs: deadline,
    msLeft,
    patternVisible,
    pattern: patternVisible ? match.pattern : null,
    p1Submitted: match.p1Submitted,
    p2Submitted: match.p2Submitted,
    playerSubmitted: match.p1Submitted,
    botSubmitted: match.p2Submitted,
    p1RoundScore: match.p1RoundScore,
    p2RoundScore: match.p2RoundScore,
    p1Total: match.p1Total,
    p2Total: match.p2Total,
    p1Score: match.p1Score,
    p2Score: match.p2Score,
    rounds: showRounds ? match.rounds : [],
    result: match.result,
    viewerOutcome: viewerOutcome({ result: match.result, viewerSeat: "player1" }),
    difficulty: match.difficulty,
    startedAtMs: match.startedAtMs,
    endedAtMs: match.endedAtMs,
  };
}
