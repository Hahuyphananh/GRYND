/**
 * Chess VS-AI difficulty — the CHESS-FACING vocabulary and the engine settings
 * each tier resolves to.
 *
 * WHY THIS IS SEPARATE FROM src/lib/aiDifficulty.ts
 * ------------------------------------------------
 * `aiDifficulty.ts` is the CASINO-WIDE scale (`easy | normal | hard`) shared by
 * every AI-capable game, and its `coerceAiDifficulty` already maps this repo's
 * historical spellings onto it. Chess is the one game whose lobby shipped the
 * tiers as `easy | medium | hard`, so `medium` is chess's name for the shared
 * `normal` — this module owns that translation in ONE place instead of every
 * call site inventing it.
 *
 * The stored column (`chess_games.ai_difficulty`) carries the CHESS spelling
 * (`easy | medium | hard`), which is what the migration's CHECK constraint
 * enforces. The shared tier is only used to pick the slip policy.
 *
 * WHERE THE WEAKNESS ACTUALLY COMES FROM
 * --------------------------------------
 * Decision: "Easy should be noticeably beginner-friendly, verified through
 * testing rather than assumed from search duration." A shorter `movetime` alone
 * does NOT make a chess engine beginner-friendly — Stockfish at 50 ms still
 * plays the best move it can see, and its "best move it can see" is stronger
 * than a beginner. So the tier is the composition of two independent dials:
 *
 *   1. `skillLevel` — Stockfish's own Skill Level option (0–20). This is the
 *      primary dial: it internally caps the search and randomises its choice,
 *      which is what produces genuinely weaker, human-like play rather than
 *      merely shallower-but-correct play.
 *   2. The SLIP — after the engine ranks its candidate moves (`MultiPV`), a
 *      weaker tier may deliberately take a worse candidate, via the shared
 *      `chooseAiOption` policy every other game's AI already uses. `hard` never
 *      slips.
 *
 * `moveTimeMs` is a BUDGET CEILING, not the difficulty dial. Chess searches are
 * wall-clock capped on purpose (see the engine's `go depth N movetime M`), so
 * raising the budget buys strength that the tier does not want.
 *
 * THIS MODULE IS PURE: no engine import, no I/O, no database. The engine bounds
 * it must respect are asserted against the engine's own constants in
 * tests/chess-gameplay-engine.test.mjs, so the two cannot drift apart silently.
 */

import { AI_SKILL, type AiDifficulty } from "./aiDifficulty";

/** The three shipped tiers. Order matters: weakest → strongest. */
export type ChessAiDifficulty = "easy" | "medium" | "hard";

/** Canonical order, weakest → strongest. Render any picker from this. */
export const CHESS_AI_DIFFICULTIES: readonly ChessAiDifficulty[] = Object.freeze([
  "easy",
  "medium",
  "hard",
] as const);

/**
 * What a VS-AI game plays at when the row records no tier.
 *
 * `medium` is the middle tier, and it is also what the migration backfills onto
 * every pre-existing AI row — the two must agree, which
 * tests/chess-ai-difficulty-schema.test.mjs asserts.
 */
export const DEFAULT_CHESS_AI_DIFFICULTY: ChessAiDifficulty = "medium";

/** The longest search ANY tier may ask for (ms). The approved 500 ms budget. */
export const MAX_CHESS_AI_MOVE_TIME_MS = 500;

/** The deepest search ANY tier may ask for. */
export const MAX_CHESS_AI_DEPTH = 12;

/**
 * Skill Level bounds, mirrored from the engine's own clamps so this module can
 * stay pure. The test suite asserts these equal the engine's constants.
 */
export const MIN_CHESS_AI_SKILL_LEVEL = 0;
export const MAX_CHESS_AI_SKILL_LEVEL = 20;

/** Human-facing labels, kept beside the vocabulary so they cannot drift. */
export const CHESS_AI_DIFFICULTY_LABELS: Record<ChessAiDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/**
 * The engine settings a tier resolves to.
 *
 * `slipTier` is the shared `aiDifficulty` tier whose slip policy applies, or
 * `null` for "never slip — play the engine's best move".
 */
export type ChessAiSearchSettings = {
  /** Stockfish `Skill Level` (0–20). The primary strength dial. */
  skillLevel: number;
  /** Search depth ceiling. The `movetime` cap normally bites first. */
  depth: number;
  /** Hard per-move time cap (ms). A budget ceiling, never above the approved max. */
  moveTimeMs: number;
  /** MultiPV width — how many ranked candidates the slip may choose from. */
  multiPv: number;
  /** Shared slip policy, or null to always play the engine's best move. */
  slipTier: AiDifficulty | null;
};

/**
 * The tier table.
 *
 * `easy` sits at Skill Level 0 with a 2-ply ceiling, a 5-wide candidate list and
 * the shared `easy` slip (which takes a worse candidate more than half the time)
 * — the combination the tests prove is weaker than `hard`, rather than a shorter
 * clock that would only make it faster.
 *
 * `hard` is full strength (Skill Level 20, Stockfish's default), the deepest
 * search, a single candidate, and no slip: it plays the engine's own best move.
 * The 500 ms budget is at its ceiling.
 */
