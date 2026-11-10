// tests/solitaire-analysis-cache.test.mjs
//
// PHASE 6 — the Game Review analysis cache.
//
// The cache's hard properties are pure or structural, so they are asserted
// directly rather than through Postgres:
//
//   1. IDENTITY — the key is game + SHA-256 of the canonical log + engine
//      version. A different game, log or version is a different row.
//   2. REUSE — a cache hit never calls the engine; a miss computes once and
//      stores one compact payload.
//   3. SAFETY — a read/write failure falls back to computing; a non-
//      reconstructable analysis is never stored; the payload holds no board,
//      no log and no commentary prose.
//   4. LIFECYCLE — the migration's unique index, RLS, retention orphan sweep
//      and account-deletion cleanup all know the table.
//   5. WIRING — all three review modes pass their own canonical digest and
//      return the analysis; the client skips its worker when the API returned
//      one, and only then.
//
// Run: npm run test:solitaire-review-cache

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ANALYSIS_VERSION } from "../src/lib/solitaire-duel/analysis.ts";
import {
  analysisCacheIdentity,
  compactAnalysis,
  loadOrComputeAnalysis,
} from "../src/lib/solitaire-duel/analysisCache.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const DIGEST = "a".repeat(64);
const GAME = "11111111-1111-4111-8111-111111111111";

const DEAL = {
  variant: "klondike-1",
  variantVersion: 3,
  tableau: Array.from({ length: 7 }, () => []),
  stock: [],
};
const LOG = [{ kind: "draw", move: { kind: "draw" } }];

const analysisOf = (overrides = {}) => ({
  version: ANALYSIS_VERSION,
  reconstructable: true,
  complete: false,
  rejectedAt: null,
  perMove: [
    {
      ply: 0,
      kind: "draw",
      rating: "normal",
      tags: ["stock-draw"],
      scoreBefore: 0,
      scoreAfter: 0,
      delta: 0,
      regret: 0,
      commentaryEligible: false,
      reasonCodes: ["routine"],
    },
  ],
  moments: [],
  summary: {
    movesAnalyzed: 1,
    ratings: {
      normal: 1,
      good: 0,
      great: 0,
      brilliant: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
    },
    accuracy: 100,
    totalRegret: 0,
    averageRegret: 0,
    deepSearchMoves: 0,
    informationFair: true,
  },
  ...overrides,
});

const identityOf = (overrides = {}) =>
  analysisCacheIdentity({
    gameKind: "solo",
    gameId: GAME,
    logDigest: DIGEST,
    engineVersion: ANALYSIS_VERSION,
    ...overrides,
  });

// ── Identity ──────────────────────────────────────────────────────────────

test("the identity is game + digest + engine version, with the live version default", () => {
  const identity = analysisCacheIdentity({
    gameKind: "daily",
    gameId: GAME,
    logDigest: DIGEST,
  });
  assert.deepEqual(identity, {
    gameKind: "daily",
    gameId: GAME,
    logDigest: DIGEST,
    engineVersion: ANALYSIS_VERSION,
  });
});

test("an incomplete identity can never address a cached row", () => {
  assert.equal(identityOf({ gameKind: "bogus" }), null);
  assert.equal(identityOf({ gameId: "" }), null);
  assert.equal(identityOf({ gameId: "x".repeat(65) }), null);
  assert.equal(identityOf({ logDigest: "short" }), null);
  assert.equal(identityOf({ logDigest: DIGEST.toUpperCase() }), null);
  assert.equal(identityOf({ engineVersion: 0 }), null);
  assert.equal(identityOf({ engineVersion: 1.5 }), null);
});

test("a changed log or engine version is a different identity", () => {
  const base = identityOf();
  assert.notEqual(identityOf({ logDigest: "b".repeat(64) }).logDigest, base.logDigest);
  assert.notEqual(identityOf({ engineVersion: base.engineVersion + 1 }).engineVersion, base.engineVersion);
});

// ── Payload ───────────────────────────────────────────────────────────────

test("the stored payload is the compact analysis only", () => {
  const analysis = analysisOf({
    deal: DEAL,
    moves: LOG,
    commentary: "a paragraph that must never be stored",
  });
  const compact = compactAnalysis(analysis);
  const json = JSON.stringify(compact);

  assert.equal(compact.version, ANALYSIS_VERSION);
  assert.equal(compact.perMove.length, 1);
  assert.deepEqual(compact.perMove[0].tags, ["stock-draw"]);
  assert.equal(compact.summary.informationFair, true);
  assert.doesNotMatch(json, /"deal"|"moves"|"commentary"|"moveLog"|"tableau"/);
});

