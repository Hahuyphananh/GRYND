/**
 * GAME REVIEW — the free-plan allowance (3 fresh analyses per UTC day) and the
 * PRO unlimited pass.
 *
 * The rules this file pins, all server-side and with no database:
 *
 *   * a free account may take 3 fresh analyses in one UTC day; the 4th is
 *     refused with `analysis: null` plus the allowance, so the surface can say
 *     how many are left and point at the upgrade page;
 *   * a cached analysis (same game + log + engine version) is FREE — it never
 *     consumes a slot, so refreshing or re-opening a review costs nothing;
 *   * GRYND PRO is unlimited and is never written to the usage table;
 *   * the day rolls over at UTC midnight;
 *   * an unreachable quota table fails OPEN (the review still computes) instead
 *     of blocking a paying or free player.
 *
 * Run: node --import tsx --test tests/solitaire-analysis-allowance.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FREE_ANALYSES_PER_DAY,
  analysisDayKey,
  analysisResetAt,
  consumeAnalysisAllowance,
  freeAllowance,
  readAnalysisAllowance,
  unlimitedAllowance,
} from "../src/lib/solitaire-duel/analysisAllowance.ts";
import { loadReviewAnalysis } from "../src/lib/solitaire-duel/reviewAnalysis.ts";

/** The shape `loadReviewAnalysis` requires of a cached analysis. */
const ANALYZED_GAME = {
  version: 1,
  reconstructable: true,
  complete: true,
  rejectedAt: null,
  perMove: [],
  moments: [],
  summary: {
    movesAnalyzed: 0,
    ratings: {},
    accuracy: 100,
    totalRegret: 0,
    averageRegret: 0,
    deepSearchMoves: 0,
    informationFair: true,
  },
};

const read = (path) => fs.readFileSync(path, "utf8");

/** An in-memory usage store shaped like the real one (one row per day). */
function memoryStore() {
  const rows = new Map();
  const usage = {
    readUsage: async ({ playerId, dayKey }) => rows.get(`${playerId}:${dayKey}`) ?? 0,
    consumeUsage: async ({ playerId, dayKey, limit = FREE_ANALYSES_PER_DAY }) => {
      const key = `${playerId}:${dayKey}`;
      const used = rows.get(key) ?? 0;
      if (used >= limit) return null;
      rows.set(key, used + 1);
      return used + 1;
    },
  };
  return { rows, usage };
}

/** A cache seam: `cached` decides whether the analysis is already stored. */
function cache(cached) {
  const stored = [];
  return {
    stored,
    read: async () => cached,
    store: async (identity, analysis) => stored.push({ identity, analysis }),
    analyze: () => ANALYZED_GAME,
  };
}

const NOW = new Date("2026-11-13T22:30:00.000Z");

const INPUT = {
  gameKind: "solo",
  gameId: "11111111-1111-4111-8111-111111111111",
  logDigest: "a".repeat(64),
  deal: {},
  moves: [],
  now: NOW,
};

test("a free account gets exactly 3 fresh analyses per day", async () => {
  const { usage } = memoryStore();
  const deps = { ...usage, ...cache(null), isPro: async () => false };

  for (let i = 1; i <= FREE_ANALYSES_PER_DAY; i += 1) {
    const result = await loadReviewAnalysis({ ...INPUT, playerId: "user_1" }, deps);
    assert.equal(result.limited, false, `analysis ${i} must be allowed`);
    assert.ok(result.analysis, `analysis ${i} must be returned`);
    assert.equal(result.allowance.used, i);
    assert.equal(result.allowance.remaining, FREE_ANALYSES_PER_DAY - i);
  }

  const denied = await loadReviewAnalysis({ ...INPUT, playerId: "user_1" }, deps);
  assert.equal(denied.limited, true, "the 4th fresh analysis must be refused");
  assert.equal(denied.analysis, null, "no analysis may be served past the limit");
  assert.equal(denied.allowance.remaining, 0);
  assert.equal(denied.allowance.limit, FREE_ANALYSES_PER_DAY);
});

test("the allowance is per identity — one account cannot spend another's", async () => {
  const { usage } = memoryStore();
  const deps = { ...usage, ...cache(null), isPro: async () => false };
  const spend = async (playerId, times) => {
    let last;
    for (let i = 0; i < times; i += 1) {
      last = await loadReviewAnalysis({ ...INPUT, playerId }, deps);
    }
    return last;
  };

  const other = await spend("user_2", FREE_ANALYSES_PER_DAY);
  assert.equal(other.limited, false);
  // The second account starts with a full allowance of its own.
  const firstForUser1 = await loadReviewAnalysis({ ...INPUT, playerId: "user_1" }, deps);
  assert.equal(firstForUser1.limited, false);
  assert.equal(firstForUser1.allowance.used, 1);
});

