// tests/solitaire-review-api.test.mjs
//
// PHASE 3 — Game Review read APIs.
//
// The real routes are driven with a mocked identity, a fake database for the
// single-player rows, and a mocked duel store returning realistic match rows.
// The engine itself is NOT mocked: every returned log is replayed through
// `replayMoves` and compared to the board the fixture claims, so "exact deal +
// exact moves" is proved rather than asserted by field names alone.
//
// Run: node --import tsx --test --experimental-test-module-mocks tests/solitaire-review-api.test.mjs

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { solitaireDailyResults, solitaireSoloResults } from "../src/db/schema.ts";
import { ANALYSIS_VERSION, analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";
import { initialStateFromDeal, replayMoves } from "../src/lib/solitaire-duel/rules.ts";
import {
  canonicalMoveLog,
  moveLogDigest,
} from "../src/lib/solitaire-duel/soloPersistence.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";
import { dailyDateKey } from "../src/lib/solitaire-duel/soloStats.js";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const CLERK_SERVER_CJS = pathToFileURL(
  createRequire(import.meta.url).resolve("@clerk/nextjs/server"),
).href;

const USER = "user_review_owner";
const OTHER = "user_review_stranger";
const GUEST_A = "guest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GUEST_B = "guest_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AI = "solitaire_duel_ai_bot";
const MATCH_ID = "11111111-1111-4111-8111-111111111111";

// ── A real completed duel/solo fixture ─────────────────────────────────────
const DEAL = solvableDealFromSeed(7);
const LINE = solveDealLine(DEAL) ?? [];
const LOG = LINE.map((move) => ({ kind: move.kind, move }));
const FINAL = replayMoves({ deal: DEAL, moves: LOG }).state;
const OPENING = initialStateFromDeal(DEAL);
// One real analysis, computed once; the route-level cache is mocked below so
// these tests stay about the review envelope and its identity wiring.
const SAMPLE_ANALYSIS = analyzeSolitaireGame({ deal: DEAL, moves: LOG.slice(0, 20) });
const DAILY_KEY = dailyDateKey();

// ── Fake world ─────────────────────────────────────────────────────────────

let request;
let fake;
let duel;
let mocksInstalled = false;
const cacheInputs = [];

function duelMatch(overrides = {}) {
  return {
    id: MATCH_ID,
    variant: "klondike-1",
    variantVersion: 3,
    player1Id: USER,
    player2Id: OTHER,
    isAi: false,
    aiDifficulty: null,
    status: "finished",
    result: "player1",
    resolutionReason: "finish",
    deal: DEAL,
    p1State: FINAL,
    p2State: OPENING,
    p1Ply: LOG.length,
    p2Ply: 0,
    p1FinishedAt: new Date("2026-11-09T10:05:00Z"),
    p2FinishedAt: null,
    goAt: new Date("2026-11-09T10:00:00Z"),
    startedAt: new Date("2026-11-09T10:00:00Z"),
    endedAt: new Date("2026-11-09T10:05:00Z"),
    createdAt: new Date("2026-11-09T09:59:00Z"),
    ...overrides,
  };
}

function createFakeDb() {
  const state = { solo: [], daily: [] };

  const select = (fields) => {
    const chain = {
      table: null,
      values: [],
      limitCount: null,
      from(table) {
        chain.table = table;
        return chain;
      },
      where(condition) {
        const seen = new Set();
        const walk = (node, out) => {
          if (!node || typeof node !== "object" || seen.has(node)) return out;
          seen.add(node);
          for (const key of Object.keys(node)) {
            const child = node[key];
            if (typeof child === "string" || typeof child === "number") out.push(child);
            else if (child && typeof child === "object") walk(child, out);
          }
          return out;
        };
        chain.values = walk(condition, []);
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(n) {
        chain.limitCount = n;
        return chain;
      },
      then(resolve, reject) {
        try {
          const rows =
            chain.table === solitaireSoloResults
              ? state.solo
              : chain.table === solitaireDailyResults
                ? state.daily
                : null;
          if (!rows) throw new Error("fake db: unexpected table");

          // Column names share prefixes with some values ("user_id"); only the
          // bound identity/date/uuid predicates are used.
          const userId = chain.values.find(
            (value) =>
              typeof value === "string" && value.startsWith("user_") && value !== "user_id",
          );
          const guestId = chain.values.find(
            (value) => typeof value === "string" && value.startsWith("guest_"),
          );
          const rowId = chain.values.find(
            (value) =>
              typeof value === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
          );
          const filtered = rows.filter(
            (row) =>
              (!userId || row.userId === userId) &&
              (!guestId || row.userId === guestId) &&
              (!rowId || row.id === rowId),
          );
          const limited = filtered.slice(0, chain.limitCount ?? filtered.length);
          resolve(
            limited.map((row) =>
              fields
                ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))
                : row,
            ),
          );
        } catch (error) {
          reject(error);
        }
      },
    };
    return chain;
  };

  return { state, db: { select } };
}