test("a 300-move analysis stays a compact payload", () => {
  const perMove = Array.from({ length: 300 }, (_, ply) => ({
    ply,
    kind: "tableau-to-tableau",
    rating: "normal",
    tags: ["revealed-hidden", "foundation-progress"],
    scoreBefore: 1_000,
    scoreAfter: 1_150,
    delta: 150,
    regret: 0,
    commentaryEligible: false,
    reasonCodes: ["best-available", "meaningful-gain"],
  }));
  const compact = compactAnalysis(analysisOf({ perMove }));
  const bytes = Buffer.byteLength(JSON.stringify(compact), "utf8");

  // ~120 bytes per move in practice; this bound catches a board snapshot or a
  // duplicated log being added to the payload by accident.
  assert.ok(bytes < 128 * 1024, `compact analysis is ${bytes} bytes`);
  assert.equal(compact.perMove.length, 300);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

test("a cache miss computes once and stores one compact result", async () => {
  const analysis = analysisOf();
  let analyzeCalls = 0;
  const stored = [];

  const result = await loadOrComputeAnalysis(
    {
      gameKind: "solo",
      gameId: GAME,
      logDigest: DIGEST,
      deal: DEAL,
      moves: LOG,
    },
    {
      read: async () => null,
      store: async (identity, value) => {
        stored.push({ identity, value });
      },
      analyze: () => {
        analyzeCalls += 1;
        return analysis;
      },
    }
  );

  assert.equal(result.cached, false);
  assert.equal(result.analysis, analysis);
  assert.equal(analyzeCalls, 1);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].identity.engineVersion, ANALYSIS_VERSION);
  assert.equal(stored[0].identity.logDigest, DIGEST);
});

test("a cache hit never runs the engine", async () => {
  const analysis = analysisOf();
  let analyzeCalls = 0;

  const result = await loadOrComputeAnalysis(
    { gameKind: "duel", gameId: GAME, logDigest: DIGEST, deal: DEAL, moves: LOG },
    {
      read: async () => analysis,
      store: async () => assert.fail("a hit must not rewrite the cache"),
      analyze: () => {
        analyzeCalls += 1;
        return analysisOf({ version: 0 });
      },
    }
  );

  assert.equal(result.cached, true);
  assert.equal(result.analysis, analysis);
  assert.equal(analyzeCalls, 0);
});

test("a different digest or engine version asks for a different row", async () => {
  const analysis = analysisOf();
  const seen = [];

  await loadOrComputeAnalysis(
    { gameKind: "solo", gameId: GAME, logDigest: DIGEST, deal: DEAL, moves: LOG },
    {
      read: async (identity) => {
        seen.push(identity);
        return null;
      },
      store: async () => {},
      analyze: () => analysis,
    }
  );

  await loadOrComputeAnalysis(
    {
      gameKind: "solo",
      gameId: GAME,
      logDigest: "b".repeat(64),
      deal: DEAL,
      moves: LOG,
      engineVersion: ANALYSIS_VERSION + 1,
    },
    {
      read: async (identity) => {
        seen.push(identity);
        return null;
      },
      store: async () => {},
      analyze: () => analysisOf({ version: ANALYSIS_VERSION + 1 }),
    }
  );

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].logDigest, seen[1].logDigest);
  assert.notEqual(seen[0].engineVersion, seen[1].engineVersion);
});

test("a cache outage or a failed write falls back and can be retried", async () => {
  const analysis = analysisOf();
  let analyzeCalls = 0;
  let storeAttempts = 0;

  const first = await loadOrComputeAnalysis(
    { gameKind: "solo", gameId: GAME, logDigest: DIGEST, deal: DEAL, moves: LOG },
    {
      read: async () => {
        throw new Error("cache read failed");
      },
      store: async () => {
        storeAttempts += 1;
        throw new Error("cache write failed");
      },
      analyze: () => {
        analyzeCalls += 1;
        return analysis;
      },
    }
  );

  assert.equal(first.cached, false);
  assert.equal(first.analysis, analysis);
  assert.equal(analyzeCalls, 1);
  assert.equal(storeAttempts, 1);

  // No row was written, so the next review tries again rather than trusting a
  // half-finished cache.
  const second = await loadOrComputeAnalysis(
    { gameKind: "solo", gameId: GAME, logDigest: DIGEST, deal: DEAL, moves: LOG },
    {
      read: async () => null,
      store: async () => {
        storeAttempts += 1;
      },
      analyze: () => {
        analyzeCalls += 1;
        return analysis;
      },
    }
  );

  assert.equal(second.cached, false);
  assert.equal(analyzeCalls, 2);
  assert.equal(storeAttempts, 2);
});

