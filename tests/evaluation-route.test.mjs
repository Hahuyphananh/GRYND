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
 *   • Concurrency: overlapping requests converge on ONE row, one engine run and
 *     one model call — the loser is told the work is in flight (409) rather than
 *     starting a second analysis, and a Free caller cannot spend the one-per-day
 *     allowance twice. Section 7.
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
  AI_INSIGHT_RESERVE_MS,
  AI_INSIGHT_TIMEOUT_MS,
  CONCURRENCY_LIMITED_MESSAGE,
  ENGINE_BOOT_RESERVE_MS,
  EVALUATION_ANALYSIS_OPTIONS,
  EVALUATION_CLAIM_LEASE_MS,
  EVALUATION_CONCURRENCY_RETRY_AFTER_MS,
  EVALUATION_ENGINE_TIME_BUDGET_MS,
  EVALUATION_PERSISTENCE_RESERVE_MS,
  EVALUATION_RATE_LIMIT_MAX,
  EVALUATION_RATE_LIMIT_WINDOW_MS,
  EVALUATION_SAFETY_MARGIN_MS,
  FREE_DAILY_EVALUATION_LIMIT,
  FREE_LIMIT_REACHED_MESSAGE,
  MAX_CONCURRENT_EVALUATIONS_PER_USER,
  freeEvaluationAccessEnabled,
  RATE_LIMITED_MESSAGE,
  ROUTE_MAX_DURATION_MS,
  normalizeInsight,
  runEvaluation,
  startOfTodayUtc,
} from "../src/lib/evaluation/evaluationService.ts";
import {
  AI_UNAVAILABLE_MESSAGE,
  EVALUATION_INSIGHT_SCHEMA,
  buildChessEvaluationPrompt,
} from "../src/lib/evaluation/insight.ts";
import { GroqProvider } from "../src/lib/evaluation/providers/groqProvider.ts";

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
      // The evaluator reports BOTH units, and the gate counts plies: a 2-ply
      // game is 1 completed full move.
      detail: "only 2 plies were played; at least 5 plies are needed",
      moveCount: 1,
      plyCount: 2,
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
    // Full moves vs plies — see src/lib/evaluation/moveCounts.ts.
    moveCount: 1,
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
    // The claim key — migration 0210's unique index is over exactly these
    // three columns, so the fake store keys rows the same way.
    userId: ME,
    gameKey: "chess",
    matchId: MATCH,
    tier: "free",
    status: "complete",
    objectiveData: objective(MATCH),
    aiResponse: { summary: "A short, even game." },
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A LIVE in-flight claim (`pending`, inside the lease) for a given match — used
 * to seed the concurrency cap without needing two real interleaved runs.
 */
function storedPendingRow(overrides = {}) {
  return storedRow({
    tier: "free",
    status: "pending",
    objectiveData: { pending: true },
    aiResponse: null,
    // Inside the lease relative to FIXED_NOW (2026-01-01T12:00Z).
    createdAt: new Date("2026-01-01T11:59:00.000Z"),
    ...overrides,
  });
}

/**
 * A finished evaluation for ANOTHER match today — i.e. today's Free allowance
 * is already spent, while the match under test has no row of its own.
 */
function spentDayRow() {
  return storedRow({
    id: "row-spent",
    matchId: MATCH_3,
    objectiveData: objective(MATCH_3),
    createdAt: new Date("2026-01-01T09:00:00.000Z"),
  });
}

/**
 * A fake `evaluation_results` table PLUS the atomic claim.
 *
 * The service's real decision code runs against this, so the tests can watch
 * exactly what the claim protects: the row key, the daily COUNT and the claim
 * INSERT all live here, mirroring migration 0210's unique index and the
 * production `claimEvaluation` (same lease, same conflict rule, same guard on
 * writing a result).
 *
 * The claim body changes state WITHOUT awaiting anything, so under JavaScript's
 * run-to-completion it is atomic — the same guarantee the real database
 * transaction gives, and what makes the "concurrency:" tests at the bottom of
 * this file meaningful.
 */
function makeStore({ rows = [], now = () => new Date("2026-01-01T12:00:00.000Z") } = {}) {
  const store = {
    rows: rows.map((row) => ({ ...row })),
    nextId: 1,
    claimRequests: [],
    claimed: 0,
    inserts: 0,
    completions: 0,
    releases: 0,
    countedToday: 0,
  };

  const at = (value) => new Date(value).getTime();

  /** The stored stats, only when they are a usable analysis (see storedObjective). */
  const usableObjective = (row) => {
    const data = row?.objectiveData;
    return data && typeof data === "object" && data.sufficient === true && Array.isArray(data.moves)
      ? data
      : null;
  };

  const claimEvaluation = (request) => {
    store.claimRequests.push(request);
    const { userId, gameKey, matchId, tier, dailyLimit, dayStart, dayEnd, stalePendingBefore } =
      request;

    const forKey = () =>
      store.rows.filter(
        (row) => row.userId === userId && row.gameKey === gameKey && row.matchId === matchId,
      );

    const countToday = () => {
      if (dailyLimit === null) return null;
      store.countedToday += 1;
      return store.rows.filter(
        (row) =>
          row.userId === userId &&
          at(row.createdAt) >= dayStart.getTime() &&
          at(row.createdAt) < dayEnd.getTime() &&
          // An abandoned claim does not count (see the production comment).
          (row.status !== "pending" || at(row.createdAt) > stalePendingBefore.getTime()),
      ).length;
    };

    const existing =
      forKey().sort((a, b) => at(b.createdAt) - at(a.createdAt))[0] ?? null;

    if (existing) {
      if (existing.status === "complete") {
        // No SPEND: reopening a stored result is not a new evaluation. But the
        // current usage IS counted (mirrors the production claim), so a cached
        // response can report the caller's real allowance.
        return { outcome: "complete", row: existing, usedToday: countToday() };
      }

      const objective = usableObjective(existing);
      const abandoned = at(existing.createdAt) <= stalePendingBefore.getTime();
      const resumable = existing.status === "failed" ? Boolean(objective) : abandoned;
      if (!resumable) return { outcome: "in_progress", row: existing };

      const wasFailed = existing.status === "failed";
      existing.status = "pending";
      store.claimed += 1;
      return {
        outcome: "claimed",
        evaluationId: existing.id,
        objective: wasFailed ? objective : null,
        usedToday: countToday(),
        countedToday:
          dailyLimit !== null &&
          at(existing.createdAt) >= dayStart.getTime() &&
          at(existing.createdAt) < dayEnd.getTime(),
        resumed: true,
      };
    }

    // The CONCURRENCY reservation: live `pending` rows for this user (mirrors
    // the production countLivePending, read under the per-caller lock).
    const livePending = store.rows.filter(
      (row) =>
        row.userId === userId &&
        row.status === "pending" &&
        at(row.createdAt) > stalePendingBefore.getTime(),
    ).length;
    if (livePending >= MAX_CONCURRENT_EVALUATIONS_PER_USER) {
      return { outcome: "concurrency_limited", livePending };
    }

    const usedToday = countToday();
    if (dailyLimit !== null && (usedToday ?? 0) >= dailyLimit) {
      return { outcome: "limit_reached", usedToday: usedToday ?? 0 };
    }

    const row = {
      id: `row-${store.nextId}`,
      userId,
      gameKey,
      matchId,
      tier,
      status: "pending",
      // The claim marker: NOT a usable analysis, exactly like production.
      objectiveData: { pending: true },
      aiResponse: null,
      createdAt: now(),
    };
    store.nextId += 1;
    store.rows.push(row);
    store.inserts += 1;
    store.claimed += 1;
    return {
      outcome: "claimed",
      evaluationId: row.id,
      objective: null,
      usedToday: usedToday === null ? null : usedToday + 1,
      countedToday: dailyLimit !== null,
      resumed: false,
    };
  };

  const releaseEvaluation = (evaluationId) => {
    store.releases += 1;
    store.rows = store.rows.filter(
      (row) => !(row.id === evaluationId && row.status !== "complete"),
    );
  };

  const completeEvaluation = (evaluationId, result) => {
    const row = store.rows.find((candidate) => candidate.id === evaluationId);
    // Never replace a result the player already has.
    if (!row || row.status === "complete") return null;
    row.objectiveData = result.objectiveData;
    row.aiResponse = result.aiResponse;
    row.status = result.status;
    store.completions += 1;
    return { ...row };
  };

  // Attach the methods to the state object and return IT — never a spread,
  // which would copy `inserts`/`completions`/... by value and freeze every
  // counter at zero for the assertions below.
  store.claimEvaluation = claimEvaluation;
  store.releaseEvaluation = releaseEvaluation;
  store.completeEvaluation = completeEvaluation;
  return store;
}

