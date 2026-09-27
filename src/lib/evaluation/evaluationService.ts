/**
 * Game Evaluation — shared service behind POST /api/evaluation/[gameKey]/[matchId].
 *
 * The route is a thin shell (auth gate, params, response mapping); every
 * decision lives here so it can be tested without a Next request, a database or
 * a live engine. The dependencies are injectable for exactly that reason — the
 * test suite drives the real decision logic with fakes
 * (see tests/evaluation-route.test.mjs), which is the only way to prove the
 * limits and the caching actually behave as specified.
 *
 * ── THE RULES, IN ORDER ──────────────────────────────────────────────────
 *  1. Supported game?          → 501, other games come later.
 *  2. Match exists?            → 404 (a non-uuid id never reaches Postgres:
 *                                `chess_games.id` is a uuid column).
 *  3. Caller is a participant? → 403. You can only evaluate your own match.
 *  4. Match is finished?       → 409.
 *  5. Already evaluated?       → return the STORED row, no engine, no model.
 *  6. Free tier, already used today? → 429, upgrade to PRO. The count is a
 *     real DB COUNT over `evaluation_results` for the UTC day, so clearing
 *     client storage (or being signed in on another device) changes nothing.
 *     Redis is deliberately NOT the gate: it can only ever cache, and a cache
 *     miss must never be a way to get a second free evaluation.
 *  7. Objective evaluation     → the real engine stats, or 422 with the reason
 *     (too short / unreplayable history) and NO row written, so an
 *     unevaluatable match never consumes the daily allowance.
 *  8. LLM                      → on provider failure the request still
 *     succeeds with the objective stats and a clear "AI unavailable" message.
 *
 * ── WHY THE CACHE CHECK COMES BEFORE THE LIMIT CHECK ─────────────────────
 * A free player who evaluated a match yesterday must still be able to open that
 * same evaluation today. So an existing row short-circuits ahead of the daily
 * count: it costs nothing, and re-reading it is not a new evaluation.
 *
 * A stored row whose status is `failed` or `pending` (the model was down, or
 * the request died mid-flight) keeps its row and only RE-RUNS THE MODEL from
 * the objective data already on it. No second row, no second engine run, and
 * the user is not stuck with a permanently AI-less evaluation.
 *
 * Tier resolution reuses the membership source of truth
 * (`isPremiumMember` → the Stripe subscription row, the same helper
 * /api/membership/status is built on). It fails closed: if the subscription
 * table cannot be read the caller is treated as FREE, never as PRO.
 */

