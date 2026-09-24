// src/lib/crash-arena/botStrategy.js
//
// Client-safe fold strategy for the Crash Arena AI bots (practice tables
// and private-table AI seats).
//
// The bot behaves like a real player: at hand start it secretly commits to
// a fold multiplier (its "target"). The client watches the shared curve
// and submits the bot's fold through the server-authoritative
// /api/crash-arena/action route (`forBot: true`) the moment the multiplier
// reaches the target — exactly like a human clicking Fold. The bot never
// knows the crash point; it just decides how long to ride the curve.
//
// Difficulty heuristics (mirror the poker table AIs' easy/medium/hard):
//   • easy   — folds early (low target band) and often busts → easy to beat.
//   • medium — balanced: a mid-curve fold.
//   • hard   — pushes close to the crash range and rarely folds early → you
//              must outlast it to beat it.

import { CRASH_MIN, CRASH_MAX } from "../crash-poker/constants.js";

/** Difficulty picker values (shared with the lobby + create-ai route). */
export const CRASH_AI_DIFFICULTIES = ["easy", "medium", "hard"];

/**
 * Per-difficulty fold-target band: [lo, hi] fraction of the crash RANGE
 * (1.2x–9.2x) the bot commits to fold at.
 */
const DIFFICULTY_CONFIG = {
  easy: {
    // 1.2 → 3.6x — folds early, rarely wins the pot.
    foldRange: [0.0, 0.3],
  },
  medium: {
    // 2.4 → 5.6x — a mid-curve fold.
    foldRange: [0.15, 0.55],
  },
  hard: {
    // 4.0 → 8.4x — pushes deep into the danger zone.
    foldRange: [0.35, 0.9],
  },
};

/**
 * The tier a seat is stored AS. Crash Arena's seats and rows already hold
 * `medium` from before the shared difficulty scale existed, so the stored
 * vocabulary stays `easy | medium | hard` and `normal` is accepted as an alias
 * for it. Renaming the column would need a data migration for existing rows,
 * which is not worth a label; `crashAiDifficultyLabel` renders the canonical
 * wording instead so the player never sees two names for one tier.
 *
 * @param {unknown} value anything a lobby, route or stored row hands over
 * @returns {"easy" | "medium" | "hard"}
 */
export function toCrashAiDifficulty(value) {
  if (CRASH_AI_DIFFICULTIES.includes(value)) return value;
  // The canonical scale's names, plus the spellings the shared module coerces.
  if (value === "normal" || value === "medium") return "medium";
  if (value === "hard" || value === "expert" || value === "pro") return "hard";
  if (value === "easy" || value === "casual" || value === "beginner") return "easy";
  return "medium";
}

/**
 * The label to SHOW for a tier — the canonical Easy / Normal / Hard wording, so
 * a player who picked "Normal" in the lobby does not then see "medium" on the
 * table. Display only; the stored value is unchanged.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function crashAiDifficultyLabel(value) {
  const key = toCrashAiDifficulty(value);
  return key === "easy" ? "Easy" : key === "hard" ? "Hard" : "Normal";
}

/**
 * Pick the multiplier the bot commits to folding at for a hand.
 *
 * @param {string} [difficulty] canonical `easy | normal | hard`, or this game's
 *   stored `easy | medium | hard` (defaults to the `medium`/`normal` band)
 * @returns {number} the bot's fold target multiplier, rounded to 2 decimals
 */
export function getCrashBotFoldTarget(difficulty = "medium") {
  const cfg = DIFFICULTY_CONFIG[toCrashAiDifficulty(difficulty)] || DIFFICULTY_CONFIG.medium;
  const [lo, hi] = cfg.foldRange;
  const target = CRASH_MIN + (lo + Math.random() * (hi - lo)) * (CRASH_MAX - CRASH_MIN);
  return Number(Math.min(CRASH_MAX, Math.max(CRASH_MIN, target)).toFixed(2));
}

/**
 * Whether the bot should fold RIGHT NOW.
 *
 * @param {object} ctx
 * @param {number} ctx.multiplier  current curve multiplier
 * @param {number} ctx.target      the bot's committed fold target
 * @param {boolean} [ctx.allIn]    all-in bots are committed and never fold
 * @returns {boolean}
 */
export function getCrashBotFoldDecision({ multiplier, target, allIn = false }) {
  if (allIn) return false;
  const m = Number(multiplier);
  const t = Number(target);
  if (!Number.isFinite(m) || !Number.isFinite(t)) return false;
  return m >= t;
}