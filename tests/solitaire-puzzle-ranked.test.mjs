/**
 * solitaire-puzzle-ranked.test.mjs
 *
 * PUZZLE RANKED, end to end on the server.
 *
 * What this file pins:
 *
 *   1. FORMAT — both seats race one frozen manifest (same puzzles, same order,
 *      same objectives, same start states) under one absolute GO/deadline pair.
 *   2. MATCHMAKING — human vs human only; one active match per player; a
 *      second search is the same search; concurrent searches cannot open two
 *      lobbies; a search can be cancelled and an abandoned one is never paired.
 *   3. SCORING — the solved count is what the SERVER verified; equal counts are
 *      broken by the earlier final solve; an exact tie is a draw.
 *   4. DEADLINE — a post-deadline move is refused and the timeout result is
 *      settled exactly once.
 *   5. SETTLEMENT — the shared Elo/trophy writers run once with the dedicated
 *      `solitaire-puzzle` key; guests and practice never settle.
 *   6. HISTORY — both seats read the same public result; reward deltas are the
 *      caller's own.
 *   7. ISOLATION — the mode owns its registry key, its tables and its lock, and
 *      never touches a Solitaire Duel match.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/solitaire-puzzle-session.test.mjs, with three
 * additions the ranked paths need: a test clock for row creation, SQL-aware
 * `execute` results for the journal read, and the same serialized transactions
 * (the real `pg_advisory_xact_lock` + `FOR UPDATE` guarantee).
 *
 * Run: node --import tsx --test --experimental-test-module-mocks tests/solitaire-puzzle-ranked.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";

import {
  solitairePuzzleSessionMoves,
  solitairePuzzleSessions,
} from "../src/db/schema.ts";
import {
  PUZZLE_RANKED_QUEUE_TTL_MS,
  PUZZLE_SESSION_DEADLINE_MS,
  PUZZLE_SESSION_STATUS,
} from "../src/lib/solitaire-puzzle/constants.ts";
import { manifestFromIds } from "../src/lib/solitaire-puzzle/manifest.ts";
import { puzzleLibraryPuzzles } from "../src/lib/solitaire-duel/puzzleLibrary.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:puzzle-ranked";

const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const NOW = 1_800_000_000_000;
const SEED = "ab".repeat(32);

const LIBRARY = puzzleLibraryPuzzles();
const BY_LENGTH = [...LIBRARY].sort(
  (a, b) => a.spec.solutions[0].length - b.spec.solutions[0].length,
);
const SAMPLE = BY_LENGTH[0];
const SAMPLE2 = BY_LENGTH.find((puzzle) => puzzle.id !== SAMPLE.id);

// ── 1. Isolation is checked before any module is mocked ───────────────────

test("isolation: Puzzle Ranked has its own key, registry entry and tables", async () => {
  const { RATED_GAMES, RATING_GAME_LABELS, isRatedGame, normalizeRatingGameKey } =
    await import("../src/lib/rating.js");

  // The ONE registry holds both modes as DISTINCT per-game records.
  assert.ok(RATED_GAMES.includes("solitaire-duel"));
  assert.ok(RATED_GAMES.includes("solitaire-puzzle"));
  assert.notEqual("solitaire-duel", "solitaire-puzzle");
  assert.equal(isRatedGame("solitaire-puzzle"), true);
  assert.equal(normalizeRatingGameKey("solitaire-puzzle"), "solitaire-puzzle");
  assert.equal(RATING_GAME_LABELS["solitaire-duel"], "Solitaire Duel");
  assert.equal(RATING_GAME_LABELS["solitaire-puzzle"], "Puzzle Ranked");

  // The puzzle namespace never reads or writes a duel match table.
  for (const file of [
    "src/lib/solitaire-puzzle/serverStore.ts",
    "src/lib/solitaire-puzzle/matchmaking.ts",
    "src/lib/solitaire-puzzle/settlement.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /solitaireDuelMatches|solitaireDuelMoves/, `${file} touches a duel table`);
    assert.doesNotMatch(source, /gameKey: "solitaire-duel"/, `${file} settles a duel`);
  }

  // ...and the duel store is unchanged: it still settles its own key only.
  const duel = fs.readFileSync("src/lib/solitaire-duel/serverStore.ts", "utf8");
  assert.match(duel, /gameKey: "solitaire-duel"/);
  assert.doesNotMatch(duel, /solitaire-puzzle/);
});

// ── The fake database ─────────────────────────────────────────────────────

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

const textOf = (query) => {
  try {
    return JSON.stringify(query?.queryChunks ?? "");
  } catch {
    return "";
  }
};

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    lock: Promise.resolve(),
    nowMs: NOW,
    ratingRows: [],
    trophyRows: [],
  };

  const rowsOf = (table) => {
    if (!state.tables.has(table)) state.tables.set(table, []);
    return state.tables.get(table);
  };

  const select = () => {
    let table = null;
    const q = {
      from(t) {
        table = t;
        return q;
      },
      where: () => q,
      for: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve, reject) =>
        Promise.resolve(rowsOf(table).map((row) => structuredClone(row))).then(resolve, reject),
    };
    return q;
  };

  const update = (table) => {
    let values = null;
    let applied = null;
    const apply = () => {
      const rows = rowsOf(table);
      for (const row of rows) {
        for (const [key, value] of Object.entries(values)) {
          row[key] = isSqlExpression(value) ? (Number(row[key]) || 0) + 1 : value;
        }
      }
      return rows.map((row) => structuredClone(row));
    };
    const b = {
      set(v) {
        values = v;
        return b;
      },
      where() {
        applied = apply();
        return b;
      },
      returning() {
        return Promise.resolve(applied ?? apply());
      },
      then(resolve, reject) {
        const out = applied ?? apply();
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };

  const insert = (table) => ({
    values: (v) => {
      const seq = state.nextId++;
      const id =
        table === solitairePuzzleSessions
          ? `66666666-6666-4666-8666-${String(seq).padStart(12, "0")}`
          : `row-${seq}`;
      const row = {
        id,
        // The test clock, so queue-expiry arithmetic is deterministic.
        createdAt: new Date(state.nowMs),
        ...structuredClone(v),
      };
      if (table === solitairePuzzleSessionMoves) {
        const key = `${row.sessionId}|${row.seat}|${row.ply}`;
        const clash = rowsOf(table).some(
          (existing) => `${existing.sessionId}|${existing.seat}|${existing.ply}` === key,
        );
        if (clash) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
          });
        }
      }
      rowsOf(table).push(row);
      const out = { returning: () => Promise.resolve([structuredClone(row)]) };
      out.then = (resolve, reject) => Promise.resolve([structuredClone(row)]).then(resolve, reject);
      return out;
    },
  });

  const execute = async (query) => {
    const text = textOf(query);
    if (text.includes("rating_events")) return { rows: state.ratingRows };
    if (text.includes("trophy_events")) return { rows: state.trophyRows };
    return { rows: [] };
  };

  const tx = { select, update, insert, execute };

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.lock = Promise.resolve();
    state.nowMs = NOW;
    state.ratingRows = [];
    state.trophyRows = [];
  };

  return {
    state,
    reset,
    rowsOf,
    db: {
      select,
      update,
      insert,
      execute,
      transaction: (fn) => {
        const run = async () => {
          state.transactions += 1;
          const backup = new Map(
            [...state.tables].map(([table, rows]) => [table, rows.map((row) => structuredClone(row))]),
          );
          try {
            return await fn(tx);
          } catch (error) {
            state.tables.clear();
            for (const [table, rows] of backup) state.tables.set(table, rows);
            throw error;
          }
        };
        const result = state.lock.then(run, run);
        state.lock = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  };
}

let sharedFake = null;
const settlement = { rating: [], trophy: [], queue: [] };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;
  settlement.queue.length = 0;

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });
  t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
    namedExports: {
      mirrorQueueCreated: (args) => settlement.queue.push({ kind: "created", ...args }),
      mirrorQueueTransition: (args) => settlement.queue.push({ kind: "transition", ...args }),
    },
  });
  t.mock.module("../src/lib/rating.js", {
    namedExports: {
      applyRatingResult: async (args) => {
        settlement.rating.push(args);
        return { applied: true };
      },
    },
  });
  t.mock.module("../src/lib/trophyStore.js", {
    namedExports: {
      applyTrophyResult: async (args) => {
        settlement.trophy.push(args);
        return { applied: true };
      },
    },
  });
  return fake;
}

const loadStore = () => import("../src/lib/solitaire-puzzle/serverStore.ts");
const loadMatchmaking = () => import("../src/lib/solitaire-puzzle/matchmaking.ts");

function rankedPair(store, { manifest, seed = SEED } = {}) {
  return store.createRankedPuzzleSession({
    player1Id: ALICE,
    player2Id: BOB,
    nowMs: NOW,
    seed,
    ...(manifest ? { manifest } : {}),
  });
}

// ── 2. Match format and matchmaking ───────────────────────────────────────

test("queue: two players are paired on ONE frozen set and ONE shared clock", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const matchmaking = await loadMatchmaking();

  const opened = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW });
  assert.equal("error" in opened, false, opened.error);
  assert.equal(opened.state.waiting, true);

  // While waiting, the first player is served an HONEST waiting state: no
  // board, no puzzle set, and a visible start/expiry.
  const waitingView = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: opened.state.sessionId,
    nowMs: NOW,
  });
  assert.equal("error" in waitingView, false, waitingView.error);
  assert.equal(waitingView.view.board, null);
  assert.equal(waitingView.view.status, PUZZLE_SESSION_STATUS.WAITING);

  const joined = await matchmaking.createOrJoinPuzzleRanked({ userId: BOB, nowMs: NOW + 500 });
  assert.equal(joined.state.joined, true, "the second caller takes the open seat");
  assert.equal(joined.state.status, PUZZLE_SESSION_STATUS.PLAYING);
  assert.equal(joined.state.sessionId, opened.state.sessionId);

  const fromAlice = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: joined.state.sessionId,
    nowMs: NOW + 500,
  });
  const fromBob = await store.fetchPuzzleSession({
    userId: BOB,
    sessionId: joined.state.sessionId,
    nowMs: NOW + 500,
  });
  assert.equal("error" in fromAlice, false, fromAlice.error);
  assert.equal("error" in fromBob, false, fromBob.error);

  // Same puzzles, same order, same start state, same allowance.
  assert.deepEqual(fromAlice.snapshot.manifest, fromBob.snapshot.manifest);
  assert.deepEqual(fromAlice.snapshot.p1.state, fromBob.snapshot.p2.state);
  assert.equal(fromAlice.view.puzzleCount, 5);
  assert.equal(fromAlice.view.board.nextStockCard, null, "the next stock card stays hidden");
  assert.equal(fromAlice.snapshot.goAtMs, NOW + 500);
  assert.equal(fromBob.snapshot.goAtMs, NOW + 500);
  assert.equal(fromAlice.snapshot.deadlineAtMs, NOW + 500 + PUZZLE_SESSION_DEADLINE_MS);
  assert.equal(fromBob.snapshot.deadlineAtMs, fromAlice.snapshot.deadlineAtMs);
  assert.equal(fromAlice.seat, "player1");
  assert.equal(fromBob.seat, "player2");

  // The mode is ranked, not practice, and the queue mirror saw both transitions.
  assert.equal(fromAlice.snapshot.mode, "ranked");
  assert.equal(fromAlice.snapshot.isAi, false);
  assert.deepEqual(
    settlement.queue.map((entry) => [entry.kind, entry.gameKey]),
    [
      ["created", "solitaire-puzzle"],
      ["transition", "solitaire-puzzle"],
    ],
  );
  assert.equal(fake.rowsOf(solitairePuzzleSessions).length, 1);
});

test("queue: one player cannot hold two matches, or match themselves", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const matchmaking = await loadMatchmaking();

  const first = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW });
  const again = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW + 100 });
  assert.equal(again.state.sessionId, first.state.sessionId);
  assert.equal(again.state.alreadyActive, true);
  assert.equal(again.state.joined, false);
  assert.equal(fake.rowsOf(solitairePuzzleSessions).length, 1, "no self-match, no second lobby");

  const joined = await matchmaking.createOrJoinPuzzleRanked({ userId: BOB, nowMs: NOW + 200 });
  assert.equal(joined.state.joined, true);

  const third = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW + 300 });
  assert.equal(third.state.sessionId, joined.state.sessionId);
  assert.equal(third.state.status, PUZZLE_SESSION_STATUS.PLAYING);
  assert.equal(third.state.alreadyActive, true);
  assert.equal(fake.rowsOf(solitairePuzzleSessions).length, 1);
});

test("queue: concurrent searches open ONE lobby and take ONE seat", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const matchmaking = await loadMatchmaking();

  const results = await Promise.all([
    matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW }),
    matchmaking.createOrJoinPuzzleRanked({ userId: BOB, nowMs: NOW }),
  ]);

  assert.equal(results.every((result) => !("error" in result)), true);
  const [a, b] = results;
  assert.equal(a.state.sessionId, b.state.sessionId, "both callers land on the same match");
  assert.equal([a.state.joined, b.state.joined].filter(Boolean).length, 1);
  // Whoever ran first received the `waiting` snapshot of the lobby they had
  // just opened; the other took the second seat and received `playing`.
  assert.equal([a.state.waiting, b.state.waiting].filter(Boolean).length, 1);
  assert.equal(fake.rowsOf(solitairePuzzleSessions).length, 1, "exactly one row");
});

test("queue: cancellation releases the search and settles nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const matchmaking = await loadMatchmaking();

  const opened = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW });
  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].status, PUZZLE_SESSION_STATUS.WAITING);

  const cancelled = await matchmaking.cancelPuzzleRankedSearch({ userId: ALICE, nowMs: NOW + 100 });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.sessionId, opened.state.sessionId);
  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].status, PUZZLE_SESSION_STATUS.CANCELLED);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);

  const state = await matchmaking.getPuzzleRankedQueue({ userId: ALICE, nowMs: NOW + 200 });
  assert.equal(state.sessionId, null);
  assert.equal(state.waiting, false);
});

test("queue: cancelling as an opponent joins keeps the live match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const matchmaking = await loadMatchmaking();

  const opened = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW });
  const joined = await matchmaking.createOrJoinPuzzleRanked({ userId: BOB, nowMs: NOW + 100 });
  assert.equal(joined.state.status, PUZZLE_SESSION_STATUS.PLAYING);

  const cancelled = await matchmaking.cancelPuzzleRankedSearch({ userId: ALICE, nowMs: NOW + 200 });
  assert.equal(cancelled.cancelled, false, "a live race is not a cancellable search");
  assert.equal(cancelled.sessionId, null);
  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].status, PUZZLE_SESSION_STATUS.PLAYING);
  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].id, opened.state.sessionId);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);

  const state = await matchmaking.getPuzzleRankedQueue({ userId: ALICE, nowMs: NOW + 300 });
  assert.equal(state.status, PUZZLE_SESSION_STATUS.PLAYING);
  assert.equal(state.sessionId, opened.state.sessionId);
});

test("queue: an abandoned search is never paired", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const matchmaking = await loadMatchmaking();

  const opened = await matchmaking.createOrJoinPuzzleRanked({ userId: ALICE, nowMs: NOW });
  fake.rowsOf(solitairePuzzleSessions)[0].createdAt = new Date(
    NOW - PUZZLE_RANKED_QUEUE_TTL_MS - 1_000,
  );

  const joined = await matchmaking.createOrJoinPuzzleRanked({ userId: BOB, nowMs: NOW });
  assert.equal(joined.state.joined, false, "an expired seat is not joined");
  assert.equal(joined.state.waiting, true);
  assert.notEqual(joined.state.sessionId, opened.state.sessionId);

  const rows = fake.rowsOf(solitairePuzzleSessions);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.id === opened.state.sessionId).status,
    PUZZLE_SESSION_STATUS.CANCELLED,
  );
});

// ── 3. Server-authoritative moves and scoring ─────────────────────────────

test("moves: non-participants, malformed payloads and illegal moves are refused", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store, { manifest: manifestFromIds([SAMPLE.id]) });

  const stranger = await store.submitPuzzleMove({
    userId: MALLORY,
    sessionId: session.id,
    move: { kind: "draw" },
    nowMs: NOW,
  });
  assert.equal(stranger.status, 403);

  const malformed = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "teleport" },
    nowMs: NOW,
  });
  assert.equal(malformed.status, 400);

  // A well-formed but illegal move: name the WRONG card for a real column.
  const entry = session.manifest[0];
  const top = [...entry.spec.startState.tableau[0]]
    .reverse()
    .find((pile) => pile.faceUp)?.card;
  assert.ok(top, "the sample puzzle must have a face-up top card");
  const wrongCard = { suit: top.suit, rank: top.rank === 1 ? 2 : 1 };
  const illegal = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: {
      kind: "tableau-to-foundation",
      fromColumn: 0,
      card: wrongCard,
      suit: top.suit,
    },
    nowMs: NOW,
  });
  assert.equal(illegal.status, 422);

  assert.equal(settlement.rating.length, 0);
});

test("score: the solved count is what the SERVER verified, and it decides the winner", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store, {
    manifest: manifestFromIds([SAMPLE.id, SAMPLE2.id]),
  });

  let ply = 0;
  let last = null;
  for (const [index, puzzle] of [SAMPLE, SAMPLE2].entries()) {
    for (const move of puzzle.spec.solutions[0]) {
      last = await store.submitPuzzleMove({
        userId: ALICE,
        sessionId: session.id,
        move,
        expectedPly: ply,
        nowMs: NOW + ply * 100,
      });
      assert.equal("error" in last, false, last.error);
      ply += 1;
    }
    if (index === 0) {
      assert.equal(last.advancedPuzzle, true, "finishing a puzzle advances the seat");
      assert.equal(last.view.puzzleNumber, 2);
    }
  }

  assert.equal(last.completedSession, true);
  assert.equal(last.finished, true);
  assert.equal(last.view.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(last.view.result.result, "player1");
  assert.equal(last.view.result.player1.solved, 2);
  assert.equal(last.view.result.player2.solved, 0);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.p1Solved, 2);
  assert.equal(row.p2Solved, 0);
  assert.equal(row.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(row.winnerId, ALICE);

  // Exactly one rated settlement, on the Puzzle Ranked key.
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].gameKey, "solitaire-puzzle");
  assert.equal(settlement.rating[0].matchId, session.id);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.trophy[0].gameKey, "solitaire-puzzle");
});

test("tie-break: equal solves go to the earlier server-stamped final solve", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 2;
  row.p2Solved = 2;
  row.p1LastSolveAt = new Date(NOW - 30_000);
  row.p2LastSolveAt = new Date(NOW - 10_000);

  const read = await store.fetchPuzzleSession({ userId: BOB, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);
  assert.equal(read.view.result.result, "player1");
  assert.equal(read.view.result.resolutionReason, "deadline");
  assert.equal(read.view.result.player1.lastSolveAtMs, NOW - 30_000);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
});

test("tie-break: an exact tie is a draw and neither seat is fabricated as winner", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 0;
  row.p2Solved = 0;

  const read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);
  assert.equal(read.view.result.result, "draw");
  assert.equal(read.view.result.winnerSeat, null);
  assert.equal(row.winnerId, null);

  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].result, "draw");
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.trophy[0].result, "draw");
});

test("deadline: a late move is refused, and the timeout result settles exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 1;
  row.p2Solved = 0;

  const late = await store.submitPuzzleMove({
    userId: BOB,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });
  assert.equal(late.status, 409);
  assert.match(late.error, /deadline/i);
  assert.equal(row.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(row.p2Ply, 0, "the late move was never applied");
  assert.equal(settlement.rating.length, 1);

  // Reading the settled row again must not settle it a second time.
  await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW + 1 });
  await store.fetchPuzzleSession({ userId: BOB, sessionId: session.id, nowMs: NOW + 2 });
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);
});

test("abandonment: a forfeit awards the opponent the match, once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const conceded = await store.forfeitPuzzleSession({
    userId: BOB,
    sessionId: session.id,
    nowMs: NOW,
  });
  assert.equal("error" in conceded, false, conceded.error);
  assert.equal(conceded.view.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(conceded.view.result.result, "player1");
  assert.equal(conceded.view.result.resolutionReason, "forfeit");

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);

  const again = await store.forfeitPuzzleSession({
    userId: BOB,
    sessionId: session.id,
    nowMs: NOW + 1,
  });
  assert.equal("error" in again, false, again.error);
  assert.equal(settlement.rating.length, 1, "a second forfeit cannot re-settle");
});

test("settlement: guests and practice never touch the ladder", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // A guest match settles nothing (there is no account behind either seat).
  const guest = await store.createPuzzleSessionRecord({
    mode: "ranked",
    player1Id: "guest_aaaa",
    player2Id: "guest_bbbb",
    seed: SEED,
    nowMs: NOW,
    status: PUZZLE_SESSION_STATUS.PLAYING,
    deadlineAtMs: NOW + PUZZLE_SESSION_DEADLINE_MS,
  });
  fake.rowsOf(solitairePuzzleSessions)[0].deadlineAt = new Date(NOW - 1_000);
  await store.fetchPuzzleSession({ userId: "guest_aaaa", sessionId: guest.id, nowMs: NOW });
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);

  // A practice/AI session settles nothing either.
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;
  const practice = await store.createAiPuzzleSession({
    userId: ALICE,
    nowMs: NOW,
    seed: SEED,
    manifest: manifestFromIds([SAMPLE.id]),
  });
  let ply = 0;
  for (const move of SAMPLE.spec.solutions[0]) {
    await store.submitPuzzleMove({
      userId: ALICE,
      sessionId: practice.id,
      move,
      expectedPly: ply,
      nowMs: NOW + ply,
    });
    ply += 1;
  }
  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

// ── 4. Reconnect, progress sync and duplicate protection ────────────────

test("reconnect: queue reads restore the SAME live match and its progress", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const matchmaking = await loadMatchmaking();
  const session = await rankedPair(store, { manifest: manifestFromIds([SAMPLE.id]) });

  // The fixture's start state is a deep position, so its ply is not zero; the
  // reload must preserve whatever the server held, plus the one new move.
  const before = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: session.id,
    nowMs: NOW + 50,
  });
  assert.equal("error" in before, false, before.error);
  const startPly = before.view.ply;

  // One accepted move stands in for progress made before a refresh.
  const accepted = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: SAMPLE.spec.solutions[0][0],
    expectedPly: 0,
    nowMs: NOW + 100,
  });
  assert.equal("error" in accepted, false, accepted.error);

  for (const userId of [ALICE, BOB]) {
    const queue = await matchmaking.getPuzzleRankedQueue({ userId, nowMs: NOW + 200 });
    assert.equal(queue.sessionId, session.id, `${userId} is restored to the same match`);
    assert.equal(queue.status, PUZZLE_SESSION_STATUS.PLAYING);
    assert.equal(queue.waiting, false);
    assert.equal(queue.alreadyActive, true);
    assert.equal(queue.deadlineAtMs, session.deadlineAtMs, "the shared clock is unchanged");
  }

  // The restored board is the server's board, with its accepted ply intact.
  const restored = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: session.id,
    nowMs: NOW + 300,
  });
  assert.equal("error" in restored, false, restored.error);
  assert.equal(accepted.view.ply, startPly + 1);
  assert.equal(restored.view.ply, startPly + 1);
  assert.equal(restored.view.puzzleNumber, 1);
  assert.equal(fake.rowsOf(solitairePuzzleSessions).length, 1, "reconnect never opens a second row");
});

test("progress: a solve is visible to the opponent only as a count", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store, {
    manifest: manifestFromIds([SAMPLE.id, SAMPLE2.id]),
  });

  const bobBefore = await store.fetchPuzzleSession({
    userId: BOB,
    sessionId: session.id,
    nowMs: NOW,
  });
  assert.equal("error" in bobBefore, false, bobBefore.error);

  let ply = 0;
  for (const move of SAMPLE.spec.solutions[0]) {
    const moved = await store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move,
      expectedPly: ply,
      nowMs: NOW + ply * 100,
    });
    assert.equal("error" in moved, false, moved.error);
    ply += 1;
  }

  const alice = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: session.id,
    nowMs: NOW + 2_000,
  });
  const bob = await store.fetchPuzzleSession({
    userId: BOB,
    sessionId: session.id,
    nowMs: NOW + 2_000,
  });
  assert.equal("error" in alice, false, alice.error);
  assert.equal("error" in bob, false, bob.error);

  assert.equal(alice.view.solvedCount, 1);
  assert.equal(alice.view.puzzleNumber, 2, "solving advances the solver to the next position");
  assert.equal(bob.view.solvedCount, 0);
  assert.equal(bob.view.puzzleNumber, 1, "the opponent's board is untouched");
  assert.equal(bob.view.opponentSolvedCount, 1, "the opponent sees the count, not the board");
  assert.equal(
    bob.view.ply,
    bobBefore.view.ply,
    "the opponent's own cursor never moves when the other seat plays",
  );
  assert.equal(alice.view.ply, SAMPLE.spec.solutions[0].length);
  assert.equal(alice.view.deadlineAtMs, bob.view.deadlineAtMs);

  // Bob's OWN board is present; Alice's board and the set are not.
  assert.ok(Array.isArray(bob.view.board.tableau));
  const bobJson = JSON.stringify(bob.view);
  for (const hidden of ["startState", "manifest", "selectionSeed", "solutions", "p1State", "p2State"]) {
    assert.equal(bobJson.includes(`"${hidden}"`), false, `${hidden} leaked to the opponent`);
  }
  assert.equal("opponentBoard" in bob.view, false);
});

test("duplicate submission: one move is applied, the retry is refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store, { manifest: manifestFromIds([SAMPLE.id]) });

  const move = SAMPLE.spec.solutions[0][0];
  const [first, second] = await Promise.all([
    store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move,
      expectedPly: 0,
      nowMs: NOW + 100,
    }),
    store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move,
      expectedPly: 0,
      nowMs: NOW + 100,
    }),
  ]);

  const outcomes = [first, second];
  assert.equal(outcomes.filter((entry) => !("error" in entry)).length, 1);
  const refused = outcomes.find((entry) => "error" in entry);
  assert.equal(refused.status, 409);
  assert.match(refused.error, /ply|already/i);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.p1Ply, 1, "the cursor advanced exactly once");
  const log = fake.rowsOf(solitairePuzzleSessionMoves).filter((entry) => entry.seat === "player1");
  assert.equal(log.length, 1, "the move log holds one row for the ply");

  // A third tab still on the old board is refused with a stale cursor, not applied.
  const stale = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move,
    expectedPly: 0,
    nowMs: NOW + 200,
  });
  assert.equal(stale.status, 409);
  assert.match(stale.error, /stale/i);
});

test("settlement: concurrent reads after the deadline settle exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 2;
  row.p2Solved = 1;
  row.p1LastSolveAt = new Date(NOW - 20_000);

  // Both players reconnecting at once must not double-award.
  const [a, b] = await Promise.all([
    store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW }),
    store.fetchPuzzleSession({ userId: BOB, sessionId: session.id, nowMs: NOW }),
  ]);
  assert.equal("error" in a, false, a.error);
  assert.equal("error" in b, false, b.error);
  assert.equal(a.view.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(settlement.rating.length, 1, "the shared writers ran once");
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.rating[0].matchId, session.id);
  assert.equal(settlement.rating[0].gameKey, "solitaire-puzzle");
});

// ── 5. History ────────────────────────────────────────────────────────────

test("history: both seats read the same result, each with their OWN reward", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 2;
  row.p2Solved = 1;
  row.p1LastSolveAt = new Date(NOW - 20_000);

  await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW });
  assert.equal(settlement.rating.length, 1);

  fake.state.ratingRows = [{ matchId: session.id, delta: 24 }];
  fake.state.trophyRows = [{ matchId: session.id, delta: 30 }];

  const forAlice = await store.listPuzzleRankedHistory({ userId: ALICE, nowMs: NOW });
  assert.equal(forAlice.length, 1);
  assert.equal(forAlice[0].sessionId, session.id);
  assert.equal(forAlice[0].seat, "player1");
  assert.equal(forAlice[0].youSolved, 2);
  assert.equal(forAlice[0].opponentSolved, 1);
  assert.equal(forAlice[0].opponentId, BOB);
  assert.equal(forAlice[0].result.result, "player1");
  assert.deepEqual(forAlice[0].result.reward, { ratingDelta: 24, trophiesDelta: 30 });

  const forBob = await store.listPuzzleRankedHistory({ userId: BOB, nowMs: NOW });
  assert.equal(forBob.length, 1);
  assert.equal(forBob[0].seat, "player2");
  assert.equal(forBob[0].youSolved, 1);
  assert.equal(forBob[0].opponentSolved, 2);

  const forStranger = await store.listPuzzleRankedHistory({ userId: MALLORY, nowMs: NOW });
  assert.equal(forStranger.length, 0, "history is authorised by stored seat");
});

test("history: hidden match data never reaches the payload", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await rankedPair(store);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.status = PUZZLE_SESSION_STATUS.FINISHED;
  row.result = "draw";
  row.resolutionReason = "draw";
  row.endedAt = new Date(NOW);

  const [entry] = await store.listPuzzleRankedHistory({ userId: ALICE, nowMs: NOW });
  const json = JSON.stringify(entry);
  for (const key of [
    "manifest",
    "startState",
    "selectionSeed",
    "p1State",
    "p2State",
    "solutions",
    "verification",
  ]) {
    assert.equal(json.includes(`"${key}"`), false, `${key} must not be in a history entry`);
  }
  assert.equal(entry.opponentId, BOB, "the opponent is named; their board is not");
  assert.equal(settlement.rating.length, 0, "a terminal row is not re-settled by a read");
  assert.equal(session.id, entry.sessionId);
});
