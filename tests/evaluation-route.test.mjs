/**
 * Game Evaluation — API service contract (POST /api/evaluation/[gameKey]/[matchId]).
 *
 * The route itself is a thin shell (auth gate + response mapping); every
 * decision lives in src/lib/evaluation/evaluationService.ts, so this file drives
 * the REAL decision code with fake dependencies. That is what makes the
 * behaviour testable at all: the daily limit needs a database COUNT, the cache
 * needs a stored row, and the LLM needs an outage — all of which are fakes here
 * and real in production.
 *
 * Covered:
 *   • Free tier: exactly ONE evaluation per UTC day, DB-counted, 429 after
 *     that — and the count is per caller, per day, not per device.
 *   • Pro: unlimited (the daily counter is never consulted).
 *   • Ownership: someone else's match is refused, and a finished-only rule.
 *   • Idempotency: a stored evaluation is returned instead of re-running the
 *     engine/model; a failed model run is retried on the SAME row.
 *   • Degradation: an LLM failure still returns the objective stats.
 *   • Insufficient data: flagged, no row, no allowance consumed.
 *   • The prompt actually pins the model to the supplied data, and the response
 *     schema keeps every section optional except the summary.
 *
 * Run: npm run test:evaluation
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FREE_DAILY_EVALUATION_LIMIT,
  FREE_LIMIT_REACHED_MESSAGE,
  normalizeInsight,
  runEvaluation,
  startOfTodayUtc,
} from "../src/lib/evaluation/evaluationService.ts";
import {
  AI_UNAVAILABLE_MESSAGE,
  EVALUATION_INSIGHT_SCHEMA,
  buildChessEvaluationPrompt,
} from "../src/lib/evaluation/insight.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "..", rel), "utf8");

const ROUTE = read("src/app/api/evaluation/[gameKey]/[matchId]/route.ts");
const SERVICE = read("src/lib/evaluation/evaluationService.ts");

const ME = "user_me";
const OTHER = "user_other";
const MATCH = "11111111-1111-4111-8111-111111111111";
const MATCH_2 = "22222222-2222-4222-8222-222222222222";
const MATCH_3 = "33333333-3333-4333-8333-333333333333";
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A minimal but complete objective payload (the shape the evaluator returns). */
function objective(matchId, { sufficient = true } = {}) {
  if (!sufficient) {
    return {
      gameId: matchId,
      sufficient: false,
      reason: "too_few_moves",
      detail: "only 2 move(s) were played; at least 5 are needed",
      moveCount: 2,
    };
  }
  const move = (ply, color, cpBefore, cpAfter) => ({
    ply,
    moveNumber: Math.ceil(ply / 2),
    san: ply === 1 ? "e4" : "e5",
    uci: ply === 1 ? "e2e4" : "e7e5",
    playedBy: color === "white" ? ME : OTHER,
    color,
    evalBeforeCp: cpBefore,
    evalAfterCp: cpAfter,
    cpLoss: 0,
    classification: "good",
    isKeyMoment: false,
    wasEngineBestMove: true,
    engineBestMoveUci: ply === 1 ? "e2e4" : "e7e5",
    thinkTimeMs: 3000,
  });
  return {
    gameId: matchId,
    sufficient: true,
    moveCount: 2,
    plyCount: 2,
    engine: { id: "Stockfish 16 (test)", depth: 10, moveTimeMs: 250 },
    players: {
      white: { playedBy: ME, color: "white", moveCount: 1, accuracyPercent: 90 },
      black: { playedBy: OTHER, color: "black", moveCount: 1, accuracyPercent: 70 },
    },
    keyMoment: null,
    blunders: [],
    mistakes: [],
    moves: [move(1, "white", 20, 20), move(2, "black", 20, -30)],
    thresholds: { blunderCp: 100, mistakeCp: 50 },
    analysisMs: 1200,
  };
}

function matchRow(overrides = {}) {
  return {
    id: MATCH,
    playerWhiteId: ME,
    playerBlackId: OTHER,
    status: "finished",
    result: "win",
    ...overrides,
  };
}