import { and, count, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "../../db/client";
import { chessGames, evaluationResults, users } from "../../db/schema";
import { isPremiumMember } from "../stripe/subscriptions";
import {
  MIN_EVALUABLE_MOVES,
  evaluateChessMatch,
} from "./games/chessEvaluator";
import type { ChessObjectiveData } from "./games/chessEvaluator";
import type { LLMEvaluationResult } from "./llmProvider";
import { groqProvider } from "./providers/groqProvider";
import {
  AI_UNAVAILABLE_MESSAGE,
  EVALUATION_INSIGHT_SCHEMA,
  buildChessEvaluationPrompt,
} from "./insight";
import type { EvaluationInsight, PlayerPerspective } from "./insight";

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

/** Free evaluations per UTC day. GRYND PRO is unlimited. */
export const FREE_DAILY_EVALUATION_LIMIT = 1;

/** Games with an evaluator today. Everything else answers 501. */
export const SUPPORTED_EVALUATION_GAMES: string[] = ["chess"];

export const FREE_LIMIT_REACHED_MESSAGE =
  "You've used today's free game evaluation. Upgrade to GRYND PRO for unlimited evaluations.";

export const NOT_YET_SUPPORTED_MESSAGE =
  "Evaluations for this game aren't available yet. Chess is supported today.";

/** The game's own match id shape. Chess uses a uuid primary key. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Hard cap on bullets persisted from the model, per section. */
const MAX_BULLETS = 6;
/** Hard cap on key moments persisted from the model. */
const MAX_KEY_MOMENTS = 3;

// ════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════

export type EvaluationTier = "free" | "pro";

export type EvaluationCode =
  | "ok"
  | "cached"
  | "unauthenticated"
  | "invalid_request"
  | "not_supported"
  | "match_not_found"
  | "not_a_participant"
  | "match_not_finished"
  | "daily_limit_reached"
  | "insufficient_data";

/** The game row fields the service needs to authorise + frame an evaluation. */
export type EvaluationMatch = {
  id: string;
  playerWhiteId: string | null;
  playerBlackId: string | null;
  status: string | null;
  result: string | null;
};

/** A row of `evaluation_results`, as far as the service cares. */
export type StoredEvaluation = {
  id: string;
  tier: string | null;
  status: string | null;
  objectiveData: unknown;
  aiResponse: unknown;
  createdAt: Date | string | null;
};

export type InsertEvaluationValues = {
  userId: string;
  gameKey: string;
  matchId: string;
  tier: EvaluationTier;
  objectiveData: ChessObjectiveData;
  aiResponse: EvaluationInsight | null;
  status: "complete" | "failed";
};

export type EvaluationLimits = {
  tier: EvaluationTier;
  /** null on PRO — there is no daily cap to report. */
  dailyLimit: number | null;
  usedToday: number;
  remaining: number | null;
};

/**
 * Flat result object on purpose: this repo compiles with `strict: false`, where
 * narrowing a discriminated union on a boolean literal does not work as
 * expected (see the note in src/lib/auth/requireAgeVerified.ts).
 */
export type EvaluationServiceResult = {
  ok: boolean;
  /** HTTP status the route should answer with. */
  status: number;
  code: EvaluationCode;
  message: string | null;
  tier: EvaluationTier;
  gameKey: string;
  matchId: string;
  evaluationId: string | null;
  /** True when the response came from the stored row instead of fresh work. */
  cached: boolean;
  aiAvailable: boolean;
  insight: EvaluationInsight | null;
  objective: ChessObjectiveData | null;
  limits: EvaluationLimits | null;
};

export type EvaluationDeps = {
  /** Injectable clock, so the UTC-day boundary is testable. */
  now(): Date;
  /** The caller's id plus any legacy alias (numeric users.id) they own. */
  getUserAliases(userId: string): Promise<string[]>;
  loadMatch(matchId: string): Promise<EvaluationMatch | null>;
  isProMember(userId: string): Promise<boolean>;
  countEvaluationsSince(userId: string, from: Date, to: Date): Promise<number>;
  findExisting(
    userId: string,
    gameKey: string,
    matchId: string,
  ): Promise<StoredEvaluation | null>;
  evaluateMatch(matchId: string): Promise<ChessObjectiveData>;
  generateInsight(prompt: string, schema: object): Promise<LLMEvaluationResult>;
  insertEvaluation(values: InsertEvaluationValues): Promise<StoredEvaluation>;
  updateEvaluation(
    id: string,
    patch: { aiResponse: EvaluationInsight | null; status: "complete" | "failed" },
  ): Promise<void>;
};

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

/** Midnight UTC of the supplied instant — the daily allowance boundary. */
export function startOfTodayUtc(now: Date): Date {
  const day = new Date(now.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function isTier(value: unknown): value is EvaluationTier {
  return value === "free" || value === "pro";
}

function tierFromStored(value: unknown): EvaluationTier {
  return isTier(value) ? value : "free";
}

function limitsFor(
  tier: EvaluationTier,
  usedToday: number,
): EvaluationLimits {
  if (tier === "pro") {
    return { tier, dailyLimit: null, usedToday, remaining: null };
  }
  return {
    tier,
    dailyLimit: FREE_DAILY_EVALUATION_LIMIT,
    usedToday,
    remaining: Math.max(0, FREE_DAILY_EVALUATION_LIMIT - usedToday),
  };
}

/** A persisted objective payload, only if it is a usable chess analysis. */
function storedObjective(value: unknown): ChessObjectiveData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as ChessObjectiveData;
  if (candidate.sufficient === true && Array.isArray(candidate.moves)) {
    return candidate;
  }
  // An `insufficient` payload is stored only for the response, never re-used.
  return null;
}

function insufficientMessage(objective: ChessObjectiveData | null): string {
  if (!objective || objective.sufficient !== false) {
    return "This match could not be evaluated.";
  }
  switch (objective.reason) {
    case "too_few_moves":
      return `This match is too short to evaluate (${objective.moveCount} move(s)). At least ${MIN_EVALUABLE_MOVES} moves are needed.`;
    case "invalid_move_history":
      return "This match's move history could not be replayed, so it can't be evaluated.";
    case "engine_unavailable":
      return "The analysis engine is unavailable right now. Please try again later.";
    case "time_budget_exceeded":
      return "This match was too long to analyse in one pass. Please try again later.";
    case "game_not_found":
      return "This match could not be found.";
    default:
      return "This match could not be evaluated.";
  }
}

/**
 * Normalises the model's answer into exactly the keys we persist: strings stay
 * strings, empty sections are DROPPED (never stored as empty arrays), unknown
 * keys are discarded, and the caps are enforced. A payload without a usable
 * `summary` is treated as no answer at all.
 */
export function normalizeInsight(raw: unknown): EvaluationInsight | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.summary !== "string" || !data.summary.trim()) return null;

  const insight: EvaluationInsight = { summary: data.summary.trim() };

  const bullets = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, MAX_BULLETS);
  };

  const strengths = bullets(data.strengths);
  if (strengths.length > 0) insight.strengths = strengths;

  const weaknesses = bullets(data.weaknesses);
  if (weaknesses.length > 0) insight.weaknesses = weaknesses;

  const improvements = bullets(data.improvements);
  if (improvements.length > 0) insight.improvements = improvements;

  if (Array.isArray(data.key_moments)) {
    const moments = data.key_moments
      .filter(
        (entry): entry is { move: string; note: string } =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as { move?: unknown }).move === "string" &&
          typeof (entry as { note?: unknown }).note === "string" &&
          (entry as { move: string }).move.trim().length > 0 &&
          (entry as { note: string }).note.trim().length > 0,
      )
      .slice(0, MAX_KEY_MOMENTS)
      .map((entry) => ({ move: entry.move.trim(), note: entry.note.trim() }));
    if (moments.length > 0) insight.key_moments = moments;
  }

  if (typeof data.next_time_tip === "string" && data.next_time_tip.trim()) {
    insight.next_time_tip = data.next_time_tip.trim();
  }

  return insight;
}

