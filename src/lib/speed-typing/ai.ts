// src/lib/speed-typing/ai.ts
//
// The Speed Typing practice bot. PURE: given the passage the server resolved
// for the match and the server's own clock, it says exactly how far the bot has
// typed and whether it has finished. No database, no socket, no randomness.
//
// WHY THIS SHAPE: Speed Typing is a real-time race, so the bot is NOT a
// turn-based move generator. The authoritative state is a per-seat cursor into
// the server's passage, so the bot is modelled as a typing SPEED — a constant
// characters-per-millisecond rate derived from the shared difficulty tier —
// plus a small error rate. Every read of the match advances the bot's cursor to
// "now", exactly as if it had been typing all along, which is what guarantees
// it always plays and never skips.
//
// The tier knobs come from the shared scale (src/lib/aiDifficulty.ts). A slower
// tier is a genuinely slower typist (not merely one that makes more mistakes),
// because that is what makes the race winnable rather than merely inaccurate:
//
//   * easy   — slower and sloppier; a beginner beats it comfortably.
//   * normal — a solid amateur pace, beatable by a fast typist.
//   * hard   — a strong pace and near-perfect accuracy.
//
// The bot never reads or writes anything: `aiSeatRaceAt` is a pure projection
// of (passageLength, difficulty, goAtMs, nowMs) onto a seat state, and it is
// MONOTONIC — it never moves a seat backwards and never revives a finished or
// forfeited seat, so calling it twice (or out of order) is always safe.

import { coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import { RACE_LIMIT_MS } from "./constants";
import { emptySeatRace, type SeatRace } from "./rules";

/**
 * Words-per-minute the bot types at, per tier.
 *
 * Chosen against the shipped catalog (25-45 words per passage) so every tier
 * finishes comfortably inside the 120 s hard limit while still being beatable:
 * a fast human types 60-80 wpm, so `normal` at 45 is a real race and `hard` at
 * 65 demands a genuinely quick typist.
 */
export const AI_TYPING_WPM: Record<AiDifficulty, number> = {
  easy: 30,
  normal: 45,
  hard: 65,
};

/** Fraction of typed characters the bot gets wrong, per tier. */
export const AI_TYPING_ERROR_RATE: Record<AiDifficulty, number> = {
  easy: 0.1,
  normal: 0.04,
  hard: 0.01,
};

/** The five-characters-to-a-word convention the rules engine uses for WPM. */
const CHARS_PER_WORD = 5;

/**
 * The bot's typing profile for a tier: how many characters it covers per
 * millisecond, and how often it mistypes.
 */
export function aiTypingProfile(difficulty: unknown): {
  tier: AiDifficulty;
  wpm: number;
  charsPerMs: number;
  errorRate: number;
} {
  const tier = coerceAiDifficulty(difficulty);
  const wpm = AI_TYPING_WPM[tier];
  return {
    tier,
    wpm,
    charsPerMs: (wpm * CHARS_PER_WORD) / 60_000,
    errorRate: AI_TYPING_ERROR_RATE[tier],
  };
}

/** Rounded errors for a cursor position at a tier, never exceeding it. */
function errorsFor(charsTyped: number, errorRate: number): number {
  return Math.min(charsTyped, Math.round(charsTyped * errorRate));
}

/**
 * The bot's authoritative seat state at `nowMs`.
 *
 * `current` is the seat's existing state and is treated as a floor: a value
 * already ahead (a slower clock, a replayed packet) is never rewound, and a
 * finished or forfeited seat is returned untouched. Nothing is inferred from a
 * client.
 *
 * The whole simulation is a projection of elapsed server time, so the bot is
 * always exactly as far along as it should be — no accumulation, no drift, and
 * a read that happens late still reports the correct position.
 */
export function aiSeatRaceAt({
  difficulty,
  passageLength,
  goAtMs,
  nowMs,
  current,
}: {
  difficulty?: unknown;
  passageLength: unknown;
  goAtMs: number | null;
  nowMs: number;
  current?: SeatRace | null;
}): SeatRace {
  const seat = current ?? emptySeatRace();
  if (seat.finished || seat.forfeited) return seat;

  const length = Math.max(0, Math.floor(Number(passageLength) || 0));
  if (length <= 0 || goAtMs == null) return seat;
  if (nowMs < goAtMs) return seat;

  const { charsPerMs, errorRate } = aiTypingProfile(difficulty);

  // The instant the bot completes the passage, and the elapsed time it took.
  const finishElapsedMs = Math.ceil(length / charsPerMs);
  const elapsedMs = Math.min(
    Math.max(0, Math.floor(nowMs - goAtMs)),
    RACE_LIMIT_MS,
  );

  if (elapsedMs >= finishElapsedMs) {
    const errors = errorsFor(length, errorRate);
    const correctChars = Math.max(0, length - errors);
    const minutes = finishElapsedMs > 0 ? finishElapsedMs / 60_000 : 0;
    const wpm = minutes > 0 ? Math.round(correctChars / CHARS_PER_WORD / minutes) : 0;
    const accuracy = length > 0 ? Math.round((correctChars / length) * 100) : 0;
    return {
      ...seat,
      charsTyped: length,
      errors,
      finished: true,
      finishedAtMs: goAtMs + finishElapsedMs,
      elapsedMs: finishElapsedMs,
      wpm,
      accuracy,
      updatedAtMs: goAtMs + finishElapsedMs,
    };
  }

  const charsTyped = Math.min(length, Math.floor(charsPerMs * elapsedMs));
  if (charsTyped <= seat.charsTyped) return seat;

  return {
    ...seat,
    charsTyped,
    errors: Math.max(seat.errors, errorsFor(charsTyped, errorRate)),
    updatedAtMs: goAtMs + elapsedMs,
  };
}