function storedRow(overrides = {}) {
  return {
    id: "row-1",
    tier: "free",
    status: "complete",
    objectiveData: objective(MATCH),
    aiResponse: { summary: "A short, even game." },
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A fake dependency set that records every call, so "did this re-run the
 * engine?" and "how many times was the model asked?" are observable facts
 * rather than assumptions.
 */
function makeDeps(overrides = {}) {
  const calls = {
    evaluateMatch: 0,
    generateInsight: 0,
    insertEvaluation: 0,
    updateEvaluation: 0,
    countEvaluationsSince: 0,
    isProMember: 0,
  };
  const inserted = [];

  const deps = {
    now: () => new Date("2026-01-01T12:00:00.000Z"),
    getUserAliases: async (userId) => [userId, "42"],
    loadMatch: async (matchId) => (matchId === MATCH ? matchRow() : null),
    isProMember: async () => {
      calls.isProMember += 1;
      return false;
    },
    countEvaluationsSince: async () => {
      calls.countEvaluationsSince += 1;
      return 0;
    },
    findExisting: async () => null,
    evaluateMatch: async (matchId) => {
      calls.evaluateMatch += 1;
      return objective(matchId);
    },
    generateInsight: async () => {
      calls.generateInsight += 1;
      return { success: true, data: { summary: "Generated analysis." } };
    },
    insertEvaluation: async (values) => {
      calls.insertEvaluation += 1;
      inserted.push(values);
      return { id: `row-${inserted.length}`, tier: values.tier, status: values.status };
    },
    updateEvaluation: async () => {
      calls.updateEvaluation += 1;
    },
    ...overrides,
  };

  return { deps, calls, inserted };
}

const run = (deps, input = {}) =>
  runEvaluation(
    { userId: ME, gameKey: "chess", matchId: MATCH, ...input },
    deps,
  );

// ════════════════════════════════════════════════════════════════════
// 1. Free tier — one evaluation per UTC day, enforced server-side
// ════════════════════════════════════════════════════════════════════

test("free tier: the first evaluation of the day succeeds and reports the remaining allowance", async () => {
  const { deps, calls, inserted } = makeDeps();
  const result = await run(deps);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.code, "ok");
  assert.equal(result.tier, "free");
  assert.equal(result.cached, false);
  assert.equal(result.aiAvailable, true);
  assert.equal(result.insight.summary, "Generated analysis.");
  assert.equal(result.objective.sufficient, true);

  // The daily counter was consulted (a real COUNT in production) and the row
  // carries the tier it was generated under.
  assert.equal(calls.countEvaluationsSince, 1);
  assert.equal(calls.insertEvaluation, 1);
  assert.equal(inserted[0].tier, "free");
  assert.equal(inserted[0].status, "complete");
  assert.deepEqual(result.limits, {
    tier: "free",
    dailyLimit: FREE_DAILY_EVALUATION_LIMIT,
    usedToday: 1,
    remaining: 0,
  });
});

test("free tier: a second match on the same day is refused with an upgrade message", async () => {
  const { deps, calls } = makeDeps({
    // One row already exists today.
    countEvaluationsSince: async () => 1,
    loadMatch: async (matchId) => matchRow({ id: matchId }),
  });

  const result = await run(deps, { matchId: MATCH_2 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.code, "daily_limit_reached");
  assert.match(result.message, /upgrade to GRYND PRO/i);
  assert.equal(result.message, FREE_LIMIT_REACHED_MESSAGE);
  assert.deepEqual(result.limits, {
    tier: "free",
    dailyLimit: 1,
    usedToday: 1,
    remaining: 0,
  });

  // The limit is checked BEFORE any expensive work: no engine, no model, no row.
  assert.equal(calls.evaluateMatch, 0, "the engine must not run for a refused request");
  assert.equal(calls.generateInsight, 0, "the model must not run for a refused request");
  assert.equal(calls.insertEvaluation, 0);
});

test("free tier: the count is per caller and bounded to the UTC day", async () => {
  // The service asks the DB for exactly [midnight UTC, next midnight UTC) for
  // THIS user id — so another account's evaluations, or yesterday's, cannot
  // consume the allowance and clearing client storage changes nothing.
  const windows = [];
  const { deps } = makeDeps({
    countEvaluationsSince: async (userId, from, to) => {
      windows.push({ userId, from, to });
      return 1;
    },
  });

  await run(deps);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].userId, ME);
  assert.equal(windows[0].from.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(
    windows[0].to.getTime() - windows[0].from.getTime(),
    DAY_MS,
    "the window is exactly one UTC day",
  );

  // And the boundary helper is UTC, not local time.
  const boundary = startOfTodayUtc(new Date("2026-01-01T23:59:59.999Z"));
  assert.equal(boundary.toISOString(), "2026-01-01T00:00:00.000Z");
  const nextDay = startOfTodayUtc(new Date("2026-01-02T00:00:00.000Z"));
  assert.notEqual(nextDay.getTime(), boundary.getTime(), "a new UTC day resets it");
});

test("free tier: the enforcement is a DB count, never a cache-only check", () => {
  // The service must reach the database for the daily figure, and must not
  // short-circuit on any client-supplied or cache-only signal.
  assert.match(SERVICE, /select\(\{ n: count\(\) \}\)\s*\.from\(evaluationResults\)/);
  assert.match(SERVICE, /gte\(evaluationResults\.createdAt, from\)/);
  assert.match(SERVICE, /lt\(evaluationResults\.createdAt, to\)/);
  assert.match(SERVICE, /eq\(evaluationResults\.userId, userId\)/);
  // No request body is read by the route at all, so no field can be spoofed.
  assert.doesNotMatch(ROUTE, /req\.json\(\)/);
  assert.doesNotMatch(SERVICE, /body\?\.|req\.json/);
  // The tier is resolved server-side from the membership source of truth.
  assert.match(SERVICE, /isPremiumMember/);
});

// ════════════════════════════════════════════════════════════════════
// 2. Pro — unlimited
// ════════════════════════════════════════════════════════════════════

test("pro tier: unlimited evaluations, and the daily counter is never consulted", async () => {
  const { deps, calls, inserted } = makeDeps({
    isProMember: async () => {
      calls.isProMember += 1;
      return true;
    },
    loadMatch: async (matchId) => matchRow({ id: matchId }),
  });

  for (const matchId of [MATCH, MATCH_2, MATCH_3]) {
    const result = await run(deps, { matchId });
    assert.equal(result.ok, true, `${matchId} must be allowed on PRO`);
    assert.equal(result.tier, "pro");
    assert.deepEqual(result.limits, {
      tier: "pro",
      dailyLimit: null,
      usedToday: 0,
      remaining: null,
    });
  }

  assert.equal(calls.insertEvaluation, 3, "all three were generated");
  assert.equal(calls.countEvaluationsSince, 0, "PRO never hits the daily counter");
  assert.equal(inserted.length, 3);
});

test("pro tier: an unreadable membership lookup fails closed to FREE", async () => {
  const { deps } = makeDeps({
    isProMember: async () => {
      throw new Error("stripe table unavailable");
    },
    countEvaluationsSince: async () => 1,
  });

  const result = await run(deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 429, "an outage must not grant PRO treatment");
  assert.equal(result.tier, "free");
});

// ════════════════════════════════════════════════════════════════════
// 3. Ownership + finished state
// ════════════════════════════════════════════════════════════════════

test("ownership: someone else's match is refused and nothing is generated", async () => {
  const { deps, calls } = makeDeps({
    loadMatch: async () =>
      matchRow({ playerWhiteId: "user_stranger", playerBlackId: "user_other_2" }),
  });

  const result = await run(deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "not_a_participant");
  assert.match(result.message, /your own matches/i);
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.generateInsight, 0);
  assert.equal(calls.insertEvaluation, 0);
  // The caller's tier is not even resolved for a request that can never run.
  assert.equal(calls.isProMember, 0);
});