const stableDb = { select: (...args) => fake.db.select(...args) };

function installMocks() {
  if (mocksInstalled) return;
  mocksInstalled = true;

  const clerkServer = { namedExports: { auth: async () => ({ userId: request.userId }) } };
  mock.module("@clerk/nextjs/server", clerkServer);
  mock.module(CLERK_SERVER_CJS, clerkServer);

  mock.module("../src/db/client.ts", { namedExports: { db: stableDb } });
  mock.module("../src/lib/logError.ts", { namedExports: { logError: async () => {} } });
  mock.module("../src/lib/solitaire-duel/daily.ts", {
    namedExports: {
      dailyDealFor: () => DEAL,
      dailyDealSeed: () => 7,
    },
  });

  // The DB-backed cache has its own suite. Here the seam records the identity
  // each route passes, so the canonical-digest wiring is asserted directly.
  mock.module("../src/lib/solitaire-duel/analysisCache.ts", {
    namedExports: {
      // The allowance gate reads the cache identity and probes the cache before
      // it can cost an analysis; here every read is a miss, so the recorded
      // `loadOrComputeAnalysis` calls below still describe the route wiring.
      analysisCacheIdentity: ({ gameKind, gameId, logDigest, engineVersion = 1 }) => ({
        gameKind,
        gameId,
        logDigest,
        engineVersion,
      }),
      readCachedAnalysis: async () => null,
      loadOrComputeAnalysis: async (input) => {
        cacheInputs.push(input);
        return { analysis: SAMPLE_ANALYSIS, cached: cacheInputs.length > 1 };
      },
    },
  });

  mock.module("../src/lib/auth/guestSession.ts", {
    namedExports: {
      readGuestId: async () => request.guestId ?? null,
      requirePracticePlayer: async () => {
        if (request.userId) {
          return { response: null, playerId: request.userId, isGuest: false };
        }
        if (request.guestId) {
          return { response: null, playerId: request.guestId, isGuest: true };
        }
        return {
          response: Response.json(
            { success: false, error: "Unauthorized" },
            { status: 401 },
          ),
          playerId: null,
          isGuest: false,
        };
      },
    },
  });

  mock.module("../src/lib/solitaire-duel/serverStore.ts", {
    namedExports: {
      isMatchId: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      fetchMatch: async ({ userId, matchId }) => {
        const match = duel.match;
        if (!match || matchId !== match.id) {
          return { error: "Match not found", status: 404 };
        }
        if (![match.player1Id, match.player2Id].includes(userId)) {
          return { error: "Not a participant of this match", status: 403 };
        }
        return {
          match,
          dto: {
            seat: userId === match.player1Id ? "player1" : "player2",
            isParticipant: true,
            status: match.status,
          },
        };
      },
      fetchSeatMoves: async (_matchId, seat) => {
        const entries = seat === "player1" ? duel.p1 : duel.p2;
        return entries.map((entry, ply) => ({
          ply,
          kind: entry.kind,
          move: entry.move,
          createdAt: new Date(),
        }));
      },
      stateForSeat: (match, seat) =>
        seat === "player1" ? match.p1State : match.p2State,
    },
  });
}

installMocks();

function reset({ userId = USER, guestId = null } = {}) {
  fake = createFakeDb();
  request = { userId, guestId };
  duel = { match: duelMatch(), p1: [...LOG], p2: [] };
  cacheInputs.length = 0;
}

const duelReview = () => import("../src/app/api/solitaire-duel/match/[matchId]/review/route.ts");
const singleReview = () => import("../src/app/api/solitaire/review/route.ts");