/** The colour the requesting player had, for prompt framing. */
function perspectiveFor(match: EvaluationMatch, aliases: Set<string>): PlayerPerspective {
  if (match.playerWhiteId && aliases.has(String(match.playerWhiteId))) return "white";
  if (match.playerBlackId && aliases.has(String(match.playerBlackId))) return "black";
  return null;
}

// ════════════════════════════════════════════════════════════════════
// The service
// ════════════════════════════════════════════════════════════════════

export async function runEvaluation(
  input: { userId: string; gameKey: string; matchId: string },
  deps: EvaluationDeps = defaultEvaluationDeps,
): Promise<EvaluationServiceResult> {
  const userId = String(input?.userId ?? "").trim();
  const gameKey = String(input?.gameKey ?? "").trim().toLowerCase();
  const matchId = String(input?.matchId ?? "").trim();

  const respond = (
    patch: Partial<EvaluationServiceResult>,
  ): EvaluationServiceResult => ({
    ok: false,
    status: 200,
    code: "ok",
    message: null,
    tier: "free",
    gameKey,
    matchId,
    evaluationId: null,
    cached: false,
    aiAvailable: false,
    insight: null,
    objective: null,
    limits: null,
    ...patch,
  });

  if (!userId) {
    return respond({
      status: 401,
      code: "unauthenticated",
      message: "Unauthorized",
    });
  }

  if (!matchId) {
    return respond({
      status: 400,
      code: "invalid_request",
      message: "A match id is required.",
    });
  }

  if (!SUPPORTED_EVALUATION_GAMES.includes(gameKey)) {
    return respond({
      status: 501,
      code: "not_supported",
      message: NOT_YET_SUPPORTED_MESSAGE,
    });
  }

  const [aliasList, match] = await Promise.all([
    deps.getUserAliases(userId),
    deps.loadMatch(matchId),
  ]);

  if (!match) {
    return respond({
      status: 404,
      code: "match_not_found",
      message: "That match does not exist.",
    });
  }

  const aliases = new Set<string>([String(userId), ...aliasList.map(String)]);
  const isWhite = Boolean(match.playerWhiteId) && aliases.has(String(match.playerWhiteId));
  const isBlack = Boolean(match.playerBlackId) && aliases.has(String(match.playerBlackId));
  if (!isWhite && !isBlack) {
    // Same answer for "not yours" and "does not exist" would leak less, but the
    // match id is already known to the caller when they have it, and a clear
    // 403 keeps the client's messaging honest.
    return respond({
      status: 403,
      code: "not_a_participant",
      message: "You can only evaluate your own matches.",
    });
  }

  if (String(match.status) !== "finished") {
    return respond({
      status: 409,
      code: "match_not_finished",
      message: "Only finished matches can be evaluated.",
    });
  }

  const perspective = perspectiveFor(match, aliases);

  // ── 5. Idempotency: one evaluation per (user, game, match) ─────────
  const existing = await deps.findExisting(userId, gameKey, matchId);
  if (existing) {
    const objective = storedObjective(existing.objectiveData);

    // Complete, or nothing worth regenerating: hand back the stored row.
    if (existing.status === "complete" || !objective) {
      const insight = normalizeInsight(existing.aiResponse);
      return respond({
        ok: true,
        status: 200,
        code: "cached",
        cached: true,
        tier: tierFromStored(existing.tier),
        evaluationId: existing.id,
        objective,
        insight,
        aiAvailable: Boolean(insight),
        message: insight ? null : AI_UNAVAILABLE_MESSAGE,
      });
    }

    // The model failed (or the request died) last time. Keep the row and the
    // engine work; retry only the model.
    const retry = await generateInsight(objective, perspective, deps);
    await deps.updateEvaluation(existing.id, {
      aiResponse: retry.insight,
      status: retry.insight ? "complete" : "failed",
    });

    if (!retry.insight && retry.error) {
      console.warn(
        `[evaluation] insight retry failed for ${gameKey}/${matchId}: ${retry.error}`,
      );
    }

    return respond({
      ok: true,
      status: 200,
      code: "cached",
      cached: true,
      tier: tierFromStored(existing.tier),
      evaluationId: existing.id,
      objective,
      insight: retry.insight,
      aiAvailable: Boolean(retry.insight),
      message: retry.insight ? null : AI_UNAVAILABLE_MESSAGE,
    });
  }

  // ── 6. Tier + daily allowance ──────────────────────────────────────
  // Fail closed: an unreadable subscription means FREE, never PRO.
  const isPro = await deps.isProMember(userId).catch((err) => {
    console.error("[evaluation] membership lookup failed:", err);
    return false;
  });
  const tier: EvaluationTier = isPro ? "pro" : "free";

  const dayStart = startOfTodayUtc(deps.now());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  let usedToday = 0;
  if (tier === "free") {
    usedToday = await deps.countEvaluationsSince(userId, dayStart, dayEnd);
    if (usedToday >= FREE_DAILY_EVALUATION_LIMIT) {
      return respond({
        status: 429,
        code: "daily_limit_reached",
        message: FREE_LIMIT_REACHED_MESSAGE,
        tier,
        limits: limitsFor(tier, usedToday),
      });
    }
  }

  // ── 7. Objective evaluation (real engine stats) ────────────────────
  const objective = await deps.evaluateMatch(matchId);
  if (!objective || objective.sufficient !== true) {
    // No row is written, so an unevaluatable match never burns the allowance.
    return respond({
      status: 422,
      code: "insufficient_data",
      message: insufficientMessage(objective),
      tier,
      objective,
      limits: limitsFor(tier, usedToday),
    });
  }

  // ── 8. The model. Its failure is NOT the request's failure. ────────
  const generated = await generateInsight(objective, perspective, deps);
  if (!generated.insight && generated.error) {
    console.warn(
      `[evaluation] insight failed for ${gameKey}/${matchId}: ${generated.error}`,
    );
  }

  const stored = await deps.insertEvaluation({
    userId,
    gameKey,
    matchId,
    tier,
    objectiveData: objective,
    aiResponse: generated.insight,
    status: generated.insight ? "complete" : "failed",
  });

  const usedAfter = tier === "free" ? usedToday + 1 : usedToday;

  return respond({
    ok: true,
    status: 200,
    code: "ok",
    tier,
    evaluationId: stored?.id ?? null,
    cached: false,
    objective,
    insight: generated.insight,
    aiAvailable: Boolean(generated.insight),
    message: generated.insight ? null : AI_UNAVAILABLE_MESSAGE,
    limits: limitsFor(tier, usedAfter),
  });
}