test("ownership: a legacy numeric id on the row still counts as the caller", async () => {
  // /api/chess/move accepts the numeric users.id for old rows; so does this.
  const { deps } = makeDeps({
    getUserAliases: async (userId) => [userId, "42"],
    loadMatch: async () => matchRow({ playerWhiteId: "42", playerBlackId: OTHER }),
  });

  const result = await run(deps);
  assert.equal(result.ok, true, "the alias must be accepted as ownership");
});

test("finished state: an in-progress or expired match is refused", async () => {
  for (const status of ["in_progress", "waiting", "expired", "active"]) {
    const { deps, calls } = makeDeps({
      loadMatch: async () => matchRow({ status }),
    });
    const result = await run(deps);
    assert.equal(result.ok, false, `${status} must be refused`);
    assert.equal(result.status, 409);
    assert.equal(result.code, "match_not_finished");
    assert.equal(calls.evaluateMatch, 0);
  }
});

test("a match that does not exist is a 404 and never touches Postgres", async () => {
  const { deps } = makeDeps({ loadMatch: async () => null });
  const result = await run(deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "match_not_found");

  // The production loader checks the uuid shape BEFORE querying, because
  // `chess_games.id` is a uuid column and an arbitrary path segment would
  // otherwise raise a driver error.
  assert.match(SERVICE, /UUID_RE\.test\(matchId\)/);
  assert.match(SERVICE, /if \(!UUID_RE\.test\(matchId\)\) return null/);
});

