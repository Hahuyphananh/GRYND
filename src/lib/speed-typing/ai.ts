// src/lib/speed-typing/ai.ts
//
// The Speed Typing practice bot. PURE: given the passage the server resolved
// for the match and the server's own clock, it says exactly how far the bot has
// typed and whether it has finished. No database, no socket, no randomness.
//
// WHY THIS SHAPE: Speed Typing is a real-time race, so the bot is NOT a
// turn-based move generator. The authoritative state is a per-seat cursor into
// the server's passage, so the bot is modelled as a typing SPEED — a constant
// characters-per-millisecond rate derived from the shared difficulty tier.
// Every read of the match advances the bot's cursor to "now", exactly as if it
// had been typing all along, which is what guarantees it always plays and never
// skips.
//
// THE BOT TYPES THE PASSAGE PERFECTLY, AT EXACTLY ITS ANNOUNCED WPM.
//
// That is not a flavour choice; it is what makes the number a player reads
// agree with the verdict they are given. The game's WPM is derived from
// CORRECT characters (see `raceMetrics` in ./rules.ts), and a race is decided by
// who completes the passage first — so a bot that finished with `errors` still
// on its record was racing a SHORTER passage than its opponent:
//
//   * it declared itself done after `length` keystrokes, `errors` of which were
//     wrong, while the rules require every position to match;
//   * the WPM it announced was `correct ÷ elapsed`, i.e. its tier rate
//     DISCOUNTED by mistakes it never paid for in time;
//   * so it could beat a typist whose announced WPM was higher, and the slower
//     number on the result screen belonged to the seat that won. A player at
//     44 wpm lost to a bot announced at 43.
//
// An `errors: 0` seat makes those two facts one: reaching the end IS
// every character matching, so the announced WPM is exactly the pace that
// decides the race (see the invariant pinned by tests/speed-typing-ai.test.mjs).
// The bot's mistake-FREE finish is also what its tier means: a bot whose
// mistakes cost it nothing is not a weaker typist, it is a faster one.
//
// The finish TIMES are unchanged by this: the cursor has always advanced at the
// tier rate, so this corrects the labels, never the difficulty.
//
// The tier knobs come from the shared scale (src/lib/aiDifficulty.ts):
//
//   * easy   — a much slower typist; a beginner beats it comfortably.
//   * normal — a solid amateur pace, beatable by a fast typist.
//   * hard   — a strong pace; only a genuinely quick run beats it.
//
// The bot never reads or writes anything: `aiSeatRaceAt` is a pure projection
// of (passageLength, difficulty, goAtMs, nowMs) onto a seat state, and it is
// MONOTONIC — it never moves a seat backwards and never revives a finished or
// forfeited seat, so calling it twice (or out of order) is always safe.

import { coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import { RACE_LIMIT_MS } from "./constants";
import { emptySeatRace, raceMetrics, type SeatRace } from "./rules";

/**
 * Words-per-minute the bot types at, per tier — and, because it types the
 * passage perfectly, the numbers a player reads on its seat and on the result
 * screen are exactly these.
 *
 * Chosen against the shipped catalog (25-45 words per passage) so every tier
 * finishes comfortably inside the 120 s hard limit while still being beatable:
 * a fast human types 60-80 wpm, so `normal` at 45 is a real race and `hard` at
 * 65 demands a genuinely quick typist. The bot's finish time is
 * `passageLength ÷ (wpm * 5 / 60_000)` ms after GO, so a flawless typist at the
 * same wpm reaches the end at the same instant — a dead heat — and one wpm
 * faster wins.
 */
export const AI_TYPING_WPM: Record<AiDifficulty, number> = {
  easy: 30,
  normal: 45,
  hard: 65,
};

/** The five-characters-to-a-word convention the rules engine uses for WPM. */
const CHARS_PER_WORD = 5;

/**
 * The bot's typing profile for a tier: how many characters it covers per
 * millisecond.
 *
 * `charsPerMs` is the tier's WPM in the same five-characters-to-a-word
 * convention `raceMetrics` uses, so the cursor reaches the end of a passage at
 * exactly the instant that WPM implies, and the WPM frozen onto its seat at
 * that instant is the tier's own number.
 */
export function aiTypingProfile(difficulty: unknown): {
  tier: AiDifficulty;
  wpm: number;
  charsPerMs: number;
} {
  const tier = coerceAiDifficulty(difficulty);
  const wpm = AI_TYPING_WPM[tier];
  return {
    tier,
    wpm,
    charsPerMs: (wpm * CHARS_PER_WORD) / 60_000,
  };
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
 *
 * The seat it returns is always ERROR-FREE: reaching the end of the passage and
 * matching every character are the same event, which is what keeps the bot's
 * announced WPM equal to the pace that decides the race (see the file header).
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

  const { charsPerMs } = aiTypingProfile(difficulty);

  // The instant the bot completes the passage, and the elapsed time it took.
  const finishElapsedMs = Math.ceil(length / charsPerMs);
  const elapsedMs = Math.min(
    Math.max(0, Math.floor(nowMs - goAtMs)),
    RACE_LIMIT_MS,
  );

  if (elapsedMs >= finishElapsedMs) {
    const finishedAtMs = goAtMs + finishElapsedMs;
    const completed: SeatRace = {
      ...seat,
      charsTyped: length,
      errors: 0,
      finished: true,
      finishedAtMs,
      forfeited: false,
      updatedAtMs: finishedAtMs,
    };
    // Elapsed time, WPM and accuracy come from the SHARED metric human seats
    // are measured by (./rules.ts) — never a second formula here. That is the
    // whole point: the number the bot is announced at is the number the same
    // rule derived, from the instant the same rule froze.
    const metrics = raceMetrics({ seat: completed, goAtMs, nowMs: finishedAtMs });
    return {
      ...completed,
      elapsedMs: metrics.elapsedMs,
      wpm: metrics.wpm,
      accuracy: metrics.accuracy,
    };
  }

  const charsTyped = Math.min(length, Math.floor(charsPerMs * elapsedMs));
  if (charsTyped <= seat.charsTyped) return seat;

  return {
    ...seat,
    charsTyped,
    errors: 0,
    updatedAtMs: goAtMs + elapsedMs,
  };
}
