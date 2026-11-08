// src/lib/aiDifficulty.ts
//
// The ONE AI-difficulty vocabulary for the casino games.
//
// Before this module every game that had a difficulty invented its own: chess
// numbered its levels 1–5, hex-duel used `easy | medium`, lane-runner keyed off
// bridge tile widths, dice-flush and the crash tables used `easy | medium
// | hard`, and pool-masters used `easy | normal | hard`. The lobby pickers were
// hand-rolled per game, so the same concept had four spellings and there was
// nothing to reuse when a game gained an AI mode.
//
// `easy | normal | hard` is the canonical scale. `coerceAiDifficulty` maps every
// legacy spelling onto it, which is what lets a lobby accept whatever an older
// client (or a stored preference) still sends.
//
// Deliberately NOT marked "use client": the vocabulary and the skill table are
// imported by server routes too (to validate an incoming `difficulty`), and only
// the storage helpers below touch `window` — each guarded, so importing this
// from a route stays safe.
//
// See `components/lobby/AiDifficultyPicker` for the lobby control, and
// `chooseAiOption` for the shared policy hook the game AIs use to express a
// tier without each hand-rolling one.

export type AiDifficulty = "easy" | "normal" | "hard";

/** Canonical order, weakest → strongest. Render the picker from this. */
export const AI_DIFFICULTIES: AiDifficulty[] = ["easy", "normal", "hard"];

/** What a game plays at when nothing was chosen. */
export const DEFAULT_AI_DIFFICULTY: AiDifficulty = "normal";

/** Display labels (kept next to the vocabulary so they cannot drift). */
export const AI_DIFFICULTY_LABELS: Record<AiDifficulty, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
};

/**
 * The skill knobs a tier maps to. Games read these instead of inventing their
 * own numbers, so "Hard" means the same thing everywhere:
 *
 *   * `mistakeRate` — how often the agent deliberately takes a WORSE option
 *     than the one it found. This is the primary dial: an easy opponent must be
 *     beatable by a beginner, which means it has to blunder, not merely search
 *     less deeply.
 *   * `lookahead`   — how many plies/options deep the agent searches before it
 *     has to choose. 1 = reacts only, 3 = plans ahead.
 *   * `slipPool`    — when it slips, how many of the BEST options it is allowed
 *     to fall back to. 1 would mean "never slips", so this also bounds how bad
 *     a blunder can be: an easy agent picks a mediocre move, not an absurd one
 *     (a dice game scoring 0 instead of 30 reads as broken, not as easy).
 */
export const AI_SKILL: Record<
  AiDifficulty,
  { mistakeRate: number; lookahead: number; slipPool: number }
> = {
  // These numbers were raised deliberately. The tiers used to be so close (and
  // so mild) that changing the picker barely changed the game: `normal` slipped
  // 12% of the time onto one of the top three options — usually a move that was
  // just as good — and `hard` never slipped at all. Every tier is now clearly
  // worse and clearly separated:
  //
  //   * `easy`   — slips over half the time, and can fall a long way down the
  //                ranking, so it is genuinely beatable by a beginner.
  //   * `normal` — slips about a quarter of the time over a wide pool.
  //   * `hard`   — still the strongest tier, but NO LONGER PERFECT: a small
  //                mistake rate keeps it beatable instead of unbeatable.
  easy: { mistakeRate: 0.55, lookahead: 1, slipPool: 6 },
  normal: { mistakeRate: 0.25, lookahead: 2, slipPool: 5 },
  hard: { mistakeRate: 0.08, lookahead: 3, slipPool: 3 },
};

/** True for a canonical tier. */
export function isAiDifficulty(value: unknown): value is AiDifficulty {
  return value === "easy" || value === "normal" || value === "hard";
}

/**
 * Map ANY historical spelling onto the canonical scale.
 *
 * Handles the vocabularies this repo actually shipped:
 *   * `medium`        → `normal` (hex-duel, and the dice-flush default)
 *   * `casual`        → `easy`   (four-in-a-row's static label)
 *   * `beginner`      → `easy`, `expert`/`pro` → `hard`
 *   * chess's `1–5`   → 1–2 `easy`, 3 `normal`, 4–5 `hard`
 *   * numeric strings of the above
 *
 * Anything unrecognised falls back to the default rather than throwing: this
 * runs on values arriving from a client, a stored preference, or an older
 * payload, and none of those may take a game down.
 */
export function coerceAiDifficulty(value: unknown): AiDifficulty {
  if (isAiDifficulty(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 2) return "easy";
    if (value >= 4) return "hard";
    return "normal";
  }
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (isAiDifficulty(key)) return key;
    if (key === "medium" || key === "moderate" || key === "average") return "normal";
    if (key === "casual" || key === "beginner" || key === "novice" || key === "easy-ai") {
      return "easy";
    }
    if (key === "expert" || key === "pro" || key === "advanced" || key === "insane") {
      return "hard";
    }
    // Only parse a NON-EMPTY string as a number: `Number("")` is 0, which
    // would silently coerce a blank field (or whitespace) to `easy` and quietly
    // weaken the bot for a player who never picked a difficulty.
    if (key.length > 0) {
      const numeric = Number(key);
      if (Number.isFinite(numeric)) return coerceAiDifficulty(numeric);
    }
  }
  return DEFAULT_AI_DIFFICULTY;
}