/**
 * Runs the model and normalises (or discards) its answer. Never throws: a
 * provider outage degrades to `insight: null` + an error string, which is what
 * lets the request still return the objective statistics.
 */
async function generateInsight(
  objective: ChessObjectiveData,
  perspective: PlayerPerspective,
  deps: EvaluationDeps,
): Promise<{ insight: EvaluationInsight | null; error: string | null }> {
  const prompt = buildChessEvaluationPrompt(objective, perspective);
  try {
    const result = await deps.generateInsight(prompt, EVALUATION_INSIGHT_SCHEMA);
    if (!result || result.success !== true) {
      return {
        insight: null,
        error: (result && "error" in result && result.error) || "provider returned no data",
      };
    }
    const insight = normalizeInsight(result.data);
    return {
      insight,
      error: insight ? null : "model output did not contain a usable summary",
    };
  } catch (err) {
    return {
      insight: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ════════════════════════════════════════════════════════════════════
// Default (production) dependencies
// ════════════════════════════════════════════════════════════════════

export const defaultEvaluationDeps: EvaluationDeps = {
  now: () => new Date(),

  async getUserAliases(userId: string): Promise<string[]> {
    // Mirrors /api/chess/move: older rows can hold the numeric users.id
    // instead of the Clerk id, so both are accepted as "this player".
    const aliases = [String(userId)];
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);
    if (row?.id !== undefined && row?.id !== null) aliases.push(String(row.id));
    return aliases;
  },

  async loadMatch(matchId: string): Promise<EvaluationMatch | null> {
    // Guard the uuid column first: an arbitrary path segment would otherwise
    // raise a driver error instead of answering "no such match".
    if (!UUID_RE.test(matchId)) return null;

    const [row] = await db
      .select({
        id: chessGames.id,
        playerWhiteId: chessGames.playerWhiteId,
        playerBlackId: chessGames.playerBlackId,
        status: chessGames.status,
        result: chessGames.result,
      })
      .from(chessGames)
      .where(eq(chessGames.id, matchId))
      .limit(1);

    return row ?? null;
  },

  isProMember(userId: string): Promise<boolean> {
    return isPremiumMember(userId);
  },

  async countEvaluationsSince(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    // The authoritative daily counter: a real COUNT over the table, bounded to
    // the UTC day at both ends so a clock-skewed row can't leak in.
    const rows = await db
      .select({ n: count() })
      .from(evaluationResults)
      .where(
        and(
          eq(evaluationResults.userId, userId),
          gte(evaluationResults.createdAt, from),
          lt(evaluationResults.createdAt, to),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  },

  async findExisting(userId, gameKey, matchId) {
    const [row] = await db
      .select({
        id: evaluationResults.id,
        tier: evaluationResults.tier,
        status: evaluationResults.status,
        objectiveData: evaluationResults.objectiveData,
        aiResponse: evaluationResults.aiResponse,
        createdAt: evaluationResults.createdAt,
      })
      .from(evaluationResults)
      .where(
        and(
          eq(evaluationResults.userId, userId),
          eq(evaluationResults.gameKey, gameKey),
          eq(evaluationResults.matchId, matchId),
        ),
      )
      .orderBy(desc(evaluationResults.createdAt))
      .limit(1);
    return row ?? null;
  },

  evaluateMatch(matchId: string): Promise<ChessObjectiveData> {
    return evaluateChessMatch(matchId);
  },

  generateInsight(prompt: string, schema: object): Promise<LLMEvaluationResult> {
    return groqProvider.generateEvaluation(prompt, schema);
  },

  async insertEvaluation(values) {
    const [row] = await db
      .insert(evaluationResults)
      .values({
        userId: values.userId,
        gameKey: values.gameKey,
        matchId: values.matchId,
        tier: values.tier,
        objectiveData: values.objectiveData,
        aiResponse: values.aiResponse ?? null,
        status: values.status,
      })
      .returning({
        id: evaluationResults.id,
        tier: evaluationResults.tier,
        status: evaluationResults.status,
        objectiveData: evaluationResults.objectiveData,
        aiResponse: evaluationResults.aiResponse,
        createdAt: evaluationResults.createdAt,
      });
    return row;
  },

  async updateEvaluation(id, patch) {
    await db
      .update(evaluationResults)
      .set({
        aiResponse: patch.aiResponse ?? null,
        status: patch.status,
      })
      .where(eq(evaluationResults.id, id));
  },
};
