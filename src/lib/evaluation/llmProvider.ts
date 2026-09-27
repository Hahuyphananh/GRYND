/**
 * Provider-agnostic LLM interface for the Game Evaluation feature.
 *
 * The evaluation pipeline computes a game's objective stats server-side and
 * asks a model to turn them into structured coaching feedback. This module
 * defines ONLY the contract — no provider, transport or SDK detail belongs
 * here, so a new backend (Groq, OpenAI, Anthropic, a local model, a stub in
 * tests) can be dropped in behind the same interface.
 *
 * Implementations live in src/lib/evaluation/providers/* and must:
 *   - never throw: every failure path resolves to `{ success: false, error }`
 *     so callers never need a try/catch around a provider call,
 *   - never echo credentials/secrets in `error` (errors are persisted on the
 *     evaluation row),
 *   - resolve `data` to a parsed, structurally valid JSON object, not a raw
 *     model string.
 *
 * Nothing calls a provider yet — this is infrastructure only.
 */

/** Provider call succeeded; `data` is the parsed, shape-checked JSON object. */
export type LLMEvaluationSuccess = {
  success: true;
  data: object;
};

/** Provider call failed; `error` is a short, human-readable, secret-free reason. */
export type LLMEvaluationFailure = {
  success: false;
  error: string;
};

export type LLMEvaluationResult = LLMEvaluationSuccess | LLMEvaluationFailure;

export interface LLMProvider {
  /**
   * Generate one structured evaluation.
   *
   * @param prompt The fully-composed instruction for the model (the caller
   *   owns prompt construction; concrete objective stats are already in it).
   * @param schema A JSON-Schema-shaped description of the required output.
   *   Providers use it to constrain generation where the backend supports it
   *   and to validate the parsed result before returning success, so callers
   *   can rely on `data` matching the declared shape.
   */
  generateEvaluation(prompt: string, schema: object): Promise<LLMEvaluationResult>;
}