const duelGet = async (matchId = MATCH_ID) => {
  const { GET } = await duelReview();
  return GET(new Request(`http://grynd.test/api/solitaire-duel/match/${matchId}/review`), {
    params: Promise.resolve({ matchId }),
  });
};

const singleGet = async (mode, id) => {
  const { GET } = await singleReview();
  return GET(new Request(`http://grynd.test/api/solitaire/review?mode=${mode}&id=${id}`));
};

function soloRow(overrides = {}) {
  return {
    id: randomUUID(),
    userId: USER,
    seed: "7",
    completed: true,
    moves: LOG.length,
    moveLog: LOG,
    elapsedMs: 61_000,
    createdAt: new Date("2026-11-09T10:05:00Z"),
    ...overrides,
  };
}

function dailyRow(overrides = {}) {
  return {
    id: randomUUID(),
    userId: USER,
    challengeDate: DAILY_KEY,
    completed: true,
    moves: LOG.length,
    moveLog: LOG,
    elapsedMs: 42_000,
    createdAt: new Date("2026-11-09T10:05:00Z"),
    ...overrides,
  };
}

// ── Duel ───────────────────────────────────────────────────────────────────

test("a duel participant gets the exact deal and their own verified log", async () => {
  reset();
  const response = await duelGet();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.gameId, MATCH_ID);
  assert.equal(payload.data.gameKind, "duel");
  assert.equal(payload.data.status, "complete");
  assert.equal(payload.data.analysisEligible, true);
  assert.equal(payload.data.incompleteReason, null);
  assert.deepEqual(payload.data.deal, DEAL);
  assert.equal(payload.data.moves.length, LOG.length);
  assert.equal(payload.data.result.seat, "player1");
  assert.equal(payload.data.result.completed, true);
  assert.equal(payload.data.durationMs, 300_000);
  assert.equal(payload.data.result.winnerSeat, "player1");

  const replayed = replayMoves({ deal: payload.data.deal, moves: payload.data.moves });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.state.completed, true);
  assert.deepEqual(replayed.state, FINAL);
});

test("a duel review exposes no opponent board, id, moves, or server seed", async () => {
  reset();
  duel.p2 = LOG.slice(0, 3);
  const payload = await (await duelGet()).json();
  const text = JSON.stringify(payload.data);

  assert.deepEqual(payload.data.moves, LOG, "only the caller's moves are returned");
  assert.equal("p1State" in payload.data, false);
  assert.equal("p2State" in payload.data, false);
  assert.equal("player2Id" in payload.data, false);
  assert.equal("serverSeed" in payload.data, false);
  assert.equal(text.includes(OTHER), false);
  assert.equal(text.includes(AI), false);
});

test("a non-participant is refused and receives no deal", async () => {
  reset();
  request.userId = OTHER;
  // OTHER holds player2 in the fixture, so make the caller a stranger instead.
  duel.match = duelMatch({ player2Id: "user_someone_else" });

  const response = await duelGet();
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.success, false);
  assert.equal("deal" in payload, false);
  assert.equal("moves" in payload, false);
});

test("a live match is not reviewable and leaks neither deal nor log", async () => {
  reset();
  duel.match = duelMatch({
    status: "playing",
    result: null,
    resolutionReason: null,
    p1FinishedAt: null,
    p1Ply: 4,
    p1State: replayMoves({ deal: DEAL, moves: LOG.slice(0, 4) }).state,
  });
  duel.p1 = LOG.slice(0, 4);

  const response = await duelGet();
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, "REVIEW_NOT_READY");
  assert.equal("deal" in payload, false);
  assert.equal("moves" in payload, false);
});

test("a forfeit is returned as an incomplete review, not a complete one", async () => {
  reset();
  const prefix = LOG.slice(0, 5);
  duel.match = duelMatch({
    result: "player2",
    resolutionReason: "forfeit",
    p1State: replayMoves({ deal: DEAL, moves: prefix }).state,
    p1Ply: prefix.length,
    p1FinishedAt: null,
    endedAt: new Date("2026-11-09T10:02:00Z"),
  });
  duel.p1 = prefix;

  const payload = await (await duelGet()).json();

  assert.equal(payload.data.status, "forfeit");
  assert.equal(payload.data.analysisEligible, false);
  assert.equal(payload.data.incompleteReason, "forfeit");
  assert.equal(payload.data.result.completed, false);
  assert.equal(payload.data.result.resolutionReason, "forfeit");
  assert.equal(payload.data.moves.length, prefix.length);
  assert.equal(
    replayMoves({ deal: payload.data.deal, moves: payload.data.moves }).state.completed,
    false,
  );
});