// ════════════════════════════════════════════════════════════════════
// 4. Idempotent caching
// ════════════════════════════════════════════════════════════════════

test("caching: an existing evaluation is returned instead of regenerated", async () => {
  const { deps, calls } = makeDeps({
    findExisting: async () => storedRow(),
    countEvaluationsSince: async () => 1, // the day is already used up
  });

  const result = await run(deps);

  assert.equal(result.ok, true);
  assert.equal(result.code, "cached");
  assert.equal(result.cached, true);
  assert.equal(result.evaluationId, "row-1");
  assert.equal(result.insight.summary, "A short, even game.");
  assert.equal(result.objective.sufficient, true);

  // No engine run, no model call, no new row — and the cached result is served
  // even when today's free evaluation is already spent.
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.generateInsight, 0);
  assert.equal(calls.insertEvaluation, 0);
  assert.equal(calls.countEvaluationsSince, 0, "a cache hit outranks the limit check");
});

test("caching: a stored FAILED evaluation retries the model on the SAME row", async () => {
  const { deps, calls, inserted } = makeDeps({
    findExisting: async () =>
      storedRow({ status: "failed", aiResponse: null }),
  });

  const result = await run(deps);

  assert.equal(result.ok, true);
  assert.equal(result.code, "cached");
  assert.equal(result.aiAvailable, true);
  assert.equal(result.insight.summary, "Generated analysis.");

  // The engine is NOT re-run (the objective data is already stored) and no
  // second row is created.
  assert.equal(calls.evaluateMatch, 0, "the engine work is reused");
  assert.equal(calls.generateInsight, 1);
  assert.equal(calls.updateEvaluation, 1);
  assert.equal(calls.insertEvaluation, 0);
  assert.equal(inserted.length, 0);
});

test("caching: a stored row whose analysis is missing degrades instead of crashing", async () => {
  const { deps, calls } = makeDeps({
    findExisting: async () => storedRow({ status: "failed", aiResponse: null }),
    generateInsight: async () => ({ success: false, error: "groq 503" }),
  });

  const result = await run(deps);
  assert.equal(result.ok, true, "the stored stats are still returned");
  assert.equal(result.aiAvailable, false);
  assert.equal(result.insight, null);
  assert.equal(result.message, AI_UNAVAILABLE_MESSAGE);
  assert.equal(calls.updateEvaluation, 1);
});

// ════════════════════════════════════════════════════════════════════
// 5. LLM failure degrades — the user still sees their real stats
// ════════════════════════════════════════════════════════════════════

test("LLM outage: the objective evaluation is still returned with a fallback message", async () => {
  const { deps, inserted } = makeDeps({
    generateInsight: async () => ({ success: false, error: "Groq returned HTTP 503" }),
  });

  const result = await run(deps);

  assert.equal(result.ok, true, "a provider outage is not a failed request");
  assert.equal(result.status, 200);
  assert.equal(result.code, "ok");
  assert.equal(result.aiAvailable, false);
  assert.equal(result.insight, null);
  assert.equal(result.message, AI_UNAVAILABLE_MESSAGE);
  assert.equal(result.objective.sufficient, true, "the real stats survive");
  assert.ok(result.objective.moves.length > 0);
  // The row is still written, marked failed, so the stats are not lost and the
  // model can be retried later without re-running the engine.
  assert.equal(inserted[0].status, "failed");
  assert.equal(inserted[0].aiResponse, null);
});