/**
 * A fake dependency set that records every call, so "did this re-run the
 * engine?", "how many times was the model asked?" and "how many rows exist?"
 * are observable facts rather than assumptions.
 *
 * `rows` seeds the fake table; `deps` overrides individual dependencies.
 */
const FIXED_NOW = () => new Date("2026-01-01T12:00:00.000Z");

function makeDeps({ rows = [], deps: overrides = {} } = {}) {
  const calls = {
    evaluateMatch: 0,
    generateInsight: 0,
    isProMember: 0,
    rateLimit: 0,
  };

  const store = makeStore({ rows, now: FIXED_NOW });

  const deps = {
    now: FIXED_NOW,
    getUserAliases: async (userId) => [userId, "42"],
    loadMatch: async (matchId) => (matchId === MATCH ? matchRow() : null),
    isProMember: async () => {
      calls.isProMember += 1;
      return false;
    },
    consumeRequestRateLimit: async () => {
      calls.rateLimit += 1;
      return {
        allowed: true,
        limit: EVALUATION_RATE_LIMIT_MAX,
        remaining: EVALUATION_RATE_LIMIT_MAX - 1,
        resetAt: FIXED_NOW().getTime() + EVALUATION_RATE_LIMIT_WINDOW_MS,
      };
    },
    claimEvaluation: async (request) => store.claimEvaluation(request),
    releaseEvaluation: async (evaluationId) => store.releaseEvaluation(evaluationId),
    completeEvaluation: async (evaluationId, result) =>
      store.completeEvaluation(evaluationId, result),
    evaluateMatch: async (matchId) => {
      calls.evaluateMatch += 1;
      return objective(matchId);
    },
    generateInsight: async () => {
      calls.generateInsight += 1;
      return { success: true, data: { summary: "Generated analysis." } };
    },
    ...overrides,
  };

  return { deps, calls, store };
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
  const { deps, calls, store } = makeDeps();
  const result = await run(deps);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.code, "ok");
  assert.equal(result.tier, "free");
  assert.equal(result.cached, false);
  assert.equal(result.aiAvailable, true);
  assert.equal(result.insight.summary, "Generated analysis.");
  assert.equal(result.objective.sufficient, true);

  // The daily counter was consulted ONCE, inside the claim (a real COUNT in
  // production), one row was claimed, and it carries the tier it was generated
  // under.
  assert.equal(store.countedToday, 1);
  assert.equal(store.inserts, 1, "the claim wrote exactly one row");
  assert.equal(store.rows.length, 1, "and no second row exists");
  assert.equal(store.rows[0].tier, "free");
  assert.equal(store.rows[0].status, "complete");
  assert.deepEqual(result.limits, {
    tier: "free",
    dailyLimit: FREE_DAILY_EVALUATION_LIMIT,
    usedToday: 1,
    remaining: 0,
  });
});