test("a guest practice seat can review its own duel", async () => {
  reset({ userId: null, guestId: GUEST_A });
  duel.match = duelMatch({ player1Id: GUEST_A, player2Id: AI, isAi: true });

  const response = await duelGet();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.result.seat, "player1");
  assert.equal(payload.data.status, "complete");
});

test("an invalid or unknown duel id is a controlled error", async () => {
  reset();
  assert.equal((await duelGet("not-a-uuid")).status, 400);
  assert.equal((await duelGet(randomUUID())).status, 404);
});

// ── Solo / Daily ───────────────────────────────────────────────────────────

test("a solo game returns the shared shape and rebuilds exactly", async () => {
  reset();
  fake.state.solo.push(soloRow());

  const response = await singleGet("solo", fake.state.solo[0].id);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.gameId, fake.state.solo[0].id);
  assert.equal(payload.data.gameKind, "solo");
  assert.equal(payload.data.status, "complete");
  assert.equal(payload.data.variant, DEAL.variant);
  assert.equal(payload.data.variantVersion, DEAL.variantVersion);
  assert.deepEqual(payload.data.deal, DEAL);
  assert.deepEqual(payload.data.moves, LOG);
  assert.equal(payload.data.seed, 7);
  assert.equal(payload.data.result.completed, true);
  assert.equal(payload.data.durationMs, 61_000);
  assert.equal(payload.data.analysisEligible, true);

  const replayed = replayMoves({ deal: payload.data.deal, moves: payload.data.moves });
  assert.equal(replayed.state.completed, true);
  assert.deepEqual(replayed.state, FINAL);
});

test("a solo row is invisible to another player", async () => {
  reset();
  fake.state.solo.push(soloRow());

  request.userId = OTHER;
  const response = await singleGet("solo", fake.state.solo[0].id);
  assert.equal(response.status, 404);
});

test("a guest can read only their own solo practice result", async () => {
  reset({ userId: null, guestId: GUEST_A });
  fake.state.solo.push(soloRow({ userId: GUEST_A }));

  const own = await singleGet("solo", fake.state.solo[0].id);
  assert.equal(own.status, 200);

  request.guestId = GUEST_B;
  const theirs = await singleGet("solo", fake.state.solo[0].id);
  assert.equal(theirs.status, 404);
});

test("a daily game returns its date, deal, and log", async () => {
  reset();
  fake.state.daily.push(dailyRow());

  const response = await singleGet("daily", fake.state.daily[0].id);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.gameKind, "daily");
  assert.equal(payload.data.dateKey, DAILY_KEY);
  assert.deepEqual(payload.data.deal, DEAL);
  assert.deepEqual(payload.data.moves, LOG);
  assert.equal(payload.data.status, "complete");
  assert.equal(payload.data.durationMs, 42_000);
  assert.equal(
    replayMoves({ deal: payload.data.deal, moves: payload.data.moves }).state.completed,
    true,
  );
});

test("missing, incomplete, invalid, and signed-out reads are refused", async () => {
  reset();

  assert.equal((await singleGet("solo", randomUUID())).status, 404);
  assert.equal((await singleGet("daily", randomUUID())).status, 404);
  assert.equal((await singleGet("solo", "not-a-uuid")).status, 400);
  assert.equal((await singleGet("duel", randomUUID())).status, 400);

  // A completed row with no log (legacy / abandoned) is never an empty review.
  fake.state.solo.push(soloRow({ moveLog: null }));
  assert.equal((await singleGet("solo", fake.state.solo[0].id)).status, 404);

  // A stored log that does not solve the deal is refused too.
  fake.state.solo[0] = soloRow({ moveLog: LOG.slice(0, 5) });
  assert.equal((await singleGet("solo", fake.state.solo[0].id)).status, 404);

  request.userId = null;
  request.guestId = null;
  assert.equal((await singleGet("solo", randomUUID())).status, 401);
});

// ── Consistency across the three modes ─────────────────────────────────────