test("a cached re-view is free and never consumes a slot", async () => {
  const { usage, rows } = memoryStore();
  const deps = { ...usage, ...cache(ANALYZED_GAME), isPro: async () => false };

  for (let i = 0; i < 10; i += 1) {
    const result = await loadReviewAnalysis({ ...INPUT, playerId: "user_1" }, deps);
    assert.equal(result.cached, true);
    assert.equal(result.limited, false);
    assert.ok(result.analysis, "the cached analysis is always served");
  }
  assert.equal(rows.size, 0, "a cache hit must not write a usage row");
});

test("PRO is unlimited and never counted", async () => {
  const { usage, rows } = memoryStore();
  const deps = { ...usage, ...cache(null), isPro: async () => true };

  for (let i = 0; i < FREE_ANALYSES_PER_DAY * 5; i += 1) {
    const result = await loadReviewAnalysis({ ...INPUT, playerId: "user_pro" }, deps);
    assert.equal(result.limited, false);
    assert.equal(result.allowance.unlimited, true);
    assert.equal(result.allowance.limit, null);
    assert.ok(result.analysis);
  }
  assert.equal(rows.size, 0, "PRO members must never be written to the usage table");
});

test("the allowance rolls over at UTC midnight", async () => {
  const { usage, rows } = memoryStore();
  const deps = { ...usage, isPro: async () => false };
  const endOfDay = new Date("2026-11-13T23:59:59.000Z");
  const nextDay = new Date("2026-11-14T00:00:01.000Z");

  for (let i = 0; i < FREE_ANALYSES_PER_DAY; i += 1) {
    await loadReviewAnalysis({ ...INPUT, playerId: "user_1", now: endOfDay }, { ...deps, ...cache(null) });
  }
  const denied = await loadReviewAnalysis(
    { ...INPUT, playerId: "user_1", now: endOfDay },
    { ...deps, ...cache(null) },
  );
  assert.equal(denied.limited, true);

  const fresh = await loadReviewAnalysis(
    { ...INPUT, playerId: "user_1", now: nextDay },
    { ...deps, ...cache(null) },
  );
  assert.equal(fresh.limited, false, "a new UTC day restores the allowance");
  assert.equal(fresh.allowance.used, 1);
  assert.equal(rows.size, 2, "the count is stored per day");
});

test("day key and reset instant are UTC", () => {
  const late = new Date("2026-11-13T23:59:00.000Z");
  assert.equal(analysisDayKey(late), "2026-11-13");
  assert.equal(analysisResetAt(late), "2026-11-14T00:00:00.000Z");
  assert.equal(freeAllowance(-5, late).used, 0, "a corrupt count cannot go negative");
  assert.equal(unlimitedAllowance(late).remaining, null);
});

test("an unreachable quota store fails open instead of blocking the review", async () => {
  const boom = {
    readUsage: async () => {
      throw new Error("db down");
    },
    consumeUsage: async () => {
      throw new Error("db down");
    },
  };
  const { usage } = memoryStore();
  const { usage: unused } = memoryStore();
  void unused;

  const allowed = await loadReviewAnalysis(
    { ...INPUT, playerId: "user_1" },
    { ...boom, ...cache(null), isPro: async () => false },
  );
  assert.equal(allowed.limited, false, "a quota outage must not deny the analysis");
  assert.ok(allowed.analysis);

  const read = await readAnalysisAllowance({ playerId: "user_1", isPro: false, now: NOW }, boom);
  assert.equal(read.remaining, FREE_ANALYSES_PER_DAY);

  const consumed = await consumeAnalysisAllowance({ playerId: "user_1", isPro: false, now: NOW }, boom);
  assert.equal(consumed.allowed, true);
  assert.equal(consumed.allowance.unlimited, false);
  void usage;
});

test("both review routes gate through the allowance, not the cache loader directly", () => {
  for (const path of [
    "src/app/api/solitaire/review/route.ts",
    "src/app/api/solitaire-duel/match/[matchId]/review/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /loadReviewAnalysis\(/, `${path} must consume the allowance`);
    assert.ok(
      !/loadOrComputeAnalysis/.test(source),
      `${path} must not reach the uncosted loader directly`,
    );
    assert.match(source, /analysisLimited: limited/, `${path} must report the limit`);
  }
});

test("the PRO catalog advertises unlimited analysis and points at its enforcement", () => {
  const benefits = read("src/lib/proBenefits.ts");
  assert.match(
    benefits,
    /\{ id: "analysis_unlimited", availability: "available" \}/,
    "unlimited analysis must be an ADVERTISED PRO benefit",
  );

  const migration = read("src/db/migrations/0251_solitaire_analysis_usage.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "solitaire_analysis_usage"/);

  // The increment is one atomic statement whose UPDATE carries the limit, so two
  // concurrent first views cannot both take the last free slot.
  const allowance = read("src/lib/solitaire-duel/analysisAllowance.ts");
  assert.match(allowance, /on conflict \("user_id", "day_key"\) do update/);
  assert.match(
    allowance,
    /where "solitaire_analysis_usage"\."used" < \$\{limit\}/,
    "the increment must be limit-checked",
  );
  assert.ok(
    read("src/db/migrations/meta/_journal.json").includes("0251_solitaire_analysis_usage"),
    "the usage table migration must be journaled",
  );
});