test("free tier: a second match on the same day is refused with an upgrade message", async () => {
  const { deps, calls, store } = makeDeps({
    // Today's allowance is already spent — on ANOTHER match, so this match has
    // no row of its own and the limit is the reason it is refused.
    rows: [spentDayRow()],
    deps: { loadMatch: async (matchId) => matchRow({ id: matchId }) },
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

  // The limit is decided BEFORE any expensive work: no engine, no model, and no
  // row left behind.
  assert.equal(calls.evaluateMatch, 0, "the engine must not run for a refused request");
  assert.equal(calls.generateInsight, 0, "the model must not run for a refused request");
  assert.equal(store.inserts, 0, "a refused request writes nothing");
  assert.equal(store.rows.length, 1, "the day's existing row is untouched");
});

test("free tier: the count is per caller and bounded to the UTC day", async () => {
  // The service asks the DB for exactly [midnight UTC, next midnight UTC) for
  // THIS user id — so another account's evaluations, or yesterday's, cannot
  // consume the allowance and clearing client storage changes nothing.
  const windows = [];
  const { deps } = makeDeps({
    rows: [spentDayRow()],
    // Watch the window the CLAIM asks the database for.
    deps: {
      claimEvaluation: async (request) => {
        windows.push({ userId: request.userId, from: request.dayStart, to: request.dayEnd });
        return { outcome: "limit_reached", usedToday: 1 };
      },
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
  assert.match(SERVICE, /gte\(evaluationResults\.createdAt, dayStart\)/);
  assert.match(SERVICE, /lt\(evaluationResults\.createdAt, dayEnd\)/);
  assert.match(SERVICE, /eq\(evaluationResults\.userId, userId\)/);
  // …and the count happens INSIDE the claim transaction, serialised per caller
  // so two simultaneous requests cannot both see "0 used today".
  assert.match(SERVICE, /pg_advisory_xact_lock/);
  assert.match(SERVICE, /db\.transaction\(async \(tx\) => \{/);
  // The claim INSERT is what the unique index arbitrates — not a read-then-write.
  assert.match(SERVICE, /onConflictDoNothing\(\{/);
  assert.match(
    SERVICE,
    /target: \[\s*evaluationResults\.userId,\s*evaluationResults\.gameKey,\s*evaluationResults\.matchId,/,
  );
  // A completed result can never be overwritten, and a released claim can never
  // delete one.
  assert.match(SERVICE, /async completeEvaluation[\s\S]{0,400}ne\(evaluationResults\.status, "complete"\)/);
  assert.match(SERVICE, /async releaseEvaluation[\s\S]{0,400}ne\(evaluationResults\.status, "complete"\)/);
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
  const { deps, calls, store } = makeDeps({
    deps: {
      isProMember: async () => {
        calls.isProMember += 1;
        return true;
      },
      loadMatch: async (matchId) => matchRow({ id: matchId }),
    },
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

  assert.equal(store.inserts, 3, "all three were generated");
  assert.equal(store.rows.length, 3);
  assert.equal(store.countedToday, 0, "PRO never hits the daily counter");
  assert.ok(
    store.claimRequests.every((request) => request.dailyLimit === null),
    "PRO claims carry no daily limit, so they take neither the count nor the lock",
  );
});

test("pro tier: an unreadable membership lookup fails closed to FREE", async () => {
  const { deps } = makeDeps({
    // The day is spent, so a caller wrongly treated as PRO would get a 200
    // instead of the 429 that failing closed must produce.
    rows: [spentDayRow()],
    deps: {
      isProMember: async () => {
        throw new Error("stripe table unavailable");
      },
    },
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
  const { deps, calls, store } = makeDeps({
    deps: {
      loadMatch: async () =>
        matchRow({ playerWhiteId: "user_stranger", playerBlackId: "user_other_2" }),
    },
  });

  const result = await run(deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "not_a_participant");
  assert.match(result.message, /your own matches/i);
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.generateInsight, 0);
  assert.equal(store.inserts, 0);
  assert.equal(store.claimRequests.length, 0, "the key is never even claimed");
  // The caller's tier is not even resolved for a request that can never run.
  assert.equal(calls.isProMember, 0);
});

test("ownership: a legacy numeric id on the row still counts as the caller", async () => {
  // /api/chess/move accepts the numeric users.id for old rows; so does this.
  const { deps } = makeDeps({
    deps: {
      getUserAliases: async (userId) => [userId, "42"],
      loadMatch: async () => matchRow({ playerWhiteId: "42", playerBlackId: OTHER }),
    },
  });

  const result = await run(deps);
  assert.equal(result.ok, true, "the alias must be accepted as ownership");
});

test("finished state: an in-progress or expired match is refused", async () => {
  for (const status of ["in_progress", "waiting", "expired", "active"]) {
    const { deps, calls } = makeDeps({
      deps: { loadMatch: async () => matchRow({ status }) },
    });
    const result = await run(deps);
    assert.equal(result.ok, false, `${status} must be refused`);
    assert.equal(result.status, 409);
    assert.equal(result.code, "match_not_finished");
    assert.equal(calls.evaluateMatch, 0);
  }
});

test("a match that does not exist is a 404 and never touches Postgres", async () => {
  const { deps } = makeDeps({ deps: { loadMatch: async () => null } });
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
  const { deps, calls, store } = makeDeps({
    // The stored evaluation for THIS match, plus a spent day: the row must win.
    rows: [storedRow(), spentDayRow()],
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
  assert.equal(store.inserts, 0, "no work, no new row");
  // The count is read to REPORT current usage (the usage panel), not to charge
  // for it — the cache hit still outranks the limit decision.
  assert.equal(store.countedToday, 1, "the count is consulted to report usage");
  assert.equal(result.limits.tier, "free");
  assert.equal(result.limits.dailyLimit, FREE_DAILY_EVALUATION_LIMIT);
  assert.equal(result.limits.remaining, 0, "today's allowance is spent");
});

test("caching: a stored FAILED evaluation retries the model on the SAME row", async () => {
  const { deps, calls, store } = makeDeps({
    rows: [storedRow({ status: "failed", aiResponse: null })],
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
  assert.equal(store.completions, 1, "the retry lands on the SAME row");
  assert.equal(store.inserts, 0, "no second row is created");
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].id, "row-1", "the row is reused, not replaced");
  assert.equal(store.rows[0].status, "complete");
});

test("caching: a stored row whose analysis is missing degrades instead of crashing", async () => {
  const { deps, calls, store } = makeDeps({
    rows: [storedRow({ status: "failed", aiResponse: null })],
    deps: { generateInsight: async () => ({ success: false, error: "groq 503" }) },
  });

  const result = await run(deps);
  assert.equal(result.ok, true, "the stored stats are still returned");
  assert.equal(result.aiAvailable, false);
  assert.equal(result.insight, null);
  assert.equal(result.message, AI_UNAVAILABLE_MESSAGE);
  assert.equal(store.completions, 1, "the row is rewritten, still exactly one row");
  assert.equal(store.rows.length, 1);
});

// ════════════════════════════════════════════════════════════════════
// 5. LLM failure degrades — the user still sees their real stats
// ════════════════════════════════════════════════════════════════════

test("LLM outage: the objective evaluation is still returned with a fallback message", async () => {
  const { deps, store } = makeDeps({
    deps: {
      generateInsight: async () => ({ success: false, error: "Groq returned HTTP 503" }),
    },
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
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].status, "failed");
  assert.equal(store.rows[0].aiResponse, null);
});

test("LLM outage: a provider that throws is handled the same way", async () => {
  const { deps } = makeDeps({
    deps: {
      generateInsight: async () => {
        throw new Error("fetch failed");
      },
    },
  });

  const result = await run(deps);
  assert.equal(result.ok, true);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.message, AI_UNAVAILABLE_MESSAGE);
});

test("LLM outage: an answer without a usable summary is discarded, not persisted", async () => {
  const { deps, store } = makeDeps({
    deps: {
      generateInsight: async () => ({ success: true, data: { strengths: ["nice"] } }),
    },
  });

  const result = await run(deps);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.insight, null);
  assert.equal(store.rows[0].status, "failed");
});

// ════════════════════════════════════════════════════════════════════
// 6. Insufficient data — flagged, and never charged against the allowance
// ════════════════════════════════════════════════════════════════════

test("insufficient data: 422 with the reason, no row, allowance untouched", async () => {
  const { deps, calls, store } = makeDeps({
    deps: { evaluateMatch: async (matchId) => objective(matchId, { sufficient: false }) },
  });

  const result = await run(deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.code, "insufficient_data");
  assert.match(result.message, /too short to evaluate/i);
  // The message must count the same unit the eligibility gate counts (plies),
  // and say what that is in full moves too rather than calling plies "moves".
  assert.match(result.message, /only 2 plies \(1 move\) were played/);
  assert.match(result.message, /At least 5 plies are needed/);
  assert.equal(result.objective.sufficient, false, "the client gets the reason");
  assert.deepEqual(result.limits, {
    tier: "free",
    dailyLimit: 1,
    usedToday: 0,
    remaining: 1,
  });

  assert.equal(calls.generateInsight, 0, "no model call for an unevaluatable match");
  // The claim row IS written before the engine runs — but it is released again
  // when the match turns out to be unevaluatable, so nothing is left behind and
  // nothing is consumed.
  assert.equal(store.inserts, 1, "the claim was taken before the engine ran");
  assert.equal(store.releases, 1, "and released once the match was refused");
  assert.equal(store.rows.length, 0, "a refused match leaves no row behind");
});

// ════════════════════════════════════════════════════════════════════
// 6b. The request budget — the engine is a bounded slice of the route limit
// ════════════════════════════════════════════════════════════════════

test("the engine budget is a bounded slice of the route's function limit", () => {
  assert.match(ROUTE, /export const maxDuration = 60/);
  assert.equal(ROUTE_MAX_DURATION_MS, 60_000);
  // The engine budget is STRICTLY less than the function limit: it must leave
  // room for boot, persistence and the optional AI call. (The audit's failure
  // mode was a budget that ignored everything else in the request.)
  assert.ok(
    EVALUATION_ENGINE_TIME_BUDGET_MS < ROUTE_MAX_DURATION_MS,
    "the engine must not consume the whole function limit",
  );
  assert.equal(EVALUATION_ENGINE_TIME_BUDGET_MS, 30_000);
  // Every slice is accounted for and exactly fills the limit, so no step of the
  // request is unbudgeted.
  assert.equal(
    EVALUATION_ENGINE_TIME_BUDGET_MS +
      EVALUATION_SAFETY_MARGIN_MS +
      ENGINE_BOOT_RESERVE_MS +
      AI_INSIGHT_RESERVE_MS +
      EVALUATION_PERSISTENCE_RESERVE_MS,
    ROUTE_MAX_DURATION_MS,
  );
  // The AI slice covers the service's backstop, which itself must be no larger
  // than the reserved slice.
  assert.ok(AI_INSIGHT_RESERVE_MS >= AI_INSIGHT_TIMEOUT_MS);
  // The service passes the bounded options explicitly rather than relying on the
  // evaluator's own (pre-AI) default.
  assert.deepEqual(EVALUATION_ANALYSIS_OPTIONS, {
    timeBudgetMs: EVALUATION_ENGINE_TIME_BUDGET_MS,
  });
  // The game key is passed last so the evaluator registry can dispatch, while
  // the existing test doubles that only read `matchId` keep working.
  assert.match(
    SERVICE,
    /deps\.evaluateMatch\(\s*matchId,\s*EVALUATION_ANALYSIS_OPTIONS,\s*gameKey,\s*\)/,
  );
});

test("the AI insight call is bounded: a provider that never answers still returns the stats", async () => {
  // A provider that NEVER resolves must not stall the request. The timeout turns
  // it into the AI-unavailable fallback while the objective stats survive — the
  // whole point of AI being optional. (insightTimeoutMs keeps the test fast; the
  // production default is AI_INSIGHT_TIMEOUT_MS.)
  const { deps, store } = makeDeps({
    deps: {
      insightTimeoutMs: 25,
      generateInsight: () => new Promise(() => {}),
    },
  });

  const result = await run(deps);
  assert.equal(result.ok, true, "the request must resolve, not hang");
  assert.equal(result.status, 200);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.insight, null);
  assert.equal(result.message, AI_UNAVAILABLE_MESSAGE);
  assert.equal(result.objective.sufficient, true, "the objective stats survive the timeout");
  assert.ok(result.objective.moves.length > 0);
  // The row is kept `failed`, so the model can be retried without re-running the
  // engine — exactly the existing retry semantics.
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].status, "failed");
});

// ════════════════════════════════════════════════════════════════════
// 6c. Cached vs fresh responses — one shape, current limits
// ════════════════════════════════════════════════════════════════════

test("fresh and cached responses share one shape, and cached limits are current", async () => {
  const { deps, calls, store } = makeDeps();

  const fresh = await run(deps);
  assert.equal(fresh.code, "ok");
  assert.equal(fresh.cached, false);

  const cached = await run(deps);
  assert.equal(cached.code, "cached");
  assert.equal(cached.cached, true);

  // The RELEVANT fields must agree between a fresh response and a cached one —
  // that is the panel the audit found vanishing when a report was reopened.
  for (const field of ["tier", "aiAvailable", "limits"]) {
    assert.deepEqual(
      cached[field],
      fresh[field],
      `${field} must match across the fresh and cached responses`,
    );
  }
  assert.deepEqual(cached.limits, {
    tier: "free",
    dailyLimit: FREE_DAILY_EVALUATION_LIMIT,
    usedToday: 1,
    remaining: 0,
  });
  assert.equal(cached.objective.sufficient, fresh.objective.sufficient);
  assert.equal(cached.insight.summary, fresh.insight.summary);

  // …and the cached response still did no work.
  assert.equal(store.rows.length, 1);
  assert.equal(calls.evaluateMatch, 1, "one engine run across both requests");
  assert.equal(calls.generateInsight, 1, "one model call across both requests");
});

test("cached limits use the caller's CURRENT tier, not the tier stored on the row", async () => {
  // The row was generated under Free; the caller is PRO today. Replaying the
  // stored tier would show them a Free allowance panel; the current tier must win.
  const { deps } = makeDeps({
    rows: [storedRow({ tier: "free" })],
    deps: { isProMember: async () => true },
  });

  const cached = await run(deps);
  assert.equal(cached.code, "cached");
  assert.equal(cached.tier, "pro");
  assert.deepEqual(cached.limits, {
    tier: "pro",
    dailyLimit: null,
    usedToday: 0,
    remaining: null,
  });
});

// ════════════════════════════════════════════════════════════════════
// 6d. Server failures map to 5xx, never to the client's 422
// ════════════════════════════════════════════════════════════════════

test("server-side evaluation failures map to their own status classes", async () => {
  const cases = [
    { reason: "database_error", status: 500, code: "database_error" },
    { reason: "engine_unavailable", status: 503, code: "engine_unavailable" },
    { reason: "time_budget_exceeded", status: 503, code: "analysis_budget_exceeded" },
    { reason: "game_not_found", status: 404, code: "match_not_found" },
  ];

  for (const { reason, status, code } of cases) {
    const { deps, store } = makeDeps({
      deps: {
        evaluateMatch: async (matchId) => ({
          gameId: matchId,
          sufficient: false,
          reason,
          // A deliberately leaky detail: none of it may reach the response.
          detail: `internal ${reason}: relation "chess_moves" does not exist (SQLSTATE 42P01)`,
          moveCount: 0,
          plyCount: 0,
        }),
      },
    });

    const result = await run(deps);
    assert.equal(result.status, status, `${reason} must map to ${status}`);
    assert.equal(result.code, code);
    // No internal detail, and no objective payload, on a server-side failure.
    assert.equal(result.objective, null, `${reason} must not expose the objective`);
    assert.doesNotMatch(result.message, /relation|chess_moves|does not exist|SQLSTATE/i);
    // Released: no row left behind and nothing consumed from the allowance.
    assert.equal(store.rows.length, 0);
    assert.equal(store.releases, 1);
    assert.equal(result.limits.usedToday, 0);
  }
});

test("the route exposes the objective only on the client-explainable 422", () => {
  assert.match(
    ROUTE,
    /objective: result\.status === 422 \? result\.objective : undefined/,
    "a 5xx must not echo the evaluator's internal detail",
  );
});

// ════════════════════════════════════════════════════════════════════
// 6e. Request throttling — per-user rate + concurrency, separate from the award
// ════════════════════════════════════════════════════════════════════

test("rate limit: a caller over the request budget is refused with a 429 before any work", async () => {
  const { deps, calls, store } = makeDeps({
    deps: {
      consumeRequestRateLimit: async () => ({
        allowed: false,
        limit: EVALUATION_RATE_LIMIT_MAX,
        remaining: 0,
        resetAt: FIXED_NOW().getTime() + 12_000,
      }),
    },
  });

  const result = await run(deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.code, "rate_limited");
  assert.equal(result.message, RATE_LIMITED_MESSAGE);
  assert.equal(result.retryAfterMs, 12_000, "the route turns this into Retry-After");

  // Nothing expensive ran, and the request never reached the claim: no engine,
  // no model, no row, and no daily-allowance read.
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.generateInsight, 0);
  assert.equal(store.claimRequests.length, 0, "a throttled request never claims");
  assert.equal(result.limits, null, "throttling is not the daily allowance");
});

test("rate limit: a legitimate retry after a transient error is allowed", async () => {
  // The throttle allows requests, and a transient engine failure RELEASES its
  // claim, so the retry is blocked neither by the concurrency cap nor by the
  // daily allowance (nothing lingers). This is the "avoid blocking a retry" rule.
  let attempt = 0;
  const { deps, calls, store } = makeDeps({
    deps: {
      evaluateMatch: async (matchId) => {
        calls.evaluateMatch += 1;
        attempt += 1;
        return attempt === 1
          ? {
              gameId: matchId,
              sufficient: false,
              reason: "engine_unavailable",
              detail: "engine down",
              moveCount: 0,
              plyCount: 0,
            }
          : objective(matchId);
      },
    },
  });

  const failed = await run(deps);
  assert.equal(failed.status, 503, "a transient engine failure is a retry state");
  assert.equal(store.rows.length, 0, "the claim was released, so nothing is held");

  const retried = await run(deps);
  assert.equal(retried.ok, true, "the retry must be allowed and succeed");
  assert.equal(retried.code, "ok");
  assert.equal(store.rows.length, 1);
  // The throttle was consulted on both requests and allowed both.
  assert.equal(calls.rateLimit, 2);
});

test("concurrency limit: a new analysis is refused while the cap is in flight", async () => {
  // Two live claims already in flight for this caller.
  const { deps, calls, store } = makeDeps({
    rows: [
      storedPendingRow({ matchId: MATCH }),
      storedPendingRow({ matchId: MATCH_2 }),
    ],
    deps: { loadMatch: async (matchId) => matchRow({ id: matchId }) },
  });

  const result = await run(deps, { matchId: MATCH_3 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.code, "concurrency_limit_reached");
  assert.equal(result.message, CONCURRENCY_LIMITED_MESSAGE);
  assert.equal(result.retryAfterMs, EVALUATION_CONCURRENCY_RETRY_AFTER_MS);
  assert.equal(calls.evaluateMatch, 0, "no engine run while at the cap");
  assert.equal(store.inserts, 0, "and no new row");
  assert.equal(MAX_CONCURRENT_EVALUATIONS_PER_USER, 2);
});

test("concurrency limit: a duplicate request is answered from its own row, not a new analysis", async () => {
  // At the cap, a request for a match that ALREADY has a live claim gets 409
  // in_progress — its own row — not a second analysis. A duplicate therefore
  // CANNOT bypass the cap by arriving as "new".
  const { deps, calls, store } = makeDeps({
    rows: [
      storedPendingRow({ matchId: MATCH }),
      storedPendingRow({ matchId: MATCH_2 }),
    ],
  });

  const dup = await run(deps, { matchId: MATCH });
  assert.equal(dup.status, 409);
  assert.equal(dup.code, "evaluation_in_progress");
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(store.inserts, 0);
  assert.equal(store.rows.length, 2, "the two in-flight rows are untouched");
});

test("free-test switch: enabled by default, and disabling it blocks Free but not PRO", async () => {
  const previous = process.env.EVALUATION_FREE_ACCESS;
  try {
    // ── Default: no env var → Free access ENABLED ─────────────────────
    delete process.env.EVALUATION_FREE_ACCESS;
    assert.equal(freeEvaluationAccessEnabled(), true, "the switch defaults to enabled");

    const onDeps = makeDeps();
    const allowed = await run(onDeps.deps);
    assert.equal(allowed.ok, true, "an eligible Free user can request a chess evaluation");
    assert.equal(allowed.tier, "free");
    assert.equal(allowed.code, "ok");
    assert.equal(allowed.limits.usedToday, 1, "it spends exactly one allowance");

    // Any value other than "false" keeps it on.
    process.env.EVALUATION_FREE_ACCESS = "true";
    assert.equal(freeEvaluationAccessEnabled(), true);

    // ── Switch OFF: Free refused with the existing 429 upsell ─────────
    process.env.EVALUATION_FREE_ACCESS = "false";
    assert.equal(freeEvaluationAccessEnabled(), false);

    const { deps, calls, store } = makeDeps();
    const blocked = await run(deps);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.code, "daily_limit_reached");
    assert.equal(blocked.message, FREE_LIMIT_REACHED_MESSAGE);
    // Refused before any expensive work — no engine, no model, no claim.
    assert.equal(calls.evaluateMatch, 0);
    assert.equal(calls.generateInsight, 0);
    assert.equal(store.claimRequests.length, 0, "no claim is even attempted");

    // ── PRO is NOT affected by the switch ─────────────────────────────
    const proDeps = makeDeps({ deps: { isProMember: async () => true } });
    const pro = await run(proDeps.deps);
    assert.equal(pro.ok, true, "PRO keeps working with the switch off");
    assert.equal(pro.tier, "pro");
    assert.equal(pro.limits.dailyLimit, null);
  } finally {
    if (previous === undefined) delete process.env.EVALUATION_FREE_ACCESS;
    else process.env.EVALUATION_FREE_ACCESS = previous;
  }
});

test("missing AI configuration degrades gracefully — no key, no network, no throw", async () => {
  // An explicitly empty key is exactly the unconfigured path. It must resolve to
  // a clean failure (the service then returns the objective stats), never throw
  // and never make a request.
  const provider = new GroqProvider("");
  const result = await provider.generateEvaluation("irrelevant", { type: "object" });
  assert.equal(result.success, false);
  assert.match(result.error, /not configured/i);
  // The error names the VARIABLE, never its value.
  assert.doesNotMatch(result.error, /Bearer|sk-|gsk_/i);
});

test("the throttle is per-user, uses the existing durable limiter, and precedes the DB read", () => {
  assert.equal(EVALUATION_RATE_LIMIT_MAX, 10);
  assert.equal(EVALUATION_RATE_LIMIT_WINDOW_MS, 60_000);
  // The project's EXISTING limiter (Redis REST when configured), not a new one.
  assert.match(SERVICE, /import \{ consumeRateLimit \} from "\.\.\/security\/rateLimit"/);
  assert.match(SERVICE, /consumeRateLimit\(`evaluation:\$\{userId\}`/);
  // The CONCURRENCY cap is database-backed (the live-`pending` count), so it
  // holds across serverless instances even when Redis is not configured.
  assert.match(SERVICE, /countLivePending/);
  assert.match(SERVICE, /eq\(evaluationResults\.status, "pending"\)/);
  // Throttling happens before any match read / claim.
  const throttleAt = SERVICE.indexOf("consumeRequestRateLimit(userId)");
  const loadAt = SERVICE.indexOf("deps.loadMatch(matchId)");
  assert.ok(throttleAt > 0 && loadAt > throttleAt, "throttle must precede the match read");
  // The route documents the 429 with a Retry-After.
  assert.match(ROUTE, /"Retry-After":/);
  assert.match(ROUTE, /result\.retryAfterMs/);
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
  // Adding a game means registering an analyzer adapter, not a new route.
  // Eligibility is derived from the registry; the direct lobby-key test is gone
  // so a game cannot become evaluatable merely by existing in the lobby.
  assert.match(SERVICE, /SUPPORTED_EVALUATION_GAMES: string\[\] = getSupportedEvaluationGames\(\)/);
  assert.match(SERVICE, /if \(!isEvaluationSupported\(gameKey\)\)/);
  // The provider is behind the LLMProvider interface, so it is swappable.
  assert.match(SERVICE, /groqProvider\.generateEvaluation\(prompt, schema\)/);
  assert.match(SERVICE, /import \{ groqProvider \} from "\.\/providers\/groqProvider"/);
});
// ════════════════════════════════════════════════════════════════════
// 7. Concurrency — the claim, not a read-then-write
// ════════════════════════════════════════════════════════════════════
//
// Before the claim, the service read the row, did the work and then inserted:
// two overlapping requests both missed the lookup and both paid for the whole
// thing (Stockfish plus the model), and a Free caller could spend the
// one-per-day allowance twice. These tests drive TWO overlapping runs against
// one fake table, so "the second request ran no engine and no model call" is an
// observed fact.
//
// What CANNOT be proven here is the database half — that the unique index and
// the per-caller advisory lock really serialise two serverless instances. That
// needs a live Postgres, so the last test asserts the migration, the journal
// entry, the schema declaration and the SQL primitives instead, and the gap is
// called out in the report.

/** A promise plus its resolver, for parking one request inside "the engine". */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("concurrency: two simultaneous requests for one match run the engine ONCE", async () => {
  const engine = gate();
  let engineEntered;
  const engineStarted = new Promise((resolve) => {
    engineEntered = resolve;
  });

  const { deps, calls, store } = makeDeps({
    deps: {
      evaluateMatch: async (matchId) => {
        calls.evaluateMatch += 1;
        engineEntered();
        await engine.promise;
        return objective(matchId);
      },
    },
  });

  const first = run(deps); // takes the claim, then parks inside the engine
  await engineStarted;

  // A second request for the SAME match arrives mid-analysis.
  const second = await run(deps);

  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.code, "evaluation_in_progress");
  assert.equal(second.cached, false);
  assert.match(second.message, /already being analysed/i);
  assert.equal(calls.evaluateMatch, 1, "the second request must NOT run the engine");
  assert.equal(calls.generateInsight, 0, "nor ask the model");
  assert.equal(store.inserts, 1, "nor write a second row");
  assert.equal(store.rows.length, 1);

  engine.open();
  const winner = await first;
  assert.equal(winner.ok, true);
  assert.equal(winner.code, "ok");
  assert.equal(winner.cached, false);
  assert.equal(winner.aiAvailable, true);
  assert.equal(winner.insight.summary, "Generated analysis.");
  assert.equal(store.rows.length, 1, "exactly one row for the match");
  assert.equal(store.rows[0].status, "complete");
  assert.equal(calls.generateInsight, 1, "one model call for the match");

  // And a retry after it finishes is served from the stored row — no work at all.
  const retry = await run(deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.code, "cached");
  assert.equal(retry.cached, true);
  assert.equal(retry.evaluationId, store.rows[0].id);
  assert.equal(calls.evaluateMatch, 1, "still one engine run for the match");
  assert.equal(calls.generateInsight, 1, "still one model call for the match");
  assert.equal(store.rows.length, 1);
});

test("concurrency: one Free caller cannot spend the daily allowance twice", async () => {
  const engine = gate();
  const { deps, calls, store } = makeDeps({
    deps: {
      loadMatch: async (matchId) => matchRow({ id: matchId }),
      evaluateMatch: async (matchId) => {
        calls.evaluateMatch += 1;
        await engine.promise;
        return objective(matchId);
      },
    },
  });

  // Two DIFFERENT matches, one caller, one allowance, both requests in flight.
  const first = run(deps, { matchId: MATCH });
  const second = run(deps, { matchId: MATCH_2 });

  const refused = await second;
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.code, "daily_limit_reached");
  assert.equal(
    refused.limits.usedToday,
    1,
    "the in-flight claim counts as today's evaluation",
  );
  assert.equal(refused.limits.remaining, 0);
  assert.equal(refused.limits.tier, "free");

  engine.open();
  const winner = await first;
  assert.equal(winner.ok, true);
  assert.equal(winner.limits.usedToday, 1);
  assert.equal(winner.limits.remaining, 0);

  assert.equal(
    calls.evaluateMatch,
    1,
    "the limit was enforced against the first claim, so only one engine run happened",
  );
  assert.equal(calls.generateInsight, 1);
  assert.equal(store.inserts, 1);
  assert.equal(store.rows.length, 1);
});

test("concurrency: two requests for an already-evaluated match both get the stored result", async () => {
  const { deps, calls, store } = makeDeps({ rows: [storedRow()] });

  const [a, b] = await Promise.all([run(deps), run(deps)]);

  for (const result of [a, b]) {
    assert.equal(result.ok, true);
    assert.equal(result.code, "cached");
    assert.equal(result.cached, true);
    assert.equal(result.evaluationId, "row-1");
    assert.equal(result.insight.summary, "A short, even game.");
  }
  assert.equal(calls.evaluateMatch, 0, "no engine");
  assert.equal(calls.generateInsight, 0, "no model");
  assert.equal(store.inserts, 0, "no row");
  assert.equal(store.completions, 0, "and nothing rewritten");
  assert.equal(store.rows.length, 1);
});

test("concurrency: a failed evaluation stays retryable on the SAME row", async () => {
  let modelCalls = 0;
  const { deps, calls, store } = makeDeps({
    rows: [storedRow({ status: "failed", aiResponse: null })],
    deps: {
      generateInsight: async () => {
        calls.generateInsight += 1;
        modelCalls += 1;
        // First retry fails again; the second succeeds. The row must survive a
        // second failure rather than being replaced by a new one.
        return modelCalls === 1
          ? { success: false, error: "groq 503" }
          : { success: true, data: { summary: "Retried analysis." } };
      },
    },
  });

  const first = await run(deps);
  assert.equal(first.ok, true);
  assert.equal(first.code, "cached", "a resumed row keeps the existing response shape");
  assert.equal(first.aiAvailable, false);
  assert.equal(store.rows.length, 1, "still exactly one row");
  assert.equal(store.rows[0].status, "failed", "still retryable");
  assert.equal(store.inserts, 0);
  assert.equal(calls.evaluateMatch, 0, "the engine work is never re-run");

  const second = await run(deps);
  assert.equal(second.ok, true);
  assert.equal(second.aiAvailable, true);
  assert.equal(second.insight.summary, "Retried analysis.");
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].id, "row-1", "the SAME row, not a second one");
  assert.equal(store.rows[0].status, "complete");
  assert.equal(store.inserts, 0);
  assert.equal(calls.evaluateMatch, 0);
});

test("concurrency: an abandoned claim is taken over; a live one is not", async () => {
  // A claim left `pending` by a request that died — older than the lease.
  const { deps, calls, store } = makeDeps({
    rows: [
      storedRow({
        status: "pending",
        objectiveData: { pending: true },
        aiResponse: null,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
      }),
    ],
  });

  const resumed = await run(deps);
  assert.equal(resumed.ok, true, "a dead claim must not wedge the match forever");
  assert.equal(resumed.cached, true, "the resumed row keeps the existing response shape");
  assert.equal(calls.evaluateMatch, 1, "the engine runs: the dead claim stored no stats");
  assert.equal(store.inserts, 0, "no second row");
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].status, "complete");

  // The same row, one minute old, is a LIVE claim and must be refused.
  const { deps: liveDeps, calls: liveCalls, store: liveStore } = makeDeps({
    rows: [
      storedRow({
        status: "pending",
        objectiveData: { pending: true },
        aiResponse: null,
        createdAt: new Date("2026-01-01T11:59:00.000Z"),
      }),
    ],
  });

  const refused = await run(liveDeps);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "evaluation_in_progress");
  assert.equal(liveCalls.evaluateMatch, 0, "a live claim must never be duplicated");
  assert.equal(liveCalls.generateInsight, 0);
  assert.equal(liveStore.completions, 0, "and its row must be left alone");

  // Abandonment is decided by the lease, not by guessing.
  assert.equal(
    new Date("2026-01-01T12:00:00.000Z").getTime() -
      liveStore.claimRequests[0].stalePendingBefore.getTime(),
    EVALUATION_CLAIM_LEASE_MS,
    "the claim is told how old a pending row must be to count as abandoned",
  );
});

test("concurrency: a refused match releases its claim, so the allowance survives", async () => {
  let refuse = true;
  let engineRuns = 0;
  const { deps, store } = makeDeps({
    deps: {
      loadMatch: async (matchId) => matchRow({ id: matchId }),
      evaluateMatch: async (matchId) => {
        engineRuns += 1;
        return refuse ? objective(matchId, { sufficient: false }) : objective(matchId);
      },
    },
  });

  const refused = await run(deps, { matchId: MATCH });
  assert.equal(refused.status, 422);
  assert.equal(refused.code, "insufficient_data");
  assert.equal(store.rows.length, 0, "the claim is released, not left behind");
  assert.equal(store.releases, 1);
  assert.deepEqual(refused.limits, {
    tier: "free",
    dailyLimit: FREE_DAILY_EVALUATION_LIMIT,
    usedToday: 0,
    remaining: 1,
  });

  // The allowance really is intact: another match still evaluates today.
  refuse = false;
  const allowed = await run(deps, { matchId: MATCH_2 });
  assert.equal(allowed.ok, true, "the refused match consumed nothing");
  assert.equal(allowed.limits.usedToday, 1);
  assert.equal(store.rows.length, 1);
  assert.equal(engineRuns, 2, "the engine ran for each attempt");
});

test("the claim's guarantees are database-level, and the migration is safe", () => {
  // ── The uniqueness key ──────────────────────────────────────────────
  const migration = read("src/db/migrations/0210_evaluation_results_unique_key.sql");
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const schema = read("src/db/schema.ts");

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_results_user_game_match_idx"/,
    "the key must be a UNIQUE index — a plain one allows the duplicates this exists to stop",
  );
  assert.match(migration, /ON "evaluation_results" \("user_id", "game_key", "match_id"\)/);
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0210_evaluation_results_unique_key"),
    "an unjournaled migration is never executed by the migrator",
  );
  assert.match(
    schema,
    /uniqueIndex\("evaluation_results_user_game_match_idx"\)\.on\(\s*table\.userId,\s*table\.gameKey,\s*table\.matchId,/,
    "the schema must declare the same key drizzle's ON CONFLICT targets",
  );

  // ── The migration must fail loudly and delete NOTHING ───────────────
  assert.match(migration, /RAISE EXCEPTION/, "duplicates must abort the migration");
  assert.match(migration, /duplicated_keys > 0/, "…after checking for them");
  // Nothing destructive: no DELETE/TRUNCATE/DROP TABLE anywhere, and the cleanup
  // query in the header is a read-only SELECT left for a human to run.
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i, "no statement may delete rows");
  assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  assert.doesNotMatch(migration, /\bDROP TABLE\b/i);
  assert.doesNotMatch(migration, /^\s*(DELETE|UPDATE|TRUNCATE)\b/im);
  assert.match(migration, /SELECT user_id, game_key, match_id, count\(\*\) AS rows/, "the cleanup query is a SELECT, not an action");
  assert.match(
    migration,
    /DROP INDEX IF EXISTS "evaluation_results_user_game_match_idx"/,
    "the rollback must be documented and lossless",
  );

  // ── Cross-instance coordination is the DATABASE's ───────────────────
  // A process-local mutex protects nothing when two serverless instances run at
  // once, so the claim uses a transaction-scoped advisory lock (already the
  // pattern in src/lib/barricade/serverStore.ts) plus the unique index above.
  assert.match(SERVICE, /pg_advisory_xact_lock/);
  assert.match(SERVICE, /onConflictDoNothing\(\{/);
  assert.match(SERVICE, /\.for\("update"\)/);
  // …and no in-process lock is standing in for it. A module-level `let …Lock`
  // (or an engine-style queue) would serialise nothing across two serverless
  // instances, which is precisely the failure this batch fixes.
  assert.doesNotMatch(
    SERVICE,
    /^let\s+\w*(lock|queue|mutex)\w*\s*=/im,
    "the coordination must not be a process-local mutex",
  );
  assert.doesNotMatch(SERVICE, /enqueueSearch|searchQueue/);
  assert.match(SERVICE, /export const EVALUATION_CLAIM_LEASE_MS/);
  assert.match(SERVICE, /export function evaluationLockKey/);
  assert.match(SERVICE, /export const EVALUATION_IN_PROGRESS_MESSAGE/);
});

// ════════════════════════════════════════════════════════════════════
// 9. Tic-Tac-Toe — a second game through the SAME service
// ════════════════════════════════════════════════════════════════════
//
// Tic-Tac-Toe is registered in the analyzer registry, so it reaches the same
// authorization, entitlement, throttling, claim/idempotency and persistence
// path chess uses. `evaluateMatch` is faked here so these tests observe the
// SERVICE contract; the evaluator itself is covered by
// tests/tic-tac-toe-evaluator.test.mjs.

/** A minimal but valid complete GameReportV1 for Tic-Tac-Toe. */
function tttReport(matchId, overrides = {}) {
  return {
    schemaVersion: 1,
    gameKey: "tic-tac-toe",
    analysisType: "exact",
    status: "complete",
    match: {
      matchId,
      result: "player1",
      finishedAt: "2026-01-01T00:00:00.000Z",
      participants: [ME, OTHER],
    },
    metrics: [
      { key: "moveCount", label: "Moves played", unit: "count", available: true, value: 5 },
    ],
    players: [],
    moves: [],
    keyMoments: [],
    engine: null,
    ai: null,
    unavailableReason: null,
    ...overrides,
  };
}

/** An `unavailable` GameReportV1 carrying only its machine reason. */
function tttUnavailable(matchId, reason) {
  return {
    schemaVersion: 1,
    gameKey: "tic-tac-toe",
    analysisType: "exact",
    status: "unavailable",
    match: { matchId },
    metrics: [],
    unavailableReason: reason,
  };
}

/** The shared loader's shape for a Tic-Tac-Toe row (seat 1 = X, seat 2 = O). */
function tttMatch(overrides = {}) {
  return {
    id: MATCH,
    playerWhiteId: ME,
    playerBlackId: OTHER,
    status: "finished",
    result: "player1",
    gameKey: "tic-tac-toe",
    ...overrides,
  };
}

/**
 * Fake deps for a Tic-Tac-Toe run. The evaluator override records its own call
 * count (`state.evaluateCalls`), because overriding `evaluateMatch` bypasses
 * the default dep's counter.
 */
function makeTttDeps({ match = tttMatch(), report = (id) => tttReport(id) } = {}) {
  const state = { evaluateCalls: 0 };
  const { deps, store } = makeDeps({
    deps: {
      loadMatch: async () => match,
      evaluateMatch: async (matchId) => {
        state.evaluateCalls += 1;
        return report(matchId);
      },
      generateInsight: async () => {
        throw new Error("the model must never be called for tic-tac-toe");
      },
    },
  });
  return { deps, store, state };
}

const runTtt = (deps, input = {}) =>
  runEvaluation(
    { userId: ME, gameKey: "tic-tac-toe", matchId: MATCH, ...input },
    deps,
  );

test("tic-tac-toe: a finished match is evaluated and its report persisted", async () => {
  const { deps, store, state } = makeTttDeps();

  const result = await runTtt(deps);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.gameKey, "tic-tac-toe");
  assert.equal(result.objective.gameKey, "tic-tac-toe");
  assert.equal(result.objective.analysisType, "exact");
  assert.equal(result.insight, null);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.message, null, "no AI was attempted, so no failure message");
  assert.equal(state.evaluateCalls, 1);

  const row = store.rows.find((candidate) => candidate.gameKey === "tic-tac-toe");
  assert.ok(row, "the report must be persisted under its own game key");
  assert.equal(row.status, "complete", "no AI to retry, so the row is complete");
  assert.equal(row.objectiveData.gameKey, "tic-tac-toe");
});

test("tic-tac-toe: a second request is served from the stored report, not re-analysed", async () => {
  const { deps, state } = makeTttDeps();

  const first = await runTtt(deps);
  const second = await runTtt(deps);

  assert.equal(first.cached, false);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(state.evaluateCalls, 1, "the cached hit must not re-run the evaluator");
});

test("tic-tac-toe: only a participant may evaluate the match", async () => {
  const { deps, state } = makeTttDeps({
    match: tttMatch({ playerWhiteId: OTHER, playerBlackId: "user_third" }),
  });
  const result = await runTtt(deps);
  assert.equal(result.status, 403);
  assert.equal(result.code, "not_a_participant");
  assert.equal(state.evaluateCalls, 0);
});

test("tic-tac-toe: an unfinished match is refused before any work", async () => {
  const { deps, state } = makeTttDeps({ match: tttMatch({ status: "playing" }) });
  const result = await runTtt(deps);
  assert.equal(result.status, 409);
  assert.equal(result.code, "match_not_finished");
  assert.equal(state.evaluateCalls, 0);
});

test("a match id from another game is answered as not-found, not evaluated", async () => {
  const { deps, state } = makeTttDeps({ match: tttMatch({ gameKey: "chess" }) });
  const result = await runTtt(deps);
  assert.equal(result.status, 404);
  assert.equal(result.code, "match_not_found");
  assert.equal(state.evaluateCalls, 0);
});

test("tic-tac-toe: an expanded match reports 422 with a reason and spends nothing", async () => {
  const { deps, store, state } = makeTttDeps({
    report: (matchId) => tttUnavailable(matchId, "not_exactly_evaluable"),
  });
  const result = await runTtt(deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.code, "insufficient_data");
  assert.match(result.message, /opening board/i);
  assert.equal(result.objective.unavailableReason, "not_exactly_evaluable");
  // No completed report is left behind, and the allowance is untouched.
  assert.equal(
    store.rows.filter((row) => row.gameKey === "tic-tac-toe" && row.status === "complete").length,
    0,
  );
  assert.ok(store.releases >= 1, "the claim must be released");
  assert.equal(state.evaluateCalls, 1);
});

test("unsupported games stay blocked after registering tic-tac-toe", async () => {
  const { deps, calls } = makeDeps();
  const result = await run(deps, { gameKey: "keno" });
  assert.equal(result.status, 501);
  assert.equal(result.code, "not_supported");
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.isProMember, 0);
});