test("all three modes share one review envelope", async () => {
  reset();
  fake.state.solo.push(soloRow());
  fake.state.daily.push(dailyRow());

  const duelData = await (await duelGet()).json();
  const soloData = await (await singleGet("solo", fake.state.solo[0].id)).json();
  const dailyData = await (await singleGet("daily", fake.state.daily[0].id)).json();

  const fields = [
    "gameId",
    "gameKind",
    "variant",
    "variantVersion",
    "status",
    "deal",
    "moves",
    "result",
    "startedAt",
    "completedAt",
    "durationMs",
    "analysisEligible",
    "analysis",
    "incompleteReason",
  ];

  for (const payload of [duelData, soloData, dailyData]) {
    for (const field of fields) {
      assert.ok(field in payload.data, `${payload.data.gameKind} must expose ${field}`);
    }
    assert.ok(payload.data.moves.every((entry) => "kind" in entry && "move" in entry));
  }
  assert.deepEqual(
    [duelData.data.gameKind, soloData.data.gameKind, dailyData.data.gameKind],
    ["duel", "solo", "daily"],
  );
});

test("the routes never write, settle, or own the analysis engine", () => {
  const code = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const file of [
    "src/app/api/solitaire-duel/match/[matchId]/review/route.ts",
    "src/app/api/solitaire/review/route.ts",
  ]) {
    const source = code(read(file));
    assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/);
    assert.doesNotMatch(source, /settle|applyRating|applyTrophy|eloStore/);
    assert.doesNotMatch(source, /analyzeSolitaireGame/);
    // The analysis comes from the cache module, never from a second engine or
    // a client-supplied payload.
    // The route reaches the analysis through the allowance gate (a cached
    // re-view is free; a fresh one costs one of the free plan's three a day),
    // never through the uncosted loader.
    assert.match(source, /loadReviewAnalysis\(/);
    assert.doesNotMatch(source, /analysis:/);
  }
});

// ── Cached analysis wiring ─────────────────────────────────────────────────

test("every mode asks for the analysis under its own canonical log digest", async () => {
  reset();
  fake.state.solo.push(soloRow());
  fake.state.daily.push(dailyRow());

  const duelData = await (await duelGet()).json();
  const soloData = await (await singleGet("solo", fake.state.solo[0].id)).json();
  const dailyData = await (await singleGet("daily", fake.state.daily[0].id)).json();

  assert.deepEqual(
    [duelData.data.gameKind, soloData.data.gameKind, dailyData.data.gameKind],
    ["duel", "solo", "daily"],
  );
  for (const payload of [duelData, soloData, dailyData]) {
    assert.equal(payload.data.analysis.version, ANALYSIS_VERSION);
    assert.equal(payload.data.analysis.perMove.length, SAMPLE_ANALYSIS.perMove.length);
  }

  assert.equal(cacheInputs.length, 3);
  const expectedDigest = moveLogDigest(canonicalMoveLog(LOG).log);
  for (const input of cacheInputs) {
    assert.equal(input.logDigest, expectedDigest);
    assert.deepEqual(input.moves, canonicalMoveLog(LOG).log);
  }
  assert.deepEqual(
    cacheInputs.map((input) => input.gameKind),
    ["duel", "solo", "daily"],
  );
  // A different game id keeps a different cache row even with the same log.
  assert.deepEqual(
    cacheInputs.map((input) => input.gameId),
    [MATCH_ID, fake.state.solo[0].id, fake.state.daily[0].id],
  );
});

test("an incomplete review still returns the analysis for the moves it has", async () => {
  reset();
  const prefix = LOG.slice(0, 5);
  duel.match = duelMatch({
    result: "player2",
    resolutionReason: "forfeit",
    p1State: replayMoves({ deal: DEAL, moves: prefix }).state,
    p1Ply: prefix.length,
    p1FinishedAt: null,
    endedAt: new Date("2026-11-09T10:02:00Z"),
  });
  duel.p1 = prefix;

  const payload = await (await duelGet()).json();
  assert.equal(payload.data.status, "forfeit");
  assert.equal(payload.data.analysisEligible, false);
  assert.equal(payload.data.analysis.reconstructable, true);
  assert.equal(cacheInputs[0].logDigest, moveLogDigest(canonicalMoveLog(prefix).log));
});
