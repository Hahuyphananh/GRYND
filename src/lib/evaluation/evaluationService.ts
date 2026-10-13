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
 *     miss must never be a way to get a second free evaluation. The count and
 *     the claim below happen in ONE transaction, so simultaneous requests
 *     cannot both pass it.
 *  7. Objective evaluation     → the real engine stats, or 422 with the reason
 *     (too short / unreplayable history) and NO row left behind, so an
 *     unevaluatable match never consumes the daily allowance.
 *  8. LLM                      → on provider failure the request still
 *     succeeds with the objective stats and a clear "AI unavailable" message.
 *
 * ── ONE CLAIM DECIDES THE WHOLE RACE (steps 5–7 above) ───────────────────
 * Steps 5 to 7 are a single atomic step — `claimEvaluation` — because they used
 * to be read-then-work-then-insert: two requests that arrived together both
 * missed the lookup, both ran the engine, both called the model, and both
 * INSERTed, which duplicated the most expensive work in the feature and let a
 * Free caller spend the one-per-day allowance twice. Nothing about that is
 * fixable by a uniqueness constraint alone — see `claimEvaluation` for the full
 * reasoning, including why the allowance needs a per-caller advisory lock.
 *
 * The outcomes are explicit: `complete` (serve the stored row), `in_progress`
 * (someone else is working on this match — a retryable 409, never a second
 * engine run and never a half-written result), `limit_reached` (429) and
 * `claimed` (this request, and only this request, may do the work).
 *
 * A free player who evaluated a match yesterday must still be able to open that
 * same evaluation today: that is the `complete` outcome, decided BEFORE the
 * daily count, so re-reading a stored result costs nothing and no allowance.
 *
 * A stored row whose status is `failed` (the model was down, or the request
 * died mid-flight) keeps its row and only RE-RUNS THE MODEL from the objective
 * data already on it. No second row, no second engine run, and the user is not
 * stuck with a permanently AI-less evaluation. A `pending` row is only taken
 * over once its lease has expired (`EVALUATION_CLAIM_LEASE_MS`), so a crash
 * cannot wedge a match for good.
 *
 * Tier resolution reuses the membership source of truth
 * (`isPremiumMember` → the Stripe subscription row, the same helper
 * /api/membership/status is built on). It fails closed: if the subscription
 * table cannot be read the caller is treated as FREE, never as PRO.
 */

import { and, count, desc, eq, gt, gte, lt, ne, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  chessGames,
  evaluationResults,
  speedTypingMatches,
  ticTacToeMatches,
  users,
} from "../../db/schema";
import { isPremiumMember } from "../stripe/subscriptions";
import { consumeRateLimit } from "../security/rateLimit";
import { MIN_EVALUABLE_PLIES } from "./games/chessEvaluator";
import type {
  ChessAnalysisOptions,
  ChessObjectiveData,
} from "./games/chessEvaluator";
import { fullMoveCount } from "./moveCounts";
import type { LLMEvaluationResult } from "./llmProvider";
import {
  getEvaluationAnalyzer,
  getSupportedEvaluationGames,
  isEvaluationSupported,
} from "./registry";
import {
  looksLikeGameReportV1,
  parseGameReportV1,
  type GameReportV1,
} from "./gameReport";
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

/**
 * ── TEMPORARY FREE-TEST SWITCH (reversible, ONE place) ───────────────
 *
 * Free users are entitled to ONE new chess evaluation per UTC day
 * (`FREE_DAILY_EVALUATION_LIMIT`), and this flag exists ONLY so that Free
 * end-to-end testing can be turned off again without a code change. It is read
 * in exactly one place (`runEvaluation`, when it resolves the claim's
 * dailyLimit) and defaults to ENABLED.
 *
 *   EVALUATION_FREE_ACCESS unset, or any value except "false"
 *       → Free callers keep their daily allowance (current behaviour).
 *   EVALUATION_FREE_ACCESS=false
 *       → Free callers are refused with the existing 429 upsell and spend
 *         nothing; PRO is unaffected; cached results are unaffected.
 *
 * Disabling it does NOT weaken any check: ownership, finished-match, age,
 * throttling, concurrency and idempotency still run exactly as before.
 * To make it permanent, set `FREE_DAILY_EVALUATION_LIMIT = 0` and delete this.
 */
export function freeEvaluationAccessEnabled(): boolean {
  return String(process.env.EVALUATION_FREE_ACCESS ?? "")
    .trim()
    .toLowerCase() !== "false";
}

/**
 * Games with an evaluator today. Everything else answers 501.
 *
 * Derived from the analyzer registry, so adding an evaluator is registering an
 * adapter there — never editing this request path. A lobby key alone buys no
 * support.
 */
export const SUPPORTED_EVALUATION_GAMES: string[] = getSupportedEvaluationGames();

export const FREE_LIMIT_REACHED_MESSAGE =
  "You've used today's free game evaluation. Upgrade to GRYND PRO for unlimited evaluations.";

/**
 * Shown when a concurrent request already holds the claim for this match.
 *
 * A retryable answer, not a failure: another request is analysing this match
 * right now, which is exactly why this one must NOT start a second engine run
 * or a second model call. A retry lands on that request's stored result.
 */
export const EVALUATION_IN_PROGRESS_MESSAGE =
  "This match is already being analysed. Give it a moment, then try again.";

/**
 * Advisory-lock namespace for the per-caller claim transaction ("EVAL").
 *
 * The Free allowance is a per-day COUNT over rows, and no uniqueness constraint
 * can express "at most one row per caller per day" when the MATCHES differ —
 * so the count and the claim insert have to be serialised. A transaction-scoped
 * advisory lock is the smallest Postgres-native primitive for that:
 *
 *   • it is released automatically at COMMIT, so it cannot leak;
 *   • it serialises across serverless instances, unlike a process-local mutex,
 *     which protects nothing when two function instances run concurrently;
 *   • it is already the pattern this repo uses for Barricade matchmaking
 *     (src/lib/barricade/serverStore.ts), so no new feature or dependency is
 *     introduced;
 *   • it is held ONLY for the short claim transaction — never across the
 *     Stockfish run or the model call.
 *
 * A distinct namespace value, so an evaluation claim can never collide with
 * another feature's advisory lock.
 */