/** The full skill table row for a tier (defaults on anything unrecognised). */
export function aiSkill(difficulty: unknown) {
  const tier = coerceAiDifficulty(difficulty);
  return { tier, ...AI_SKILL[tier] };
}

/**
 * The tier an AI match row carries, read by the server-side game AIs.
 *
 * Every AI-capable match table gained an `aiDifficulty` column (see migration
 * 0166), so a game's store/AI only has to hand its row here instead of each
 * spelling its own fallback. Legacy rows (and PvP rows) have none, which is
 * what the `normal` default is for.
 */
export function aiDifficultyFromMatch(
  match: { aiDifficulty?: unknown } | null | undefined
): AiDifficulty {
  return coerceAiDifficulty(match?.aiDifficulty);
}

/** How often this tier deliberately plays a worse option (0–1). */
export function aiMistakeRate(difficulty: AiDifficulty): number {
  return AI_SKILL[difficulty].mistakeRate;
}

/** How deep this tier searches before choosing. */
export function aiLookahead(difficulty: AiDifficulty): number {
  return AI_SKILL[difficulty].lookahead;
}

/**
 * The shared tier policy: pick one of `options`, where `scoreOf` says how good
 * an option is (higher = better).
 *
 * Every tier rolls against `mistakeRate` and, when it slips, takes a worse one
 * — so a weaker opponent loses games it could have saved, which is what makes
 * it beatable, rather than just searching less and still playing perfectly. A
 * slip is drawn from the top `slipPool` options only, so a blunder is a WEAKER
 * move and never an absurd one.
 *
 * `slipFloor` caps how bad a slip may be as a fraction of the best option's
 * score: a slip never falls below `best · slipFloor`, so an easy agent plays a
 * mediocre move rather than a self-destructive one. Callers whose scores are not
 * comparable on a ratio scale (a constant like `Infinity`, or negatives) should
 * pass `slipFloor: 0` to opt out of the cap.
 *
 * `random` is injectable so the AI stays deterministic under test.
 */
export function chooseAiOption<T>(
  difficulty: AiDifficulty,
  options: readonly T[],
  scoreOf: (option: T) => number,
  random: () => number = Math.random,
  slipFloor = 0.5
): T | null {
  if (options.length === 0) return null;
  const ranked = [...options].sort((a, b) => scoreOf(b) - scoreOf(a));
  const best = ranked[0];
  const tier = coerceAiDifficulty(difficulty);
  const { slipPool } = AI_SKILL[tier];
  if (random() >= aiMistakeRate(tier)) return best;
  // Slipped: take a worse option — never the best one, since taking the best is
  // not a mistake.
  let worse = ranked.slice(1, Math.max(2, slipPool));
  // Cap how bad the slip may be, so an easy agent plays a weak move rather than
  // a ruinous one. Skipped when the caller opts out or the scores do not form a
  // usable ratio (a non-positive or non-finite best).
  const bestScore = scoreOf(best);
  if (slipFloor > 0 && Number.isFinite(bestScore) && bestScore > 0) {
    const floor = bestScore * slipFloor;
    const capped = worse.filter((option) => scoreOf(option) >= floor);
    if (capped.length > 0) worse = capped;
  }
  if (worse.length === 0) return best;
  return worse[Math.floor(random() * worse.length) % worse.length];
}

// ── Lobby persistence ────────────────────────────────────────────────────
// The picker's choice is remembered per game, so a returning player does not
// have to re-pick it every visit. Keyed by game so one game's tier never
// overwrites another's.

const STORAGE_PREFIX = "grynd_ai_difficulty:";

function storageKey(gameKey: string): string {
  return `${STORAGE_PREFIX}${gameKey}`;
}

/**
 * The stored tier for a game, or `fallback` (the shared default when omitted).
 * Safe on the server.
 *
 * The fallback exists for games whose pre-tier behaviour was NOT `normal`:
 * mini-golf shipped one fixed, strong bot, so its lobby defaults to `hard` and
 * only weakens once the player picks a tier. Storage still wins, so an explicit
 * choice is never overridden.
 */
export function readStoredAiDifficulty(
  gameKey: string,
  fallback: AiDifficulty = DEFAULT_AI_DIFFICULTY
): AiDifficulty {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey(gameKey));
    return stored === null ? fallback : coerceAiDifficulty(stored);
  } catch {
    return fallback;
  }
}

/** Remember the tier for a game. Best-effort — storage may be unavailable. */
export function storeAiDifficulty(gameKey: string, difficulty: AiDifficulty): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(gameKey), coerceAiDifficulty(difficulty));
  } catch {
    // storage unavailable — the in-memory choice still drives this session
  }
}