test("LLM outage: a provider that throws is handled the same way", async () => {
  const { deps } = makeDeps({
    generateInsight: async () => {
      throw new Error("fetch failed");
    },
  });

  const result = await run(deps);
  assert.equal(result.ok, true);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.message, AI_UNAVAILABLE_MESSAGE);
});

test("LLM outage: an answer without a usable summary is discarded, not persisted", async () => {
  const { deps, inserted } = makeDeps({
    generateInsight: async () => ({ success: true, data: { strengths: ["nice"] } }),
  });

  const result = await run(deps);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.insight, null);
  assert.equal(inserted[0].status, "failed");
});

// ════════════════════════════════════════════════════════════════════
// 6. Insufficient data — flagged, and never charged against the allowance
// ════════════════════════════════════════════════════════════════════

test("insufficient data: 422 with the reason, no row, allowance untouched", async () => {
  const { deps, calls, inserted } = makeDeps({
    evaluateMatch: async (matchId) => objective(matchId, { sufficient: false }),
  });

  const result = await run(deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.code, "insufficient_data");
  assert.match(result.message, /too short to evaluate/i);
  assert.equal(result.objective.sufficient, false, "the client gets the reason");
  assert.deepEqual(result.limits, {
    tier: "free",
    dailyLimit: 1,
    usedToday: 0,
    remaining: 1,
  });

  assert.equal(calls.generateInsight, 0, "no model call for an unevaluatable match");
  assert.equal(inserted.length, 0, "nothing is written, so nothing is consumed");
  assert.equal(calls.insertEvaluation, 0);
});

// ════════════════════════════════════════════════════════════════════
// 7. Unsupported game + input validation
// ════════════════════════════════════════════════════════════════════

test("unsupported gameKey answers 501 without touching the database", async () => {
  const { deps, calls } = makeDeps();
  for (const gameKey of ["mines-pvp", "mini-golf", "keno", "chess960"]) {
    const result = await run(deps, { gameKey });
    assert.equal(result.ok, false);
    assert.equal(result.status, 501, `${gameKey} is not supported yet`);
    assert.equal(result.code, "not_supported");
    assert.match(result.message, /aren't available yet/i);
  }
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.isProMember, 0);
});

test("a missing match id is a 400, and a missing caller a 401", async () => {
  const { deps } = makeDeps();
  const missingMatch = await run(deps, { matchId: "   " });
  assert.equal(missingMatch.status, 400);
  assert.equal(missingMatch.code, "invalid_request");

  const anonymous = await runEvaluation(
    { userId: "", gameKey: "chess", matchId: MATCH },
    deps,
  );
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.code, "unauthenticated");
});

// ════════════════════════════════════════════════════════════════════
// 8. The prompt + schema pin the model to the supplied data
// ════════════════════════════════════════════════════════════════════

test("the prompt embeds the objective JSON verbatim and forbids invention", () => {
  const data = objective(MATCH);
  const prompt = buildChessEvaluationPrompt(data, "white");

  // The whole payload is present, so every fact the model can state is in the
  // message it received.
  assert.ok(prompt.includes(JSON.stringify(data)), "the objective data must be embedded");
  assert.ok(prompt.includes('"evalAfterCp":-30'), "per-move evals are supplied");
  assert.ok(prompt.includes("Stockfish 16 (test)"), "the engine identity is supplied");

  // Explicit prohibitions, including the ones a model is most likely to break.
  assert.match(prompt, /NEVER invent a move/i);
  assert.match(prompt, /copied EXACTLY from the JSON/i);
  assert.match(prompt, /did NOT judge this game/i);
  assert.match(prompt, /played WHITE/i, "the reader's colour frames the answer");
  assert.match(prompt, /OMIT that key completely/i);
  assert.match(prompt, /search depth/i, "shallow-search mislabels are disclosed");

  // The perspective is honest when it could not be resolved.
  const neutral = buildChessEvaluationPrompt(data, null);
  assert.match(neutral, /perspective of the player reading this is unknown/i);
});