export const EVALUATION_CLAIM_LOCK_NAMESPACE = 0x4556414c & 0x7fffffff; // "EVAL"

/**
 * How long a `pending` claim may sit before another request may take it over.
 *
 * The route's budget is 60 s (`maxDuration`), so a claim older than this
 * belongs to a request that DIED (a crashed function, a killed container)
 * rather than one still working. Without that boundary a crash would wedge the
 * match for good: every later request would find `pending` and refuse.
 */
export const EVALUATION_CLAIM_LEASE_MS = 3 * 60 * 1000;

/**
 * ── THE REQUEST BUDGET ──────────────────────────────────────────────
 *
 * The route runs on the Node runtime with `maxDuration = 60` (route.ts). One
 * evaluation must fit inside that: engine boot, the engine search itself, the
 * claim + result writes, and — when the provider answers — the AI insight call.
 * The evaluator's own 20 s default predates the AI half and leaves no room for
 * it, so the budget is set HERE, explicitly, and handed to the evaluator. The
 * arithmetic is deliberately conservative:
 *
 *   60 s  route maxDuration (the host kills the function after this)
 *  − 8 s  safety margin: cold start, Node/route overhead, response write
 *  − 3 s  engine boot + UCI handshake (measured ~50 ms; bounded generously)
 *  − 18 s reserved for the optional AI insight call (provider aborts at 15 s)
 *  − 1 s  claim write + result write + response serialisation
 *  ──────
 *   30 s  the engine's analysis budget for the whole game
 *
 * Every value is a named constant so the policy is reviewable and unit-tested,
 * and the margin is what stops a slow game being KILLED by the host instead of
 * answering. This is NOT "the engine may run for 60 s": the engine is capped so
 * the other steps in the request keep their slice. A game that still cannot fit
 * the 30 s budget returns a clear retry state (503 analysis_budget_exceeded),
 * never a silent promise that an identical retry will succeed.
 */
export const ROUTE_MAX_DURATION_MS = 60_000;
/** Headroom for cold start, route/framework overhead and the response. */
export const EVALUATION_SAFETY_MARGIN_MS = 8_000;
/** Engine boot + `uci`/`isready` handshake before the first search. */
export const ENGINE_BOOT_RESERVE_MS = 3_000;
/** Slice reserved for the optional AI insight call (provider aborts at 15 s). */
export const AI_INSIGHT_RESERVE_MS = 18_000;
/** Claim write + result write + response serialisation. */
export const EVALUATION_PERSISTENCE_RESERVE_MS = 1_000;

/** The engine's total analysis budget for one game, derived from the above. */
export const EVALUATION_ENGINE_TIME_BUDGET_MS =
  ROUTE_MAX_DURATION_MS -
  EVALUATION_SAFETY_MARGIN_MS -
  ENGINE_BOOT_RESERVE_MS -
  AI_INSIGHT_RESERVE_MS -
  EVALUATION_PERSISTENCE_RESERVE_MS;

/**
 * The options the service passes to the evaluator, explicitly and bounded: the
 * engine gets `EVALUATION_ENGINE_TIME_BUDGET_MS` for the game, while depth and
 * per-position time keep the evaluator's own tested defaults.
 */
export const EVALUATION_ANALYSIS_OPTIONS: ChessAnalysisOptions = Object.freeze({
  timeBudgetMs: EVALUATION_ENGINE_TIME_BUDGET_MS,
});

/**
 * Hard ceiling on the optional AI insight call.
 *
 * The provider aborts its own request at 15 s (groqProvider.REQUEST_TIMEOUT_MS),
 * so this is a backstop for an injected/misbehaving provider rather than the
 * primary cap. When it fires the evaluation STILL succeeds with the objective
 * stats and an "AI unavailable" message — the AI half is optional.
 */
export const AI_INSIGHT_TIMEOUT_MS = 15_000;

/**
 * ── REQUEST THROTTLING (separate from the daily allowance) ───────────
 *
 * The daily Free allowance (`FREE_DAILY_EVALUATION_LIMIT`) is a PRODUCT rule:
 * one evaluation per UTC day per caller. It says nothing about how FAST a caller
 * may fire requests, and each request can cost up to ~50 s of engine CPU. So a
 * per-caller REQUEST budget sits in front of it, using the project's existing
 * durable rate limiter (src/lib/security/rateLimit.ts — Redis REST when
 * `KV_REST_API_URL`/`UPSTASH_REDIS_REST_URL` are configured, an in-memory
 * fallback otherwise).
 *
 * Ten per minute is generous for a legitimate retry after a transient failure (a
 * retry is one more request, not another day's allowance) while a runaway loop
 * is stopped. THROTTLING NEVER TOUCHES THE ALLOWANCE: a throttled request is
 * answered before the claim, so it neither consumes nor reports the daily figure.
 *
 * CROSS-INSTANCE CAVEAT: the limiter is only globally accurate when the Redis
 * env is set; without it the fallback is per-instance. That is acceptable here
 * because the CONCURRENCY cap below is database-backed and therefore global
 * regardless — see MAX_CONCURRENT_EVALUATIONS_PER_USER.
 */
export const EVALUATION_RATE_LIMIT_WINDOW_MS = 60_000;
export const EVALUATION_RATE_LIMIT_MAX = 10;

/** The documented 429 body for a per-user request throttle. */
export const RATE_LIMITED_MESSAGE =
  "Too many evaluation requests. Please wait a moment and try again.";

/**
 * How many analyses one caller may have in flight at once.
 *
 * Bounds the expensive work: each analysis holds the engine for up to
 * `EVALUATION_ENGINE_TIME_BUDGET_MS`. TWO rather than one, so a legitimate
 * second request (a second tab, a retry for a different match) is not refused
 * outright, while a burst cannot multiply engine load.
 *
 * Enforced — not estimated — by counting the caller's LIVE `pending` claim rows
 * inside the same advisory-locked transaction that writes them (see
 * claimEvaluation). That is what makes it hold across serverless instances, and
 * what makes it release itself: a row stops being `pending` when the analysis
 * completes or fails, and an abandoned `pending` row ages out of the lease — so
 * no separate release call can be forgotten on success, failure, timeout or
 * cancellation. A duplicate request for the SAME match never reaches this
 * check: it is answered from the existing row (409 in_progress), so it cannot
 * bypass concurrency protection.
 */