// ════════════════════════════════════════════════════════════════════
// 10. Speed Typing — a third game through the SAME service
// ════════════════════════════════════════════════════════════════════
//
// A `performance` report reaches the same authorization, entitlement,
// throttling, claim/idempotency and persistence path as chess and Tic-Tac-Toe.
// `evaluateMatch` is faked here; the metrics themselves are covered by
// tests/speed-typing-evaluator.test.mjs.

/** A minimal but valid complete performance GameReportV1. */
function sptReport(matchId, overrides = {}) {
  return {
    schemaVersion: 1,
    gameKey: "speed-typing",
    analysisType: "performance",
    status: "complete",
    match: { matchId, result: "player1", finishedAt: null, participants: [ME, OTHER] },
    metrics: [
      { key: "passageLength", label: "Passage length", unit: "count", available: true, value: 150 },
    ],
    players: [
      {
        playerId: ME,
        role: "player1",
        metrics: [{ key: "wpm", label: "Words per minute", unit: "wpm", available: true, value: 60 }],
      },
    ],
    engine: null,
    ai: null,
    unavailableReason: null,
    ...overrides,
  };
}

function sptUnavailable(matchId, reason) {
  return {
    schemaVersion: 1,
    gameKey: "speed-typing",
    analysisType: "performance",
    status: "unavailable",
    match: { matchId },
    metrics: [],
    unavailableReason: reason,
  };
}

