/**
 * Game Evaluation — the LLM half's contract.
 *
 * The objective half (src/lib/evaluation/games/chessEvaluator.ts) produces real,
 * machine-computed stats. This module turns those stats into a prompt, and
 * defines the shape the model must answer in. Nothing here computes a chess
 * fact: the prompt's entire job is to make the model DESCRIBE numbers it was
 * handed, never produce its own.
 *
 * ANTI-HALLUCINATION RULES (why the prompt is so explicit)
 * --------------------------------------------------------
 * A model asked to "review this game" will happily invent a knight that was
 * never on f3, round 9921 centipawns into "about 9 pawns", or praise a player
 * for a move the engine called a blunder. The prompt therefore:
 *   - embeds the ENTIRE objective payload verbatim, so every fact the model can
 *     state is already in the message,
 *   - names the failing behaviours outright (no invented moves, numbers, clock
 *     times, players or results),
 *   - requires quoted numbers to be copied exactly,
 *   - requires the engine identity to be treated as authoritative (the model is
 *     explicitly told it was not the one who judged the game),
 *   - tells it to OMIT a category rather than pad it — the schema keeps every
 *     section optional except `summary`.
 *
 * The response schema is deliberately flat and cheap for the provider to
 * satisfy: the Groq provider only accepts JSON, and its local shape check
 * (src/lib/evaluation/providers/groqProvider.ts) verifies the root object and
 * the declared property types before anything is persisted.
 */

import type { ChessObjectiveData } from "./games/chessEvaluator";

/** A single "why this move mattered" bullet. */
export type EvaluationKeyMoment = {
  /** Move reference exactly as it appears in the objective data, e.g. "12... Bxd1". */
  move: string;
  note: string;
};

/** The model's structured answer. Every section except `summary` is optional. */
export type EvaluationInsight = {
  summary: string;
  strengths?: string[];
  weaknesses?: string[];
  key_moments?: EvaluationKeyMoment[];
  improvements?: string[];
  next_time_tip?: string;
};

/**
 * JSON Schema handed to the provider (and used for its local shape check).
 *
 * `summary` is the only required key: a model that can only manage one sentence
 * should still return a usable result. The optional sections must be OMITTED
 * when the data does not support them, never filled with placeholders — the
 * prompt says so, and the client renders whatever is present.
 */
export const EVALUATION_INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    key_moments: { type: "array", items: { type: "object" } },
    improvements: { type: "array", items: { type: "string" } },
    next_time_tip: { type: "string" },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

/**
 * Shown in place of `insight` when the provider fails. The user still gets the
 * real objective stats — this is never a substitute for them.
 */
export const AI_UNAVAILABLE_MESSAGE =
  "AI analysis is temporarily unavailable. Your objective match statistics are shown below and were still computed from your game.";

/**
 * The colour the requesting player had, when it could be resolved. Tells the
 * model to write about THEIR game rather than describing both sides neutrally.
 */
export type PlayerPerspective = "white" | "black" | null;

/**
 * Builds the chess evaluation prompt: the instructions, then the objective
 * data verbatim.
 *
 * The JSON is embedded whole (not summarised) so that every number the model
 * quotes is present in the message it received — which is what makes the
 * "only state facts from the data" rule checkable after the fact.
 */
export function buildChessEvaluationPrompt(
  objective: ChessObjectiveData,
  perspective: PlayerPerspective = null,
): string {
  const who =
    perspective === "white"
      ? "The player reading this played WHITE."
      : perspective === "black"
        ? "The player reading this played BLACK."
        : "The perspective of the player reading this is unknown; describe the game without assuming which side they played.";

  return [
    "You are GRYND's post-match chess coach. A Stockfish engine and a statistics",
    "pipeline have already analysed ONE game. Your job is to EXPLAIN that analysis",
    "to the player in plain, encouraging language.",
    "",
    "HARD RULES — violating any of these makes your answer worthless:",
    "1. Use ONLY the facts inside the OBJECTIVE_DATA JSON below. It is the complete,",
    "   authoritative record of this game.",
    "2. NEVER invent a move, a capture, a piece, an opening name, an evaluation",
    "   number, a clock time, a player, a rating, or a result. If it is not in the",
    "   JSON, you do not know it and must not say it.",
    "3. Any number you quote must be copied EXACTLY from the JSON (centipawn values,",
    "   accuracyPercent, averageCpLoss, move counts, think times). Do not round",
    "   centipawns into 'pawns', do not convert or recompute them.",
    "4. You did NOT judge this game. The engine did — its id is in `engine.id` and",
    "   the search settings in `engine.depth` / `engine.moveTimeMs`. Refer to it as",
    "   the engine's evaluation, and never contradict it.",
    "5. Reference moves exactly as the data does: use the stored `san` with its",
    '   `moveNumber` and side, e.g. "12... Bxd1". The most consequential move is',
    "   already identified as `keyMoment` — use it, and do not promote another move",
    "   to 'the decisive moment' unless the data supports it.",
    `6. ${who}`,
    "7. A shallow engine search can mislabel a deliberate sacrifice as a blunder;",
    "   if you mention a classification, attribute it to the engine's search depth",
    "   rather than asserting it as an absolute judgment.",
    "8. If the data does not support a section, OMIT that key completely. Never",
    '   output empty arrays, "N/A", "unknown", or filler sentences.',
    "9. Be specific and kind. No shaming, no gambling talk, no predictions about",
    "   future wins.",
    "",
    "ANSWER FORMAT: reply with a single JSON object and nothing else.",
    "- summary: 2-4 sentences describing how the game went, for the player reading.",
    "- strengths: 1-4 short bullets, only where the data shows them",
    '  (e.g. high accuracyPercent, few blunders, moves that matched engineBestMoveUci).',
    "- weaknesses: 1-4 short bullets, only where the data shows them",
    "  (e.g. blunders/mistakes with their move numbers and cpLoss).",
    "- key_moments: at most 3 objects { move, note } for the moves that changed the",
    "  evaluation most (start from `keyMoment` and the `blunders` list).",
    "- improvements: 2-4 concrete, actionable bullets.",
    "- next_time_tip: one sentence the player can apply in their next game.",
    "Omit any of these keys the data does not support. `summary` is always required.",
    "",
    "OBJECTIVE_DATA (verbatim, machine-computed):",
    JSON.stringify(objective),
  ].join("\n");
}