export const MAX_CONCURRENT_EVALUATIONS_PER_USER = 2;

/** The documented 429 body when the caller is already at the concurrency cap. */
export const CONCURRENCY_LIMITED_MESSAGE =
  "You already have the maximum number of evaluations in progress. Please wait for one to finish.";

/**
 * `Retry-After` hint for a concurrency refusal: a running analysis is bounded by
 * the engine budget, so this is the caller's worst-case wait.
 */
export const EVALUATION_CONCURRENCY_RETRY_AFTER_MS =
  EVALUATION_ENGINE_TIME_BUDGET_MS;

/**
 * A stable 32-bit key for one caller, for the advisory lock above.
 *
 * FNV-1a, derived here rather than in the database: the lock only needs to be
 * stable and to collide rarely (a collision merely serialises two unrelated
 * claims for the length of one short transaction). Keeping it in JS makes the
 * derivation unit-testable and avoids depending on an extension or an
 * undocumented Postgres function.
 */
export function evaluationLockKey(userId: string): number {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  const text = String(userId ?? "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // The two-int form of pg_advisory_xact_lock takes signed int4s.
  return hash & 0x7fffffff;
}

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
  | "evaluation_in_progress"
  | "insufficient_data"
  // Throttling — a request-rate or in-flight cap, NOT the daily allowance.
  | "rate_limited"
  | "concurrency_limit_reached"
  // Server-side failure classes — deliberately distinct from the 422 that means
  // "your match's data is insufficient". See insufficientOutcome().
  | "engine_unavailable"
  | "analysis_budget_exceeded"
  | "database_error";

/**
 * The payload one finished evaluation carries.
 *
 * Chess keeps its long-standing `ChessObjectiveData`. Every other game persists
 * a `GameReportV1`. Both live in the same `objective_data` column and are
 * returned through the same field, which is why the service treats them as a
 * union and narrows only where it must (success/failure and the AI prompt).
 */
export type EvaluationPayload = ChessObjectiveData | GameReportV1;

/** The game row fields the service needs to authorise + frame an evaluation. */
export type EvaluationMatch = {
  id: string;
  playerWhiteId: string | null;
  playerBlackId: string | null;
  status: string | null;
  result: string | null;
  /**
   * The game this match belongs to, when the loader can tell. Optional so a
   * test double need not supply it; the service cross-checks it against the
   * requested gameKey when present (a chess id requested as tic-tac-toe 404s).
   */
  gameKey?: string;
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

/** The finished result written onto a claimed row. */
export type CompletedEvaluation = {
  objectiveData: EvaluationPayload;
  aiResponse: EvaluationInsight | null;
  status: "complete" | "failed";
};

/** What one claim attempt asks the database for, in one transaction. */
export type EvaluationClaimRequest = {
  userId: string;
  gameKey: string;
  matchId: string;
  tier: EvaluationTier;
  /**
   * The Free daily allowance (`FREE_DAILY_EVALUATION_LIMIT`), or `null` for an
   * unlimited tier — which skips BOTH the count and the advisory lock, so PRO
   * callers never serialise against each other.
   */
  dailyLimit: number | null;
  /** The UTC-day window the allowance is counted over. */
  dayStart: Date;
  dayEnd: Date;
  /** A `pending` claim older than this is abandoned and may be taken over. */
  stalePendingBefore: Date;
};

/**
 * The outcome of the atomic claim — exactly one caller of a group wins.
 *
 * `objective` is the stats ALREADY stored on a row being resumed (a `failed`
 * row whose engine work survived), so the winner re-runs only the model. `null`
 * means the caller must run the engine itself.
 */
export type EvaluationClaim =
  | {
      outcome: "claimed";
      evaluationId: string;
      objective: EvaluationPayload | null;
      /** The caller's evaluations counted for today AFTER this claim. */
      usedToday: number | null;
      /** Whether the claimed row is inside `usedToday` (see the release path). */
      countedToday: boolean;
      /**
       * True when the row already existed (a `failed` retry, or a takeover of
       * an abandoned claim) rather than being created by this claim. The
       * response keeps the `cached: true` shape that path had before the claim
       * existed, so the API contract is unchanged for it.
       */
      resumed: boolean;
    }
  | { outcome: "complete"; row: StoredEvaluation; usedToday: number | null }
  | { outcome: "in_progress"; row: StoredEvaluation | null }
  | { outcome: "limit_reached"; usedToday: number }
  /** The caller already has `MAX_CONCURRENT_EVALUATIONS_PER_USER` live claims. */
  | { outcome: "concurrency_limited"; livePending: number };

export type EvaluationRateLimit = {
  allowed: boolean;
  /** Configured request cap for one window. */
  limit: number;
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
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
  objective: EvaluationPayload | null;
  limits: EvaluationLimits | null;
  /**
   * Present on a throttling 429 (rate/concurrency). The route turns it into a
   * `Retry-After` header (seconds); null for every other response.
   */
  retryAfterMs: number | null;
};

export type EvaluationDeps = {
  /** Injectable clock, so the UTC-day boundary is testable. */
  now(): Date;
  /** The caller's id plus any legacy alias (numeric users.id) they own. */
  getUserAliases(userId: string): Promise<string[]>;
  loadMatch(matchId: string): Promise<EvaluationMatch | null>;
  isProMember(userId: string): Promise<boolean>;
  /**
   * The per-caller REQUEST throttle (see EVALUATION_RATE_LIMIT_MAX), resolved
   * before any database or engine work. Separate from the daily allowance, and
   * injectable so the throttling behaviour is unit-testable with fakes.
   */
  consumeRequestRateLimit(userId: string): Promise<EvaluationRateLimit>;
  /**
   * THE ATOMIC GATE. One call decides the entire race: it either hands this
   * request the exclusive right to evaluate the key, reports that the work is
   * already done or in flight, or refuses it for the daily limit — all inside
   * one database transaction, so the decision cannot differ between instances.
   */
  claimEvaluation(request: EvaluationClaimRequest): Promise<EvaluationClaim>;
  /** Drops a claim whose match turned out to be unevaluatable. */
  releaseEvaluation(evaluationId: string): Promise<void>;
  /**
   * Runs the game's objective evaluator with the service's bounded budget.
   *
   * `gameKey` selects the registered analyzer. It is the LAST parameter so the
   * existing test doubles that only read `matchId` keep working unchanged; the
   * production default (and everything new) uses it.
   */
  evaluateMatch(
    matchId: string,
    options?: ChessAnalysisOptions,
    gameKey?: string,
  ): Promise<unknown>;
  generateInsight(prompt: string, schema: object): Promise<LLMEvaluationResult>;
  /**
   * Overrides `AI_INSIGHT_TIMEOUT_MS`. Present so the timeout path is testable
   * without waiting the real 15 s; production omits it and takes the default.
   */
  insightTimeoutMs?: number;
  /**
   * Writes the finished result onto the claimed row. It refuses to touch a row
   * that is already `complete`, so a slower request can never replace a result
   * the player already has with its own — possibly failed — one.
   */
  completeEvaluation(
    evaluationId: string,
    result: CompletedEvaluation,
  ): Promise<StoredEvaluation | null>;
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

/**
 * What `objective_data` holds while a claim is in flight.
 *
 * The column is NOT NULL, so a pending row must carry something. This marker is
 * deliberately NOT a usable analysis — `storedObjective()` rejects it (it is not
 * a `sufficient: true` payload) — so a claim that is still being worked on can
 * never be handed to a player as if it were statistics.
 */
const EVALUATION_CLAIM_MARKER = { pending: true } as const;

/** Whether a stored timestamp falls inside the half-open window [from, to). */
function isWithinDay(
  value: Date | string | null | undefined,
  from: Date,
  to: Date,
): boolean {
  const ms = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(ms) && ms >= from.getTime() && ms < to.getTime();
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

/**
 * The allowance to report after a claim was RELEASED (an unevaluatable match).
 *
 * The claimed row is deleted, so it no longer counts towards today — but only
 * if it was counted in the first place (`countedToday`): a takeover of a row
 * that predates today never contributed to today's figure, so subtracting one
 * would understate the usage.
 */
function releasedCount(claim: EvaluationClaim): number {
  if (claim.outcome !== "claimed" || claim.usedToday === null) return 0;
  return claim.countedToday
    ? Math.max(0, claim.usedToday - 1)
    : claim.usedToday;
}

/**
 * An evaluation payload, only when it is USABLE.
 *
 * Two shapes are accepted, because two exist in the column:
 *   - `ChessObjectiveData` — usable when `sufficient: true` with a move array
 *     (an `insufficient` payload is stored only for the response, never reused);
 *   - `GameReportV1` — usable when `status: "complete"`. An `unavailable`
 *     report is a reason, not a result, and is never served as statistics.
 * Anything else (a pending claim marker, an unknown blob) is `null`.
 */
function usableEvaluationPayload(value: unknown): EvaluationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (looksLikeGameReportV1(value)) {
    const parsed = parseGameReportV1(value);
    return parsed.ok && parsed.report.status === "complete" ? parsed.report : null;
  }
  const candidate = value as ChessObjectiveData;
  if (candidate.sufficient === true && Array.isArray(candidate.moves)) {
    return candidate;
  }
  return null;
}

/** A persisted objective payload, only if it is a usable analysis. */
function storedObjective(value: unknown): EvaluationPayload | null {
  return usableEvaluationPayload(value);
}

/**
 * Maps an unusable evaluator result onto an HTTP answer.
 *
 * Chess keeps the exact mapping it always had (`insufficientOutcome` /
 * `insufficientMessage`). A `GameReportV1` from another game is mapped from its
 * machine reason code, because the report itself carries no HTTP status.
 */
function describeUnusablePayload(fresh: unknown): {
  status: number;
  code: EvaluationCode;
  message: string;
} {
  const obj =
    fresh && typeof fresh === "object" && !Array.isArray(fresh)
      ? (fresh as Record<string, unknown>)
      : null;

  if (obj && !looksLikeGameReportV1(obj) && "sufficient" in obj) {
    const chess = obj as unknown as ChessObjectiveData;
    const outcome = insufficientOutcome(chess);
    return {
      status: outcome.status,
      code: outcome.code,
      message: insufficientMessage(chess),
    };
  }

  const parsed = obj && looksLikeGameReportV1(obj) ? parseGameReportV1(obj) : null;
  const reason = parsed && parsed.ok ? parsed.report.unavailableReason ?? "" : "";
  switch (reason) {
    case "game_not_found":
      return {
        status: 404,
        code: "match_not_found",
        message: "This match could not be found.",
      };
    case "match_not_finished":
      return {
        status: 409,
        code: "match_not_finished",
        message: "Only finished matches can be evaluated.",
      };
    case "database_error":
      return {
        status: 500,
        code: "database_error",
        message:
          "We couldn't load this match for evaluation. Please try again later.",
      };
    case "passage_unavailable":
      return {
        status: 422,
        code: "insufficient_data",
        message:
          "This match's reference text can't be resolved, so its performance can't be reported.",
      };
    case "inconsistent_counters":
      return {
        status: 422,
        code: "insufficient_data",
        message:
          "This match's stored performance numbers are inconsistent, so it can't be reported.",
      };
    case "not_exactly_evaluable":
      return {
        status: 422,
        code: "insufficient_data",
        message:
          "This match can't be evaluated exactly yet. Only matches decided on the opening board are supported for this game.",
      };
    case "history_incomplete":
      return {
        status: 422,
        code: "insufficient_data",
        message: "This match's move history is incomplete, so it can't be evaluated.",
      };
    case "invalid_move_history":
      return {
        status: 422,
        code: "insufficient_data",
        message: "This match's move history could not be replayed, so it can't be evaluated.",
      };
    case "history_after_end":
      return {
        status: 422,
        code: "insufficient_data",
        message:
          "This match's move history continues after the game ended, so it can't be evaluated.",
      };
    case "history_attribution_mismatch":
      return {
        status: 422,
        code: "insufficient_data",
        message:
          "This match's move history doesn't match its players, so it can't be evaluated.",
      };
    case "result_mismatch":
      return {
        status: 422,
        code: "insufficient_data",
        message:
          "This match's stored result doesn't match its move history, so it can't be evaluated.",
      };
    default:
      return {
        status: 422,
        code: "insufficient_data",
        message: "This match could not be evaluated.",
      };
  }
}

/**
 * The message shown when no AI explanation accompanies a result.
 *
 * Only chess has an insight prompt today, so only chess says the coach was
 * unavailable; another game returns no message rather than implying a failed
 * AI call that was never attempted.
 */
function aiUnavailableMessage(gameKey: string): string | null {
  return gameKey === "chess" ? AI_UNAVAILABLE_MESSAGE : null;
}

/**
 * Maps an unevaluatable match onto its HTTP answer.
 *
 * 422 is reserved for data the CLIENT can understand and act on — a game that
 * is too short, a history that does not replay. Everything else is a server-side
 * condition and must not masquerade as a client error:
 *
 *   engine_unavailable   → 503 (retryable; the engine is down)
 *   time_budget_exceeded → 503 (retryable; the match is too long for the budget
 *                              — a clear retry state rather than implying an
 *                              identical retry will succeed when nothing
 *                              changed)
 *   database_error       → 500 (an internal fault, never the caller's match)
 *   game_not_found       → 404
 */
function insufficientOutcome(
  objective: ChessObjectiveData | null,
): { status: number; code: EvaluationCode } {
  if (!objective || objective.sufficient !== false) {
    return { status: 422, code: "insufficient_data" };
  }
  switch (objective.reason) {
    case "too_few_moves":
    case "invalid_move_history":
      return { status: 422, code: "insufficient_data" };
    case "game_not_found":
      return { status: 404, code: "match_not_found" };
    case "engine_unavailable":
      return { status: 503, code: "engine_unavailable" };
    case "time_budget_exceeded":
      return { status: 503, code: "analysis_budget_exceeded" };
    case "database_error":
      return { status: 500, code: "database_error" };
    default:
      return { status: 422, code: "insufficient_data" };
  }
}

function insufficientMessage(objective: ChessObjectiveData | null): string {
  if (!objective || objective.sufficient !== false) {
    return "This match could not be evaluated.";
  }
  switch (objective.reason) {
    case "too_few_moves": {
      // The gate counts plies, so the message counts plies — and names the
      // equivalent full-move count rather than leaving the reader to guess
      // which "move" is meant.
      const plies = objective.plyCount;
      if (!Number.isFinite(plies)) {
        return "This match is too short to evaluate.";
      }
      const moves = fullMoveCount(plies);
      return `This match is too short to evaluate — only ${plies} ${
        plies === 1 ? "ply" : "plies"
      } (${moves} ${moves === 1 ? "move" : "moves"}) were played. At least ${MIN_EVALUABLE_PLIES} plies are needed.`;
    }
    case "invalid_move_history":
      return "This match's move history could not be replayed, so it can't be evaluated.";
    case "engine_unavailable":
      return "The analysis engine is unavailable right now. Please try again later.";
    case "time_budget_exceeded":
      return "This match was too long to analyse in one pass. Please try again later.";
    case "game_not_found":
      return "This match could not be found.";
    case "database_error":
      // NEVER the driver's message: it can name tables, columns and SQL. The
      // evaluator keeps the detail for server logs; the caller gets this.
      return "We couldn't load this match for evaluation. Please try again later.";
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
    retryAfterMs: null,
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

  if (!isEvaluationSupported(gameKey)) {
    return respond({
      status: 501,
      code: "not_supported",
      message: NOT_YET_SUPPORTED_MESSAGE,
    });
  }

  // ── Request throttle (NOT the daily allowance) ─────────────────────
  // Resolved before any database read or engine work, so a throttled request
  // spends nothing: no claim, no allowance, no model. A legitimate retry after
  // a transient error is just one more request inside the minute's budget.
  const rate = await deps.consumeRequestRateLimit(userId);
  if (!rate.allowed) {
    return respond({
      status: 429,
      code: "rate_limited",
      message: RATE_LIMITED_MESSAGE,
      retryAfterMs: Math.max(0, rate.resetAt - deps.now().getTime()),
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

  if (match.gameKey && match.gameKey !== gameKey) {
    // The id belongs to another game: answer exactly as a missing match would,
    // so one game's matches cannot be probed through another's endpoint.
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

  // ── 5. Tier ─────────────────────────────────────────────────────────
  // Resolved BEFORE the claim, because the claim enforces the allowance for
  // whoever this caller actually is. Fail closed: an unreadable subscription
  // means FREE, never PRO.
  const isPro = await deps.isProMember(userId).catch((err) => {
    console.error("[evaluation] membership lookup failed:", err);
    return false;
  });
  const tier: EvaluationTier = isPro ? "pro" : "free";

  // ── TEMPORARY free-test switch ─────────────────────────────────────
  // Default ENABLED (see freeEvaluationAccessEnabled). When disabled, a Free
  // caller is refused with the SAME 429 upsell the spent-allowance path uses,
  // before any claim — so nothing is spent and PRO is untouched. Every other
  // check below still runs first (ownership, finished, etc.), so this can never
  // bypass authorization.
  if (tier === "free" && !freeEvaluationAccessEnabled()) {
    return respond({
      status: 429,
      code: "daily_limit_reached",
      message: FREE_LIMIT_REACHED_MESSAGE,
      tier,
    });
  }

  const dayStart = startOfTodayUtc(deps.now());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // ── 6. The claim: the ONE decision that bounds every expensive step ──
  //
  // Everything costly hangs off this single atomic step, which is why it
  // replaced the old read-then-work-then-insert sequence: two requests arriving
  // together both missed the lookup and both ran the engine, the model and an
  // INSERT. The database arbitrates now — the unique index on
  // (user_id, game_key, match_id), plus a per-caller advisory lock inside the
  // same transaction for a limited tier — so the winner is the same on every
  // serverless instance. The outcomes:
  //
  //   complete      — an earlier evaluation exists: serve it, spend nothing;
  //   in_progress   — another request holds this match's claim right now;
  //   limit_reached — today's Free allowance is spent;
  //   claimed       — this request owns the key, and is the only one that may
  //                   run the engine and the model for it.
  //
  // Reopening a stored evaluation therefore still costs nothing and needs no
  // allowance: that is the `complete` outcome, decided before the limit is
  // looked at.
  const claim = await deps.claimEvaluation({
    userId,
    gameKey,
    matchId,
    tier,
    dailyLimit: tier === "pro" ? null : FREE_DAILY_EVALUATION_LIMIT,
    dayStart,
    dayEnd,
    stalePendingBefore: new Date(
      deps.now().getTime() - EVALUATION_CLAIM_LEASE_MS,
    ),
  });

  if (claim.outcome === "concurrency_limited") {
    // Distinct from the daily allowance: this is a request-rate/resource limit,
    // reported with the same 429 but its own code and a Retry-After hint.
    return respond({
      status: 429,
      code: "concurrency_limit_reached",
      message: CONCURRENCY_LIMITED_MESSAGE,
      tier,
      retryAfterMs: EVALUATION_CONCURRENCY_RETRY_AFTER_MS,
    });
  }

  if (claim.outcome === "limit_reached") {
    return respond({
      status: 429,
      code: "daily_limit_reached",
      message: FREE_LIMIT_REACHED_MESSAGE,
      tier,
      limits: limitsFor(tier, claim.usedToday),
    });
  }

  if (claim.outcome === "complete") {
    const objective = storedObjective(claim.row.objectiveData);
    const insight = normalizeInsight(claim.row.aiResponse);
    return respond({
      ok: true,
      status: 200,
      code: "cached",
      cached: true,
      // The caller's CURRENT tier, not the tier stored on the row: the usage
      // panel must reflect their account today.
      tier,
      evaluationId: claim.row.id,
      objective,
      insight,
      aiAvailable: Boolean(insight),
      message: insight ? null : aiUnavailableMessage(gameKey),
      // Same shape as a fresh response. The claim computed the caller's current
      // UTC-day usage, so a cached hit reports it WITHOUT spending a second
      // evaluation (no new row, no engine run, no model call).
      limits: limitsFor(tier, claim.usedToday ?? 0),
    });
  }

  if (claim.outcome === "in_progress") {
    // Deliberately NOT a second engine run, and deliberately not the
    // half-written row: the caller gets a retryable answer, and the request
    // holding the claim publishes the result both of them want.
    return respond({
      status: 409,
      code: "evaluation_in_progress",
      message: EVALUATION_IN_PROGRESS_MESSAGE,
      tier,
    });
  }

  // ── 7. This request holds the claim: only it may do the work ────────
  // A takeover of a FAILED row already has its engine stats stored, so only the
  // model is retried — the existing retry semantics, now race-free.
  let objective: EvaluationPayload | null = claim.objective;
  if (!objective) {
    // Explicit, bounded options — see EVALUATION_ANALYSIS_OPTIONS. The engine
    // gets its slice of the route's 60 s; the AI, boot and persistence keep
    // theirs. `gameKey` selects the game's registered analyzer.
    const fresh = await deps.evaluateMatch(
      matchId,
      EVALUATION_ANALYSIS_OPTIONS,
      gameKey,
    );
    const usable = usableEvaluationPayload(fresh);
    if (!usable) {
      // An unevaluatable match keeps NO row, so it never consumes the
      // allowance: the claim is released rather than left behind. A failure to
      // release is logged, not fatal — the caller still needs the real reason.
      await deps.releaseEvaluation(claim.evaluationId).catch((err) => {
        console.error("[evaluation] failed to release the claim:", err);
      });
      const failure = describeUnusablePayload(fresh);
      return respond({
        status: failure.status,
        code: failure.code,
        message: failure.message,
        tier,
        // Only the client-explainable 422 carries the objective. A 4xx/5xx must
        // not hand back the evaluator's internal detail (a driver message, an
        // engine stack), which is exactly what the audit flagged. `message` is
        // likewise generic for these classes.
        objective:
          failure.status === 422 ? (fresh as EvaluationPayload) : null,
        limits: limitsFor(tier, releasedCount(claim)),
      });
    }
    objective = usable;
  }

  // ── 8. The model. Its failure is NOT the request's failure. ────────
  // Only chess has an insight prompt today; another game stores no AI answer
  // and keeps its deterministic report untouched.
  const generated =
    gameKey === "chess"
      ? await generateInsight(objective as ChessObjectiveData, perspective, deps)
      : { insight: null as EvaluationInsight | null, error: null as string | null };
  if (!generated.insight && generated.error) {
    console.warn(
      `[evaluation] insight failed for ${gameKey}/${matchId}: ${generated.error}`,
    );
  }

  // `failed` means "the AI half did not finish and can be retried". That only
  // applies to chess: a game with no insight prompt is complete on its
  // objective report alone, so it is never stored as failed (which would make
  // every later request re-open it).
  const status: "complete" | "failed" =
    generated.insight || gameKey !== "chess" ? "complete" : "failed";

  const stored = await deps.completeEvaluation(claim.evaluationId, {
    objectiveData: objective,
    aiResponse: generated.insight,
    status,
  });

  return respond({
    ok: true,
    status: 200,
    // A RESUMED row keeps the `cached: true` shape it always had (it reused an
    // existing row's engine work rather than claiming a fresh key), but now
    // reports the caller's usage too, like every other response.
    code: claim.resumed ? "cached" : "ok",
    cached: claim.resumed,
    tier,
    evaluationId: stored?.id ?? claim.evaluationId,
    objective,
    insight: generated.insight,
    aiAvailable: Boolean(generated.insight),
    message: generated.insight ? null : aiUnavailableMessage(gameKey),
    limits: limitsFor(tier, claim.usedToday ?? 0),
  });
}

/**
 * Resolves with `promise`'s value, or `null` once `ms` elapses — whichever
 * comes first. The timer is always cleared, so a fast provider cannot leave a
 * live timer behind (which would keep a test process or a warm instance awake).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the model and normalises (or discards) its answer. Never throws: a
 * provider outage — or a provider that simply never answers inside
 * `AI_INSIGHT_TIMEOUT_MS` — degrades to `insight: null` + an error string, which
 * is what lets the request still return the objective statistics.
 */
async function generateInsight(
  objective: ChessObjectiveData,
  perspective: PlayerPerspective,
  deps: EvaluationDeps,
): Promise<{ insight: EvaluationInsight | null; error: string | null }> {
  const prompt = buildChessEvaluationPrompt(objective, perspective);
  try {
    const insightTimeoutMs = deps.insightTimeoutMs ?? AI_INSIGHT_TIMEOUT_MS;
    const result = await withTimeout(
      deps.generateInsight(prompt, EVALUATION_INSIGHT_SCHEMA),
      insightTimeoutMs,
    );
    if (result === null) {
      return {
        insight: null,
        error: `provider did not answer within ${insightTimeoutMs} ms`,
      };
    }
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
    // Guard the uuid columns first: an arbitrary path segment would otherwise
    // raise a driver error instead of answering "no such match".
    if (!UUID_RE.test(matchId)) return null;

    const [chess] = await db
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
    if (chess) return { ...chess, gameKey: "chess" };

    const [ttt] = await db
      .select({
        id: ticTacToeMatches.id,
        player1Id: ticTacToeMatches.player1Id,
        player2Id: ticTacToeMatches.player2Id,
        status: ticTacToeMatches.status,
        result: ticTacToeMatches.result,
      })
      .from(ticTacToeMatches)
      .where(eq(ticTacToeMatches.id, matchId))
      .limit(1);
    if (ttt) {
      return {
        id: String(ttt.id),
        // Seat 1 plays X and moves first — the "first" seat, mapped onto the
        // shared loader's first/second fields whose names are historical.
        playerWhiteId: ttt.player1Id ? String(ttt.player1Id) : null,
        playerBlackId: ttt.player2Id ? String(ttt.player2Id) : null,
        status: ttt.status ?? null,
        result: ttt.result ?? null,
        gameKey: "tic-tac-toe",
      };
    }

    const [spt] = await db
      .select({
        id: speedTypingMatches.id,
        player1Id: speedTypingMatches.player1Id,
        player2Id: speedTypingMatches.player2Id,
        status: speedTypingMatches.status,
        result: speedTypingMatches.result,
      })
      .from(speedTypingMatches)
      .where(eq(speedTypingMatches.id, matchId))
      .limit(1);
    if (spt) {
      return {
        id: String(spt.id),
        // Seat 1 is the host; the shared loader's first/second fields are
        // historical names for "player A / player B".
        playerWhiteId: spt.player1Id ? String(spt.player1Id) : null,
        playerBlackId: spt.player2Id ? String(spt.player2Id) : null,
        status: spt.status ?? null,
        result: spt.result ?? null,
        gameKey: "speed-typing",
      };
    }
    return null;
  },

  isProMember(userId: string): Promise<boolean> {
    return isPremiumMember(userId);
  },

  /**
   * The per-caller request throttle, on the project's existing durable limiter.
   * When Redis is configured this is global; otherwise the fallback is
   * per-instance, which the DB-backed concurrency cap below compensates for.
   */
  async consumeRequestRateLimit(userId: string): Promise<EvaluationRateLimit> {
    const result = await consumeRateLimit(`evaluation:${userId}`, {
      windowMs: EVALUATION_RATE_LIMIT_WINDOW_MS,
      max: EVALUATION_RATE_LIMIT_MAX,
    });
    return {
      allowed: result.allowed,
      limit: result.limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
    };
  },

  /**
   * THE ATOMIC CLAIM (see the flow above).
   *
   * One transaction decides who may evaluate this (user, game, match), and for a
   * limited tier decides it under a per-caller advisory lock, so the daily COUNT
   * and the claim INSERT cannot interleave:
   *
   *   1. an EXISTING row is considered first — `complete` is served as-is (no
   *      engine, no model, no allowance), a live `pending` claim means another
   *      request is already working on this match, and a `failed` row or an
   *      abandoned `pending` row is taken over;
   *   2. with no row, the allowance is counted INSIDE the lock and decides
   *      between claiming the key and answering 429;
   *   3. the claim is an INSERT of a `pending` row arbitrated by the unique index
   *      from migration 0210 (`ON CONFLICT DO NOTHING`), so two instances that
   *      race the same key cannot both win — and the loser is told the work is in
   *      flight instead of starting its own engine run.
   *
   * Nothing here is process-local: the lock and the index are database state, so
   * the decision is identical in two concurrent serverless invocations.
   */
  async claimEvaluation({
    userId,
    gameKey,
    matchId,
    tier,
    dailyLimit,
    dayStart,
    dayEnd,
    stalePendingBefore,
  }) {
    return await db.transaction(async (tx) => {
      // 1. Serialise this caller's claims. The lock is needed for BOTH limits
      //    decided here — the daily COUNT (one caller per day across DIFFERENT
      //    matches, which no uniqueness constraint can express) and the
      //    live-`pending` CONCURRENCY count — so it is taken for every tier. It
      //    is held only for this short transaction, never across the engine.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${EVALUATION_CLAIM_LOCK_NAMESPACE}, ${evaluationLockKey(userId)})`,
      );

      /** A fresh builder for this key's row — never a reused one. */
      const findRow = () =>
        tx
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

      /** The authoritative daily counter — see the note on abandoned claims. */
      const countToday = async () => {
        const rows = await tx
          .select({ n: count() })
          .from(evaluationResults)
          .where(
            and(
              eq(evaluationResults.userId, userId),
              gte(evaluationResults.createdAt, dayStart),
              lt(evaluationResults.createdAt, dayEnd),
              // A claim still inside its lease counts (that request is working
              // right now); an ABANDONED one does not, because charging a player
              // for a request that died would spend the allowance on nothing.
              or(
                ne(evaluationResults.status, "pending"),
                gt(evaluationResults.createdAt, stalePendingBefore),
              ),
            ),
          );
        return Number(rows[0]?.n ?? 0);
      };

      /**
       * The caller's LIVE in-flight analyses: `pending` rows still inside the
       * lease. This IS the concurrency reservation — a row is created before the
       * engine runs and stops qualifying the moment it completes, fails, or is
       * abandoned past the lease. Read under the per-caller lock, so two
       * requests for two different matches cannot both see a free slot.
       */
      const countLivePending = async () => {
        const rows = await tx
          .select({ n: count() })
          .from(evaluationResults)
          .where(
            and(
              eq(evaluationResults.userId, userId),
              eq(evaluationResults.status, "pending"),
              gt(evaluationResults.createdAt, stalePendingBefore),
            ),
          );
        return Number(rows[0]?.n ?? 0);
      };

      // 2. This key's row, LOCKED, so a second claim on the same row queues
      //    behind this one instead of reading it mid-takeover.
      const [existing] = await findRow().for("update");

      if (existing) {
        if (existing.status === "complete") {
          // Nothing is SPENT: reopening a stored result is not a new evaluation
          // — no allowance, no engine, no model. But the cached response now
          // reports the caller's CURRENT usage, so the count is read here too
          // (one indexed COUNT) rather than letting the usage panel vanish.
          return {
            outcome: "complete" as const,
            row: existing,
            usedToday: dailyLimit === null ? null : await countToday(),
          };
        }

        const objective = storedObjective(existing.objectiveData);
        // A FAILED row is resumable immediately: its engine stats are stored, so
        // the retry is a model call. A PENDING row is resumable only after its
        // lease expires — before that, another request is working on it.
        const abandoned =
          !existing.createdAt ||
          new Date(existing.createdAt).getTime() <= stalePendingBefore.getTime();
        const resumable =
          existing.status === "failed" ? Boolean(objective) : abandoned;

        if (!resumable) {
          return { outcome: "in_progress" as const, row: existing };
        }

        // Take it over. The conditional WHERE means a row that somehow finished
        // between the read and this write is left untouched.
        const [taken] = await tx
          .update(evaluationResults)
          .set({ status: "pending" })
          .where(
            and(
              eq(evaluationResults.id, existing.id),
              ne(evaluationResults.status, "complete"),
            ),
          )
          .returning({ id: evaluationResults.id });

        if (!taken) {
          return { outcome: "in_progress" as const, row: existing };
        }

        return {
          outcome: "claimed" as const,
          evaluationId: taken.id,
          // Only a FAILED row carries stats worth reusing; an abandoned PENDING
          // row never got past the claim marker.
          objective: existing.status === "failed" ? objective : null,
          usedToday: dailyLimit === null ? null : await countToday(),
          countedToday:
            dailyLimit !== null &&
            isWithinDay(existing.createdAt, dayStart, dayEnd),
          resumed: true,
        };
      }

      // 3. No row for this key. The CONCURRENCY reservation is checked FIRST (it
      //    protects the engine), then the daily allowance — both inside the lock,
      //    so simultaneous requests cannot both see a free slot.
      const livePending = await countLivePending();
      if (livePending >= MAX_CONCURRENT_EVALUATIONS_PER_USER) {
        return { outcome: "concurrency_limited" as const, livePending };
      }

      const usedToday = dailyLimit === null ? null : await countToday();
      if (dailyLimit !== null && (usedToday ?? 0) >= dailyLimit) {
        return { outcome: "limit_reached" as const, usedToday: usedToday ?? 0 };
      }

      const [inserted] = await tx
        .insert(evaluationResults)
        .values({
          userId,
          gameKey,
          matchId,
          tier,
          // `objective_data` is NOT NULL, so a claim in flight must carry
          // something. The marker is deliberately not a usable analysis:
          // `storedObjective()` rejects it, so it can never be served as stats.
          objectiveData: EVALUATION_CLAIM_MARKER,
          aiResponse: null,
          status: "pending",
        })
        .onConflictDoNothing({
          target: [
            evaluationResults.userId,
            evaluationResults.gameKey,
            evaluationResults.matchId,
          ],
        })
        .returning({ id: evaluationResults.id });

      if (!inserted) {
        // Lost the race between the read and the insert. Whoever won is either
        // done (serve it) or working (say so) — never a second engine run.
        const [winner] = await findRow();
        if (winner && winner.status === "complete") {
          return { outcome: "complete" as const, row: winner, usedToday };
        }
        return { outcome: "in_progress" as const, row: winner ?? null };
      }

      return {
        outcome: "claimed" as const,
        evaluationId: inserted.id,
        objective: null,
        usedToday: usedToday === null ? null : usedToday + 1,
        countedToday: dailyLimit !== null,
        resumed: false,
      };
    });
  },

  /**
   * Drops a claim whose match turned out to be unevaluatable, so the feature
   * keeps its promise that a refused match consumes no allowance and leaves no
   * row behind. It refuses to delete a `complete` row: the result a player
   * already has is never the thing that gets removed.
   */
  async releaseEvaluation(evaluationId: string): Promise<void> {
    await db
      .delete(evaluationResults)
      .where(
        and(
          eq(evaluationResults.id, evaluationId),
          ne(evaluationResults.status, "complete"),
        ),
      );
  },

  evaluateMatch(
    matchId: string,
    options?: ChessAnalysisOptions,
    gameKey = "chess",
  ): Promise<unknown> {
    // Dispatch through the registry: the game key decides the analyzer, so a
    // new game is a registration, not an edit here. Only registered games ever
    // reach this point — the service gates on `isEvaluationSupported` first.
    const analyzer = getEvaluationAnalyzer(gameKey);
    if (!analyzer) {
      return Promise.reject(
        new Error(`No evaluation analyzer registered for "${gameKey}".`),
      );
    }
    return analyzer.analyze(matchId, options);
  },

  generateInsight(prompt: string, schema: object): Promise<LLMEvaluationResult> {
    return groqProvider.generateEvaluation(prompt, schema);
  },

  /**
   * Writes the finished result onto the claimed row.
   *
   * The `status <> 'complete'` guard is the second half of the claim: a request
   * that somehow lost the race, or a retry that overlapped a success, cannot
   * replace a stored result with its own — so a `complete` row can never be
   * downgraded to `failed`, and no second copy is ever written for the key.
   */
  async completeEvaluation(evaluationId, result) {
    const [row] = await db
      .update(evaluationResults)
      .set({
        objectiveData: result.objectiveData,
        aiResponse: result.aiResponse ?? null,
        status: result.status,
      })
      .where(
        and(
          eq(evaluationResults.id, evaluationId),
          ne(evaluationResults.status, "complete"),
        ),
      )
      .returning({
        id: evaluationResults.id,
        tier: evaluationResults.tier,
        status: evaluationResults.status,
        objectiveData: evaluationResults.objectiveData,
        aiResponse: evaluationResults.aiResponse,
        createdAt: evaluationResults.createdAt,
      });
    return row ?? null;
  },
};