function sptMatch(overrides = {}) {
  return {
    id: MATCH,
    playerWhiteId: ME,
    playerBlackId: OTHER,
    status: "finished",
    result: "player1",
    gameKey: "speed-typing",
    ...overrides,
  };
}

function makeSptDeps({ match = sptMatch(), report = (id) => sptReport(id) } = {}) {
  const state = { evaluateCalls: 0 };
  const { deps, store } = makeDeps({
    deps: {
      loadMatch: async () => match,
      evaluateMatch: async (matchId) => {
        state.evaluateCalls += 1;
        return report(matchId);
      },
      generateInsight: async () => {
        throw new Error("the model must never be called for speed typing");
      },
    },
  });
  return { deps, store, state };
}

const runSpt = (deps, input = {}) =>
  runEvaluation(
    { userId: ME, gameKey: "speed-typing", matchId: MATCH, ...input },
    deps,
  );

test("speed-typing: a finished match is evaluated and its performance report persisted", async () => {
  const { deps, store, state } = makeSptDeps();
  const result = await runSpt(deps);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.gameKey, "speed-typing");
  assert.equal(result.objective.analysisType, "performance");
  assert.equal(result.objective.status, "complete");
  assert.equal(result.insight, null);
  assert.equal(result.aiAvailable, false);
  assert.equal(result.message, null, "no AI was attempted, so no failure message");
  assert.equal(state.evaluateCalls, 1);

  const row = store.rows.find((candidate) => candidate.gameKey === "speed-typing");
  assert.ok(row, "the report must be persisted under its own game key");
  assert.equal(row.status, "complete");
  assert.equal(row.objectiveData.analysisType, "performance");
});

