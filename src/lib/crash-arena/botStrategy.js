// src/lib/crash-arena/botStrategy.js
//
// Client-safe cashout strategy for the Crash Arena practice bot.
//
// The bot behaves like a real player at the table: when a round starts
// it "sees" the same public crash point everyone sees and commits to a
// cashout multiplier. The client watches the running multiplier and
// triggers the bot's cashout the moment the curve reaches the commit
// point (via /api/crash-arena/ai-cashout, which the server validates
// against the real crash point exactly like a human cashout).
//
// The strategy is deliberately poker-AI flavoured (difficulty heuristics,
// no perfect play), mirroring the poker table AIs' easy/medium/hard seats:
//
//   • easy   — takes early, low exits and busts often → easy to beat.
//   • medium — balanced: a reasonable exit, greedy ~25% of the time.
//   • hard   — pushes close to the crash point and rarely busts → you
//              must time a near-crash cashout to beat it.

import { CRASH_MIN } from "../games/crash/constants";

/** Difficulty picker values (shared with the lobby + create-ai route). */
export const CRASH_AI_DIFFICULTIES = ["easy", "medium", "hard"];

/**
 * Per-difficulty behavior:
 *   greedyChance — probability the bot commits PAST the crash point and
 *                  busts this round (bad for the bot).
 *   safeRange    — [lo, hi] fraction of the crash point the bot exits at
 *                  when playing safe (hi < 1 so the cashout lands first).
 */
const DIFFICULTY_CONFIG = {
  easy: {
    greedyChance: 0.35,
    safeRange: [0.35, 0.6],
  },
  medium: {
    greedyChance: 0.25,
    safeRange: [0.55, 0.9],
  },
  hard: {
    greedyChance: 0.1,
    safeRange: [0.8, 0.97],
  },
};

/**
 * Pick the multiplier the bot commits to for a round.
 *
 * @param crashPoint Server-authoritative crash multiplier for the round
 *                   (public at the table while the round runs).
 * @param difficulty "easy" | "medium" | "hard" (defaults to "medium").
 * @returns {number} The bot's committed cashout multiplier (>= CRASH_MIN).
 */
export function getCrashBotCashoutTarget(crashPoint, difficulty = "medium") {
  const cp = Number(crashPoint);
  const safeCp = Number.isFinite(cp) && cp >= CRASH_MIN ? cp : CRASH_MIN;
  const cfg = DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.medium;

  // Greedy: commit past the crash point → the bot busts when it hits.
  if (Math.random() < cfg.greedyChance) {
    return Number((safeCp * (1.05 + Math.random() * 0.35)).toFixed(2));
  }

  // Safe: commit in the difficulty's band below the crash point (floor
  // CRASH_MIN, capped just under the crash point so the cashout lands
  // before it).
  const [lo, hi] = cfg.safeRange;
  const target = safeCp * (lo + Math.random() * (hi - lo));
  const floored = Math.max(CRASH_MIN, target);
  const capped = Math.min(floored, safeCp - 0.02);
  // When the crash point is at the floor (CRASH_MIN) there is no room
  // below it — play it safe at the floor; it resolves as a win when the
  // curve touches it, otherwise the crash gets there first (a bust).
  return Number(Math.max(capped, CRASH_MIN).toFixed(2));
}