test("an analysis the engine refused is not cached or returned", async () => {
  let stored = 0;
  const result = await loadOrComputeAnalysis(
    { gameKind: "solo", gameId: GAME, logDigest: DIGEST, deal: DEAL, moves: LOG },
    {
      read: async () => null,
      store: async () => {
        stored += 1;
      },
      analyze: () =>
        analysisOf({ reconstructable: false, complete: false, perMove: [], moments: [] }),
    }
  );

  assert.equal(result.analysis, null);
  assert.equal(result.cached, false);
  assert.equal(stored, 0);
});

// ── Schema, migration, retention, deletion ────────────────────────────────

test("the schema and migration make one row per identity structural", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const solitaireAnalysisCache = pgTable\(/);
  assert.match(schema, /solitaire_analysis_cache_identity_unique/);
  assert.match(schema, /table\.gameKind,\s*table\.gameId,\s*table\.logDigest,\s*table\.engineVersion/s);
  assert.match(schema, /engineVersion: integer\("engine_version"\)/);

  const migration = read("src/db/migrations/0249_solitaire_analysis_cache.sql");
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_analysis_cache_identity_unique"/
  );
  assert.match(migration, /CHECK \("game_kind" IN \('duel', 'solo', 'daily'\)\)/);
  assert.match(migration, /CHECK \("engine_version" > 0\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /USING \(false\)/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/i);

  const journal = JSON.parse(
    read("src/db/migrations/meta/_journal.json")
  );
  const entry = journal.entries.find((row) => row.tag === "0249_solitaire_analysis_cache");
  assert.ok(entry, "the migration must be journaled or db:migrate will skip it");
  assert.equal(entry.idx, journal.entries.length - 1);
});

test("retention deletes analyses whose game no longer exists", () => {
  const retention = read("src/app/api/jobs/retention/route.ts");
  assert.match(retention, /DELETE FROM solitaire_analysis_cache/);
  assert.match(retention, /NOT EXISTS \(\s*SELECT 1 FROM solitaire_duel_matches/s);
  assert.match(retention, /solitaire_solo_results/);
  assert.match(retention, /solitaire_daily_results/);
  assert.match(retention, /deletedByTable\["solitaire_analysis_cache"\]/);
});

test("account deletion erases cached analyses for the erased player's games", () => {
  const purge = read("src/lib/security/deleteUserData.ts");
  assert.match(purge, /solitaireAnalysisCache/);
  assert.match(purge, /inArray\(solitaireAnalysisCache\.gameId, cachedGameIds\)/);
  assert.match(purge, /solitaireDuelMatches/);
});

// ── WIRING ────────────────────────────────────────────────────────────────

test("all three review modes return the analysis for their own canonical log", () => {
  const solo = read("src/app/api/solitaire/review/route.ts");
  const duel = read("src/app/api/solitaire-duel/match/[matchId]/review/route.ts");

  for (const source of [solo, duel]) {
    assert.match(source, /loadOrComputeAnalysis\(/);
    assert.match(source, /logDigest: moveLogDigest\(canonical\.log\)/);
    assert.match(source, /^\s*analysis,$/m);
  }
  assert.match(solo, /gameKind: "solo"/);
  assert.match(solo, /gameKind: "daily"/);
  assert.match(duel, /gameKind: "duel"/);
  // The cache is server-side only: no client digest, no request, no worker here.
  assert.doesNotMatch(solo, /analyzeSolitaireGame/);
  assert.doesNotMatch(duel, /analyzeSolitaireGame/);
});

test("the client uses the returned analysis and does not re-analyse", () => {
  const hook = read("src/hooks/useSolitaireReviewAnalysis.ts");
  assert.match(hook, /initialAnalysis = null/);
  assert.match(hook, /if \(initialAnalysis\) \{/);
  assert.match(hook, /setState\(\{ status: "ready", analysis: initialAnalysis/);
  assert.match(hook, /\[enabled, gameKey, deal, moves, initialAnalysis\]/);

  const page = read("src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx");
  assert.match(page, /initialAnalysis: data\?\.analysis \?\? null/);
});

test("the cache adds no external service or generative dependency", () => {
  const source = read("src/lib/solitaire-duel/analysisCache.ts");
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|openai|anthropic|redis|Math\.random|Date\.now/);
  assert.match(source, /from "\.\.\/\.\.\/db\/client"/);
  assert.match(source, /ANALYSIS_VERSION/);
});