test("speed-typing: a second request is served from the stored report", async () => {
  const { deps, state } = makeSptDeps();
  const first = await runSpt(deps);
  const second = await runSpt(deps);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(state.evaluateCalls, 1);
});

test("speed-typing: only a participant may evaluate the match", async () => {
  const { deps, state } = makeSptDeps({
    match: sptMatch({ playerWhiteId: OTHER, playerBlackId: "user_third" }),
  });
  const result = await runSpt(deps);
  assert.equal(result.status, 403);
  assert.equal(result.code, "not_a_participant");
  assert.equal(state.evaluateCalls, 0);
});

test("speed-typing: an unfinished match is refused before any work", async () => {
  const { deps, state } = makeSptDeps({ match: sptMatch({ status: "playing" }) });
  const result = await runSpt(deps);
  assert.equal(result.status, 409);
  assert.equal(result.code, "match_not_finished");
  assert.equal(state.evaluateCalls, 0);
});

test("speed-typing: an unresolvable passage reports 422 with a reason and spends nothing", async () => {
  const { deps, store, state } = makeSptDeps({
    report: (matchId) => sptUnavailable(matchId, "passage_unavailable"),
  });
  const result = await runSpt(deps);

  assert.equal(result.status, 422);
  assert.equal(result.code, "insufficient_data");
  assert.match(result.message, /reference text/i);
  assert.equal(result.objective.unavailableReason, "passage_unavailable");
  assert.equal(
    store.rows.filter((row) => row.gameKey === "speed-typing" && row.status === "complete").length,
    0,
  );
  assert.ok(store.releases >= 1);
  assert.equal(state.evaluateCalls, 1);
});

test("unsupported games stay blocked after registering speed typing", async () => {
  const { deps, calls } = makeDeps();
  const result = await run(deps, { gameKey: "keno" });
  assert.equal(result.status, 501);
  assert.equal(result.code, "not_supported");
  assert.equal(calls.evaluateMatch, 0);
  assert.equal(calls.isProMember, 0);
});