export const CHESS_AI_SEARCH_SETTINGS: Record<
  ChessAiDifficulty,
  ChessAiSearchSettings
> = {
  easy: { skillLevel: 0, depth: 2, moveTimeMs: 150, multiPv: 5, slipTier: "easy" },
  medium: { skillLevel: 8, depth: 6, moveTimeMs: 300, multiPv: 4, slipTier: "normal" },
  hard: { skillLevel: MAX_CHESS_AI_SKILL_LEVEL, depth: MAX_CHESS_AI_DEPTH, moveTimeMs: 500, multiPv: 1, slipTier: null },
};

/**
 * The legacy 1–5 numeric level each tier corresponds to.
 *
 * Chess's picker shipped a numeric scale before the tier vocabulary existed, and
 * that number is still load-bearing in two places: it is what the lobby puts in
 * the `/casino/chess/ai` URL (the AI page reads it as `aiLevel` for its
 * display), and it is what a cached pre-tier client sends as
 * `difficultyLevel`. Deriving it in ONE place is what keeps the tier the user
 * picked and the number the client shows from drifting apart.
 *
 * It is also the exact inverse of `coerceChessAiDifficulty`'s numeric branch
 * (1–2 → easy, 3 → medium, 4–5 → hard), which is asserted in
 * tests/chess-ai-seats.test.mjs.
 */
export const CHESS_AI_DIFFICULTY_LEVELS: Record<ChessAiDifficulty, number> = {
  easy: 2,
  medium: 3,
  hard: 5,
};

/** True for a canonical CHESS tier. The ONLY strict test — use it to validate. */
export function isChessAiDifficulty(value: unknown): value is ChessAiDifficulty {
  return value === "easy" || value === "medium" || value === "hard";
}

/**
 * Map ANY historical spelling onto a canonical chess tier. Never throws.
 *
 * Deliberately tolerant, and for the same reason `coerceAiDifficulty` is: this
 * runs on values arriving from a client, a URL parameter, or a legacy row, and
 * none of those may take a game down. Route-level validation that must REJECT
 * bad input uses `isChessAiDifficulty` instead.
 *
 * Accepted: the canonical tiers; the shared scale's `normal` (→ `medium`); the
 * aliases the shared coercer understands (`beginner`, `expert`, `pro`, ...);
 * and chess's own numeric levels 1–5 (1–2 easy, 3 medium, 4–5 hard).
 */
export function coerceChessAiDifficulty(value: unknown): ChessAiDifficulty {
  if (isChessAiDifficulty(value)) return value;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 2) return "easy";
    if (value >= 4) return "hard";
    return "medium";
  }

  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (isChessAiDifficulty(key)) return key;
    // The shared scale's middle tier is chess's `medium`.
    if (key === "normal") return "medium";
    if (key === "medium" || key === "moderate" || key === "average") return "medium";
    if (key === "casual" || key === "beginner" || key === "novice" || key === "easy-ai") {
      return "easy";
    }
    if (key === "expert" || key === "pro" || key === "advanced" || key === "insane") {
      return "hard";
    }
    // Only a NON-EMPTY string is parsed as a number: `Number("")` is 0, which
    // would quietly weaken the bot for a player who never chose a tier.
    if (key.length > 0) {
      const numeric = Number(key);
      if (Number.isFinite(numeric)) return coerceChessAiDifficulty(numeric);
    }
  }

  return DEFAULT_CHESS_AI_DIFFICULTY;
}

/**
 * The resolved settings for a tier. Accepts `unknown` and coerces, so a caller
 * can never be handed `undefined` — a game must not break on a bad tier.
 */
export function settingsForChessAiDifficulty(value: unknown): ChessAiSearchSettings {
  return CHESS_AI_SEARCH_SETTINGS[coerceChessAiDifficulty(value)];
}

/**
 * The tier a `chess_games` row carries, read by anything that needs to know how
 * strong the opponent was.
 *
 * A PvP row (and every row written before migration 0211) has NULL here, which
 * is what the documented default is for. Mirrors `aiDifficultyFromMatch` in
 * src/lib/aiDifficulty.ts — same shape, chess vocabulary.
 */
export function chessAiDifficultyFromMatch(
  match: { aiDifficulty?: unknown } | null | undefined,
): ChessAiDifficulty {
  return coerceChessAiDifficulty(match?.aiDifficulty);
}

/**
 * The slip rate a tier applies, exposed for tests and for any UI that wants to
 * describe the tier. `null` means the tier never slips.
 */
export function chessAiSlipRate(difficulty: unknown): number | null {
  const { slipTier } = settingsForChessAiDifficulty(difficulty);
  return slipTier === null ? null : AI_SKILL[slipTier].mistakeRate;
}
