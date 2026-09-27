/**
 * Groq implementation of the LLMProvider contract (src/lib/evaluation/llmProvider.ts).
 *
 * Talks to Groq's OpenAI-compatible chat-completions REST API with plain
 * `fetch` — no SDK dependency is added, because the endpoint is wire-compatible
 * with OpenAI and we only need one call shape.
 *
 * Env: GROQ_API_KEY (server-only — never expose this with a NEXT_PUBLIC_ prefix),
 *      GROQ_MODEL (optional — see DEFAULT_GROQ_MODEL for why it is configurable).
 *
 * Design notes:
 *   - JSON mode: `response_format: { type: "json_object" }`. Groq requires the
 *     word "JSON" to appear in the input when JSON mode is on, so the system
 *     message always names it and states the required shape (the caller's
 *     `prompt` is passed through untouched).
 *   - The model's output is still treated as untrusted: it is parsed and
 *     shape-checked against `schema` before we report success, so a malformed
 *     or truncated response becomes a clean `{ success: false }` instead of
 *     corrupt JSON landing in `evaluation_results.ai_response`.
 *   - Never throws. Every failure resolves to `{ success: false, error }`.
 */

import type { LLMProvider, LLMEvaluationResult } from "../llmProvider";

/** OpenAI-compatible chat-completions endpoint. */
const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";

/**
 * Model used for game evaluations.
 *
 * NOTE: the originally specified `llama-3.3-70b-versatile` was RETIRED from
 * Groq's catalogue — a call with it now answers
 * `404 model_not_found`, verified against the live API with this project's key
 * (GET /openai/v1/models lists what the key can actually use). The default here
 * is the strongest general chat model that key does have access to.
 *
 * Override with GROQ_MODEL, so the next retirement is an env change rather than
 * a code change — `openai/gpt-oss-20b` is the cheaper/faster alternative for
 * the same task.
 */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/** The model this process will call (GROQ_MODEL wins when set). */
export function resolveGroqModel(): string {
  const configured = (process.env.GROQ_MODEL || "").trim();
  return configured || DEFAULT_GROQ_MODEL;
}

/** Hard ceiling on one provider call so a hung request can't stall a job. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How much of an error body we keep in the failure reason. */
const MAX_ERROR_DETAIL_CHARS = 300;

/** Minimal shape of the bits of the Groq response we read. */
type GroqChatCompletion = {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
};

/** Minimal JSON-Schema shape used for the local structure check. */
type JsonSchemaShape = {
  type?: string;
  properties?: Record<string, { type?: string } | undefined>;
  required?: string[];
};

/**
 * Maps a JSON Schema type keyword to a predicate over a parsed JS value.
 * Unknown keywords are ignored (we only do a BASIC structural check).
 */
function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Basic structure check: the payload must be a JSON object, must carry every
 * key listed in `required`, and every declared property that is present must
 * have the declared primitive type.
 *
 * @returns An error message, or null when the payload is acceptable.
 */
function checkShape(data: unknown, schema: object): string | null {
  if (!isPlainObject(data)) {
    return "model output was not a JSON object";
  }

  const shape = (schema ?? {}) as JsonSchemaShape;

  if (shape.type && shape.type !== "object") {
    // Non-object root schemas are not supported by this basic check.
    return `unsupported schema root type "${shape.type}"`;
  }

  for (const key of shape.required ?? []) {
    if (!(key in data)) {
      return `model output is missing required key "${key}"`;
    }
  }

  for (const [key, property] of Object.entries(shape.properties ?? {})) {
    const expected = property?.type;
    if (!expected || !(key in data)) continue;
    if (!matchesJsonType(data[key], expected)) {
      return `model output key "${key}" is not of type "${expected}"`;
    }
  }

  return null;
}

/**
 * Strips a markdown code fence if the model wrapped its JSON despite JSON mode.
 * JSON mode should prevent this, but the guard costs nothing.
 */
function unwrapJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
}

export class GroqProvider implements LLMProvider {
  /**
   * Optional explicit key (useful in tests). When omitted, GROQ_API_KEY is
   * read from the environment at call time — NOT at construction — so a
   * provider instance can be created before env is populated.
   */
  private readonly apiKeyOverride?: string;

  constructor(apiKeyOverride?: string) {
    this.apiKeyOverride = apiKeyOverride;
  }

  async generateEvaluation(
    prompt: string,
    schema: object,
  ): Promise<LLMEvaluationResult> {
    const apiKey = this.apiKeyOverride ?? process.env.GROQ_API_KEY;
    if (!apiKey) {
      return { success: false, error: "GROQ_API_KEY is not configured" };
    }

    // Groq enforces "the word JSON must appear in the input" when JSON mode is
    // on, so the system message always names it and states the required shape.
    const systemMessage =
      "You are GRYND's competitive game analyst. Reply with a single JSON " +
      "object and nothing else — no prose, no markdown fences. The object " +
      "must conform to this JSON schema:\n" +
      JSON.stringify(schema ?? {});

    let response: Response;
    try {
      response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: resolveGroqModel(),
          temperature: 0.2,
          // Groq supports OpenAI-style JSON mode for this model.
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Groq request failed: ${reason}` };
    }

    if (!response.ok) {
      // Never surface the request URL's auth header or the key itself; the
      // response body only describes the request that Groq rejected.
      let detail = "";
      try {
        detail = (await response.text()).slice(0, MAX_ERROR_DETAIL_CHARS);
      } catch {
        detail = "";
      }
      return {
        success: false,
        error: `Groq returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    let payload: GroqChatCompletion;
    try {
      payload = (await response.json()) as GroqChatCompletion;
    } catch {
      return { success: false, error: "Groq response was not valid JSON" };
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { success: false, error: "Groq response contained no message content" };
    }

    let data: unknown;
    try {
      data = JSON.parse(unwrapJsonFence(content));
    } catch {
      return {
        success: false,
        error: `Groq message content was not parseable JSON: ${content.slice(
          0,
          MAX_ERROR_DETAIL_CHARS,
        )}`,
      };
    }

    const shapeError = checkShape(data, schema ?? {});
    if (shapeError) {
      return { success: false, error: shapeError };
    }

    return { success: true, data: data as object };
  }
}

/** Ready-to-use provider for callers that don't need to inject a key. */
export const groqProvider = new GroqProvider();