test("the response schema matches the spec: every section optional but summary", () => {
  assert.deepEqual(Object.keys(EVALUATION_INSIGHT_SCHEMA.properties), [
    "summary",
    "strengths",
    "weaknesses",
    "key_moments",
    "improvements",
    "next_time_tip",
  ]);
  assert.deepEqual(EVALUATION_INSIGHT_SCHEMA.required, ["summary"]);
  for (const key of ["strengths", "weaknesses", "improvements"]) {
    assert.equal(EVALUATION_INSIGHT_SCHEMA.properties[key].type, "array");
  }
  assert.equal(EVALUATION_INSIGHT_SCHEMA.properties.key_moments.type, "array");
  assert.equal(EVALUATION_INSIGHT_SCHEMA.properties.next_time_tip.type, "string");
});

test("normalizeInsight drops empty sections, unknown keys and junk entries", () => {
  const insight = normalizeInsight({
    summary: "  Tight game.  ",
    strengths: ["Good opening", "", 42, "  "],
    weaknesses: [],
    key_moments: [
      { move: "10... Bxd1", note: "lost the queen" },
      { move: 12, note: "bad" },
      { move: "5. Nxe5", note: "" },
    ],
    improvements: ["Count material before capturing"],
    next_time_tip: "   ",
    hallucinated_stats: { accuracy: 100 },
  });

  assert.equal(insight.summary, "Tight game.");
  assert.deepEqual(insight.strengths, ["Good opening"]);
  assert.equal("weaknesses" in insight, false, "an empty array must be dropped, not stored");
  assert.deepEqual(insight.key_moments, [
    { move: "10... Bxd1", note: "lost the queen" },
  ]);
  assert.deepEqual(insight.improvements, ["Count material before capturing"]);
  assert.equal("next_time_tip" in insight, false);
  assert.equal("hallucinated_stats" in insight, false, "unknown keys are discarded");

  // A payload with no usable summary is not an answer at all.
  assert.equal(normalizeInsight({ strengths: ["x"] }), null);
  assert.equal(normalizeInsight(null), null);
  assert.equal(normalizeInsight("just prose"), null);
  assert.equal(normalizeInsight([{ summary: "in an array" }]), null);
});

// ════════════════════════════════════════════════════════════════════
// 9. Route wiring (the shell must stay a shell)
// ════════════════════════════════════════════════════════════════════

test("the route is auth-gated, Node-runtime, and delegates every decision", () => {
  assert.match(ROUTE, /import \{ requireAgeVerifiedUser \}/);
  assert.match(ROUTE, /const gate = await requireAgeVerifiedUser\(\)/);
  assert.match(ROUTE, /if \(gate\.response\) return gate\.response/);
  assert.match(ROUTE, /export const runtime = "nodejs"/);
  assert.match(ROUTE, /export const maxDuration = 60/);
  assert.match(ROUTE, /runEvaluation\(\{ userId, gameKey, matchId \}\)/);
  // The gate's userId is what is used — never a client-supplied identity.
  assert.match(ROUTE, /const userId = gate\.userId/);
  assert.doesNotMatch(ROUTE, /searchParams\.get\("userId"\)|body\?\.userId/);
  // Failures are logged with the endpoint's own error type, not swallowed.
  assert.match(ROUTE, /logError\(\{/);
  assert.match(ROUTE, /errorType: "game_evaluation_error"/);
});

test("the service is game-agnostic: gameKey drives support, not the route", () => {
  // Adding a game means adding an evaluator + listing it here, not a new route.
  assert.match(SERVICE, /SUPPORTED_EVALUATION_GAMES: string\[\] = \["chess"\]/);
  assert.match(SERVICE, /SUPPORTED_EVALUATION_GAMES\.includes\(gameKey\)/);
  // The provider is behind the LLMProvider interface, so it is swappable.
  assert.match(SERVICE, /groqProvider\.generateEvaluation\(prompt, schema\)/);
  assert.match(SERVICE, /import \{ groqProvider \} from "\.\/providers\/groqProvider"/);
});
