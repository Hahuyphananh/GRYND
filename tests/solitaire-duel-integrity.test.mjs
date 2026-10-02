/**
 * solitaire-duel-integrity.test.mjs
 *
 * COMPETITIVE-INTEGRITY AUDIT. Where `solitaire-duel-store.test.mjs` proves the
 * happy-path invariants, this file is adversarial: it tries to beat the game and
 * watches the server refuse.
 *
 * The five claims under attack:
 *
 *   1. IDENTICAL PUZZLE — both seats start from one deal, and that holds across
 *      many matches (not just one lucky seed).
 *   2. SERVER AUTHORITY — a client may smuggle a winner, a result, a score, a
 *      progress figure, a completion, an Elo delta or a trophy into a request;
 *      none of it is read, and nothing settles without a server-detected event.
 *   3. MOVE VALIDATION — every class of illegal Klondike action is refused, and
 *      a refused move mutates NOTHING.
 *   4. ONE AUTHORITATIVE RESULT — concurrent completions, duplicate submits, a
 *      completion at the deadline and every disconnect permutation each produce
 *      exactly one result and exactly one settlement.
 *   5. NO FORGED REALTIME EVENTS — the socket layer cannot be used to inject the
 *      server-authority events, and the client refuses payloads for other
 *      matches (static, because it lives in the socket server / the client).
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/solitaire-duel-store.test.mjs: a fake Drizzle
 * client that ignores WHERE clauses (so each scenario seeds exactly the one row
 * it means to act on), with updates persisted. The store is loaded LAZILY so
 * `t.mock.module` can intercept its dependencies, and the ONE shared fake is
 * reset before each test — the store module is cached for the whole file.
 * Adds a `users`-table read so a win's counter writes can be asserted.
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/solitaire-duel-integrity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";

import {
  solitaireDuelMatches,
  solitaireDuelMoves,
  users,
} from "../src/db/schema.ts";
import {
  COMPLETION_DEAD_HEAT_MS,
  INACTIVITY_FORFEIT_MS,
  MATCH_STATUS,
  SUITS,
  VARIANT,
  VARIANT_VERSION,
} from "../src/lib/solitaire-duel/constants.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import {
  applyMove,
  compareProgress,
  initialStateFromDeal,
  normalizeMove,
  progressOf,
  resolveRace,
} from "../src/lib/solitaire-duel/rules.ts";
import { deriveDealSeed, getServerSeedHash } from "../src/lib/solitaire-duel/seeds.js";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:solitaire-duel";

const MATCH_ID = "88888888-8888-4888-8888-888888888888";
const ALICE = "user_alice";
const BOB = "user_bob";
const NOW = 1_800_000_000_000;

const SERVER_SEED = "ab".repeat(32);
const DEAL_SEED = deriveDealSeed({ serverSeed: SERVER_SEED, variantVersion: VARIANT_VERSION });
const DEAL = dealFromSeed(DEAL_SEED);

const card = (suit, rank) => ({ suit, rank });
const openBoard = () => initialStateFromDeal(DEAL);

/** A board with exactly `count` cards on the foundations (suits filled in order). */
function boardWithFoundationCards(count) {
  const state = openBoard();
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };
  let remaining = count;
  for (const suit of SUITS) {
    const take = Math.min(13, remaining);
    state.foundations[suit] = Array.from({ length: take }, (_, index) => card(suit, index + 1));
    remaining -= take;
  }
  state.peakFoundation = count;
  return state;
}

/** A board one legal move from a full solve: K♣ sits alone on tableau column 0. */
function boardOneMoveFromComplete() {
  const state = boardWithFoundationCards(51);
  state.tableau[0] = [{ card: card("clubs", 13), faceUp: true }];
  return state;
}

const FINAL_MOVE = {
  kind: "tableau-to-foundation",
  fromColumn: 0,
  card: { suit: "clubs", rank: 13 },
  suit: "clubs",
};

/** A deliberately crafted, minimal board for the illegal-move matrix. */
function craftedBoard() {
  const state = openBoard();
  state.tableau = [[], [], [], [], [], [], []];
  state.stock = [];
  state.waste = [];
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };
  state.tableau[0] = [{ card: card("spades", 1), faceUp: true }]; // an exposed Ace
  state.tableau[1] = []; // an empty column (Kings only)
  state.tableau[2] = [{ card: card("hearts", 13), faceUp: false }]; // hidden King
  state.tableau[3] = [
    { card: card("spades", 10), faceUp: true },
    { card: card("hearts", 5), faceUp: true }, // a broken run
  ];
  state.tableau[4] = [{ card: card("spades", 13), faceUp: true }]; // K♠
  state.tableau[5] = [{ card: card("hearts", 13), faceUp: true }]; // K♥ (same colour)
  return state;
}

// ── The fake database ─────────────────────────────────────────────────────

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = { tables: new Map(), nextId: 1, transactions: 0, writes: [] };

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
        Promise.resolve(rowsOf(table).map((row) => ({ ...row }))).then(resolve, reject),
    };
    return q;
  };

  const update = (table) => {
    let values = null;
    const b = {
      set(v) {
        values = v;
        return b;
      },
      where: () => b,
      returning: () => {
        state.writes.push({ table, op: "update", values });
        for (const row of rowsOf(table)) {
          for (const [key, value] of Object.entries(values)) {
            row[key] = isSqlExpression(value) ? (Number(row[key]) || 0) + 1 : value;
          }
        }
        return Promise.resolve(rowsOf(table).map((row) => ({ ...row })));
      },
      then: (resolve, reject) => b.returning().then(resolve, reject),
    };
    return b;
  };

  const insert = (table) => ({
    values: (v) => {
      const row = { id: `row-${state.nextId++}`, createdAt: new Date(), ...v };
      state.writes.push({ table, op: "insert", values: v });
      rowsOf(table).push(row);
      const out = { returning: () => Promise.resolve([{ ...row }]) };
      out.then = (resolve, reject) => Promise.resolve([{ ...row }]).then(resolve, reject);
      return out;
    },
  });

  const tx = {
    select,
    update,
    insert,
    execute: async () => undefined,
  };

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.writes = [];
  };

  return {
    state,
    reset,
    rowsOf,
    db: {
      transaction: async (fn) => {
        state.transactions += 1;
        return fn(tx);
      },
      select,
      update,
      insert,
    },
  };
}

let sharedFake = null;
const settlement = { rating: [], trophy: [], queue: [] };

function resetAll(fake) {
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;
  settlement.queue.length = 0;
}

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  resetAll(fake);

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });
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
  t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
    namedExports: {
      mirrorQueueCreated: (args) => settlement.queue.push({ kind: "created", ...args }),
      mirrorQueueTransition: (args) => settlement.queue.push({ kind: "transition", ...args }),
    },
  });
  return fake;
}

const loadStore = () => import("../src/lib/solitaire-duel/serverStore.ts");

/** Seed one match row directly, in whatever lifecycle the scenario needs. */
function seedMatch(fake, overrides = {}) {
  const board = openBoard();
  const row = {
    id: MATCH_ID,
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    status: MATCH_STATUS.PLAYING,
    result: null,
    resolutionReason: null,
    serverSeed: SERVER_SEED,
    serverSeedHash: getServerSeedHash(SERVER_SEED),
    dealSeed: DEAL_SEED,
    deal: DEAL,
    p1State: board,
    p2State: structuredClone(board),
    p1Ply: 0,
    p2Ply: 0,
    p1PeakFoundation: 0,
    p2PeakFoundation: 0,
    p1Revealed: 7,
    p2Revealed: 7,
    p1FinishedAt: null,
    p2FinishedAt: null,
    goAt: new Date(NOW - 5_000),
    startedAt: new Date(NOW - 5_000),
    endedAt: null,
    createdAt: new Date(NOW - 6_000),
    updatedAt: new Date(NOW - 6_000),
    ...overrides,
  };
  // Keep each board's own cursor in step with its denormalised column, the way
  // a real write does (the state is the source of truth).
  if (row.p1State) row.p1State = { ...row.p1State, ply: row.p1Ply };
  if (row.p2State) row.p2State = { ...row.p2State, ply: row.p2Ply };
  fake.rowsOf(solitaireDuelMatches).push(row);
  return row;
}

const rowOf = (fake) => fake.rowsOf(solitaireDuelMatches)[0];
const usersWrites = (fake) => fake.state.writes.filter((write) => write.table === users);

// ══════════════════════════════════════════════════════════════════════════
// 1. IDENTICAL PUZZLE — across many matches, not just one seed
// ══════════════════════════════════════════════════════════════════════════

test("identical puzzle: every match hands both seats the SAME board, and different matches differ", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const samples = [];
  for (let index = 0; index < 4; index += 1) {
    resetAll(fake);
    const { match } = await store.createOrJoin({ userId: `player_${index}`, nowMs: NOW + index });
    samples.push(match);
  }

  for (const match of samples) {
    // Identical tableau, ordering, face-up flags and stock — both seats.
    assert.deepEqual(match.p1State, match.p2State, "both seats share one opening position");
    assert.deepEqual(match.p1State, initialStateFromDeal(match.deal));
    assert.equal(match.deal.stock.length, 24);
    assert.deepEqual(
      match.deal.tableau.map((column) => column.length),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(match.deal.tableau.flat().filter((pile) => pile.faceUp).length, 7);
    // The seed pair is the committed one.
    assert.equal(match.serverSeedHash, getServerSeedHash(match.serverSeed));
    assert.equal(
      match.dealSeed,
      deriveDealSeed({ serverSeed: match.serverSeed, variantVersion: VARIANT_VERSION }),
    );
  }

  // Distinct seeds, distinct deals: no two matches share a puzzle.
  assert.equal(new Set(samples.map((match) => match.serverSeed)).size, samples.length);
  assert.equal(new Set(samples.map((match) => JSON.stringify(match.deal))).size, samples.length);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. SERVER AUTHORITY — no client value can settle, score or rate a match
// ══════════════════════════════════════════════════════════════════════════

test("authority: a move cannot smuggle a result, a score, a completion, an Elo or a trophy", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const lies = {
    // ...on the request object itself
    winnerId: ALICE,
    winner: "player1",
    result: "player1",
    elo: 999,
    eloDelta: 999,
    trophies: 50,
    trophyDelta: 50,
    score: 52,
    progressPercent: 100,
    completed: true,
    completedAtMs: NOW,
    // ...and inside the move payload, which is the only field that is read
    move: {
      kind: "draw",
      winner: "player1",
      result: "player1",
      elo: 999,
      progressPercent: 100,
      completed: true,
      foundations: { spades: Array.from({ length: 13 }, (_, i) => card("spades", i + 1)) },
    },
    expectedPly: 0,
  };

  const result = await store.submitMove({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW, ...lies });
  assert.ok(!("error" in result), "the well-formed move itself is accepted");

  const row = rowOf(fake);
  // The board is EXACTLY the engine's result of the one legal move — nothing
  // the payload claimed could reach it.
  assert.deepEqual(row.p1State, applyMove({ state: openBoard(), move: { kind: "draw" } }).state);
  assert.equal(row.p1State.ply, 1);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(row.result, null, "no result was accepted");
  assert.equal(row.winnerId, null, "no winner was accepted");
  assert.equal(row.resolutionReason, null);
  assert.ok(!row.endedAt, "the match did not end");
  // ...and nothing settled.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  assert.equal(usersWrites(fake).length, 0);
});

test("authority: a move is refused before GO and after the inactivity threshold, mutating nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // Before GO.
  seedMatch(fake);
  const before = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW - 60_000, // the row's go_at is NOW - 5s
  });
  assert.equal(before.status, 409);
  assert.equal(rowOf(fake).p1State.ply, 0);
  assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0);

  // A seat past the inactivity threshold: refused, and the row resolves from
  // its own boards (the idle seat forfeits).
  resetAll(fake);
  seedMatch(fake, {
    p1State: boardWithFoundationCards(20),
    p2State: boardWithFoundationCards(5),
    p1Ply: 40,
    p2Ply: 30,
    p1LastActionAt: new Date(NOW - INACTIVITY_FORFEIT_MS - 1),
    p2LastActionAt: new Date(NOW),
  });
  const late = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: 40,
    nowMs: NOW,
  });
  assert.equal(late.status, 409);
  assert.match(late.error, /inactivity/i);
  const settled = rowOf(fake);
  assert.equal(settled.status, MATCH_STATUS.FINISHED);
  assert.equal(settled.result, "player2", "the idle seat forfeited");
  assert.equal(settled.resolutionReason, "forfeit");
  assert.equal(settled.p1State.ply, 40, "the refused move was never applied");
  assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. MOVE VALIDATION — every illegal class is refused and mutates nothing
// ══════════════════════════════════════════════════════════════════════════

test("validation: every illegal move class is refused with 422 and zero mutation", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const illegal = [
    ["a non-King onto an empty column", { kind: "tableau-to-tableau", fromColumn: 0, card: card("spades", 1), toColumn: 1 }],
    ["a card that is not in the named column", { kind: "tableau-to-tableau", fromColumn: 0, card: card("hearts", 1), toColumn: 1 }],
    ["a card onto the wrong foundation suit", { kind: "tableau-to-foundation", fromColumn: 0, card: card("spades", 1), suit: "hearts" }],
    ["a FACE-DOWN card (it has no address)", { kind: "tableau-to-tableau", fromColumn: 2, card: card("hearts", 13), toColumn: 1 }],
    ["a broken multi-card run", { kind: "tableau-to-tableau", fromColumn: 3, card: card("spades", 10), toColumn: 1 }],
    ["a same-colour King on a King", { kind: "tableau-to-tableau", fromColumn: 4, card: card("spades", 13), toColumn: 5 }],
    ["a draw with an empty stock AND waste", { kind: "draw" }],
    ["a waste move with an empty waste", { kind: "waste-to-foundation", suit: "spades" }],
    ["a foundation move from an empty foundation", { kind: "foundation-to-tableau", suit: "clubs", toColumn: 0 }],
    ["a malformed move (unknown kind)", { kind: "teleport", fromColumn: 0, toColumn: 1 }],
  ];

  for (const [label, move] of illegal) {
    resetAll(fake);
    const board = craftedBoard();
    seedMatch(fake, { p1State: board, p2State: structuredClone(board) });
    const snapshot = JSON.stringify(rowOf(fake));

    const result = await store.submitMove({
      userId: ALICE,
      matchId: MATCH_ID,
      move,
      expectedPly: 0,
      nowMs: NOW,
    });

    assert.ok("error" in result, `${label}: must be refused`);
    assert.ok([400, 422].includes(result.status), `${label}: refused with 400/422, got ${result.status}`);
    assert.equal(JSON.stringify(rowOf(fake)), snapshot, `${label}: the row must be untouched`);
    assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0, `${label}: no move may be logged`);
    assert.equal(settlement.rating.length, 0, `${label}: nothing may settle`);
  }

  // Positive control: the same crafted board DOES accept its one legal move,
  // so the matrix above is proving refusal, not a dead board.
  resetAll(fake);
  const board = craftedBoard();
  seedMatch(fake, { p1State: board, p2State: structuredClone(board) });
  const legal = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "tableau-to-foundation", fromColumn: 0, card: card("spades", 1), suit: "spades" },
    expectedPly: 0,
    nowMs: NOW,
  });
  assert.ok(!("error" in legal), "the Ace of spades opens its foundation");
  assert.equal(rowOf(fake).p1State.foundations.spades.length, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. ONE AUTHORITATIVE RESULT — races, duplicates, deadlines, disconnects
// ══════════════════════════════════════════════════════════════════════════

test("race: two seats completing concurrently settle exactly once, for the first to commit", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  seedMatch(fake, {
    p1State: boardOneMoveFromComplete(),
    p2State: boardOneMoveFromComplete(),
    p1Ply: 100,
    p2Ply: 90,
  });

  const first = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: FINAL_MOVE,
    expectedPly: 100,
    nowMs: NOW,
  });
  assert.ok(!("error" in first));
  assert.equal(first.raceResolved, true);
  assert.equal(first.completed, true);

  // The second seat's completion arrives against an already-settled match.
  const second = await store.submitMove({
    userId: BOB,
    matchId: MATCH_ID,
    move: FINAL_MOVE,
    expectedPly: 90,
    nowMs: NOW,
  });
  assert.equal(second.status, 409, "a later completion cannot steal the result");
  assert.match(second.error, /no longer active/i);

  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.winnerId, ALICE);
  assert.equal(row.resolutionReason, "finish");
  assert.equal(settlement.rating.length, 1, "settled exactly once");
  assert.equal(settlement.trophy.length, 1, "settled exactly once");
  assert.equal(usersWrites(fake).length, 2, "one win and one loss counter write");
});

test("race: a duplicate completion submit settles once and is refused the second time", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { p1State: boardOneMoveFromComplete(), p1Ply: 100 });

  const once = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: FINAL_MOVE,
    expectedPly: 100,
    nowMs: NOW,
  });
  assert.ok(!("error" in once));

  const twice = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: FINAL_MOVE,
    expectedPly: 101,
    nowMs: NOW + 5,
  });
  assert.equal(twice.status, 409);

  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);
  assert.equal(rowOf(fake).result, "player1");
});

test("race: a dead heat on the completion instant is a draw — the tie-break ladder is pure", () => {
  const seat = (completedAtMs, foundationCards) => ({
    userId: null,
    ply: 100,
    progress: { foundationCards, revealedTableau: 28, progressPercent: 0 },
    completedAtMs,
    forfeited: false,
  });

  // Same instant → draw.
  assert.deepEqual(
    resolveRace({ player1: seat(1_000, 52), player2: seat(1_000, 52) }),
    { result: "draw", resolution: "draw" },
  );
  // Inside the dead-heat window → draw.
  assert.deepEqual(
    resolveRace({ player1: seat(1_000, 52), player2: seat(1_000 + COMPLETION_DEAD_HEAT_MS - 1, 52) }),
    { result: "draw", resolution: "draw" },
  );
  // Outside it → the earlier instant wins.
  assert.deepEqual(
    resolveRace({ player1: seat(1_000, 52), player2: seat(1_000 + COMPLETION_DEAD_HEAT_MS + 1, 52) }),
    { result: "player1", resolution: "finish" },
  );
  // A forfeit outranks even a completed board.
  assert.equal(
    resolveRace({ player1: seat(1_000, 52), player2: { ...seat(null, 0), forfeited: true } }).result,
    "player1",
  );
  // The deadline ladder prefers foundations, then revealed cards, then a draw.
  assert.equal(compareProgress({ foundationCards: 30, revealedTableau: 20 }, { foundationCards: 29, revealedTableau: 28 }), 1);
  assert.equal(compareProgress({ foundationCards: 20, revealedTableau: 25 }, { foundationCards: 20, revealedTableau: 22 }), 1);
  assert.equal(compareProgress({ foundationCards: 20, revealedTableau: 22 }, { foundationCards: 20, revealedTableau: 22 }), 0);
});

test("disconnect: either seat leaving forfeits the match to the other, exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // P1 leaves → P2 wins.
  seedMatch(fake);
  const p1Leaves = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(p1Leaves.forfeited, true);
  assert.equal(rowOf(fake).result, "player2");
  assert.equal(settlement.rating.length, 1);

  // P2 leaves → P1 wins, EVEN IF P2 was far ahead on the board.
  resetAll(fake);
  seedMatch(fake, { p2State: boardWithFoundationCards(40), p2Ply: 80 });
  const p2Leaves = await store.forfeitMatchOnDisconnect({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(p2Leaves.forfeited, true);
  assert.equal(rowOf(fake).result, "player1", "leaving is a loss whoever was ahead");
  assert.equal(settlement.rating.length, 1);

  // P1 leaves while ahead → P1 still loses.
  resetAll(fake);
  seedMatch(fake, { p1State: boardWithFoundationCards(45), p1Ply: 90 });
  await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(rowOf(fake).result, "player2");
});

test("disconnect: both seats leaving, an empty lobby and a settled match each settle exactly once (or not at all)", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // Both leave: the first call settles, the second is a terminal no-op.
  seedMatch(fake);
  await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  const afterFirst = settlement.rating.length;
  const second = await store.forfeitMatchOnDisconnect({ userId: BOB, matchId: MATCH_ID, nowMs: NOW + 1 });
  assert.deepEqual(
    { forfeited: second.forfeited, cancelled: second.cancelled },
    { forfeited: false, cancelled: false },
  );
  assert.equal(settlement.rating.length, afterFirst, "a terminal match never settles twice");
  assert.equal(settlement.trophy.length, 1);

  // An open lobby: released, never settled.
  resetAll(fake);
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null, goAt: null });
  const lobby = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(lobby.cancelled, true);
  assert.equal(lobby.forfeited, false);
  assert.equal(rowOf(fake).status, MATCH_STATUS.CANCELLED);
  assert.equal(settlement.rating.length, 0);
  assert.equal(usersWrites(fake).length, 0);

  // An already-finished match: reported, not an error, nothing written.
  resetAll(fake);
  seedMatch(fake, { status: MATCH_STATUS.FINISHED, result: "player1", endedAt: new Date(NOW - 10) });
  const done = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.deepEqual(
    { forfeited: done.forfeited, cancelled: done.cancelled },
    { forfeited: false, cancelled: false },
  );
  assert.equal(settlement.rating.length, 0);
  assert.equal(usersWrites(fake).length, 0);
});

test("disconnect: a non-participant cannot resolve a match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const outsider = await store.forfeitMatchOnDisconnect({
    userId: "user_mallory",
    matchId: MATCH_ID,
    nowMs: NOW,
  });
  assert.equal(outsider.status, 403);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
  assert.equal(settlement.rating.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 5. REMATCH — a new match is a new row, a new seed, and no carried settlement
// ══════════════════════════════════════════════════════════════════════════

test("rematch: create-or-join and cancel never settle, and every new match gets a new deal", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const first = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  assert.equal(settlement.rating.length, 0, "opening a lobby settles nothing");
  assert.equal(usersWrites(fake).length, 0);

  // The host cancelling their own open lobby must not settle either.
  const cancelled = await store.cancelMatch({ userId: ALICE, matchId: first.match.id, nowMs: NOW });
  assert.ok(!("error" in cancelled));
  assert.equal(settlement.rating.length, 0);
  assert.equal(usersWrites(fake).length, 0);

  // A rematch is a NEW row whose deal is derived from a NEW seed — no reuse of
  // the previous puzzle. (The fake cannot evaluate WHERE, so the previous row is
  // cleared first; each create is therefore a genuinely fresh match.)
  resetAll(fake);
  const rematch = await store.createOrJoin({ userId: ALICE, nowMs: NOW + 10_000 });
  assert.notEqual(rematch.match.serverSeed, first.match.serverSeed);
  assert.notEqual(rematch.match.dealSeed, first.match.dealSeed);
  assert.notDeepEqual(rematch.match.deal, first.match.deal);
  assert.notDeepEqual(rematch.match.p1State, first.match.p1State);
  // And the new match starts from ITS OWN deal, not the old board.
  assert.deepEqual(rematch.match.p1State, initialStateFromDeal(rematch.match.deal));
  assert.deepEqual(rematch.match.p1State, rematch.match.p2State);
  assert.equal(settlement.rating.length, 0, "a rematch carries no settlement across");
});

test("rematch: a settled match is never settled a second time by a re-read", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { p1State: boardOneMoveFromComplete(), p1Ply: 100 });

  await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: FINAL_MOVE, expectedPly: 100, nowMs: NOW });
  assert.equal(settlement.rating.length, 1);

  // Reads, an inactivity sweep and a disconnect all see a terminal row.
  await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW + 1 });
  await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW + 60_000 });
  await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW + 2 });

  assert.equal(settlement.rating.length, 1, "exactly one settlement, ever");
  assert.equal(settlement.trophy.length, 1);
  assert.equal(usersWrites(fake).length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 6. REALTIME HARDENING — no forged server event; the client only trusts its
//    own match (static, because it lives in the socket server and the client)
// ══════════════════════════════════════════════════════════════════════════

test("realtime: the generic room_event relay drops every reserved Solitaire Duel server event", () => {
  const source = readFileSync(new URL("../realtime-server/server.js", import.meta.url), "utf8");
  const handlerStart = source.indexOf('socket.on("room_event"');
  const relayAt = source.indexOf("socket.to(String(roomId)).emit(String(event)", handlerStart);
  assert.ok(handlerStart >= 0, "the generic relay exists");
  assert.ok(relayAt > handlerStart, "the relay emission is after the handler opens");

  // The guard must sit BETWEEN the handler opening and the relay, so a client
  // cannot reach the relay with one of these names.
  const guard = source.slice(handlerStart, relayAt);
  for (const name of [
    "solitaire-duel:opponent-progress",
    "solitaire-duel:countdown",
    "solitaire-duel:match-started",
    "solitaire-duel:match-finished",
  ]) {
    assert.ok(guard.includes(name), `${name} must be reserved in the room_event guard`);
  }
  assert.match(guard, /return;/, "the guard must drop the event before relaying it");
  // `lobby:updated` stays relayable: it is a bare refetch hint every game uses.
  assert.ok(!guard.includes('"lobby:updated"'), "the shared refetch hint must not be reserved");
});

test("realtime: the arena ignores realtime payloads for another match and drops a stale GO override", () => {
  const client = readFileSync(
    new URL("../src/app/casino/solitaire-duel/[matchId]/PageClient.tsx", import.meta.url),
    "utf8",
  );

  // Every accepted realtime payload is checked against this match.
  assert.match(client, /forThisMatch/, "the client must scope realtime payloads to its own match");
  const guarded = client.match(/if \(!forThisMatch\(payload\)\) return;/g) ?? [];
  assert.ok(guarded.length >= 2, "both the countdown and the progress handlers must be guarded");

  // An authoritative snapshot clears any realtime override, so a forged (or
  // merely stale) GO instant cannot pin the board out of play.
  assert.match(client, /if \(snapshot\.goAtMs != null\) setGoAtOverride\(null\)/);

  // The game's client never uses the generic relay — it has a dedicated poke.
  assert.equal(
    /socket\??\.emit\(\s*["']room_event["']/.test(client),
    false,
    "Solitaire Duel must not emit through the generic room_event relay",
  );
});

test("realtime: the reserved event names match the shared vocabulary exactly", () => {
  const source = readFileSync(new URL("../realtime-server/server.js", import.meta.url), "utf8");
  const vocabulary = readFileSync(
    new URL("../src/lib/solitaire-duel/rooms.ts", import.meta.url),
    "utf8",
  );
  for (const name of [
    "solitaire-duel:opponent-progress",
    "solitaire-duel:countdown",
    "solitaire-duel:match-started",
    "solitaire-duel:match-finished",
  ]) {
    assert.ok(source.includes(`"${name}"`), `${name} must be guarded server-side`);
    assert.ok(vocabulary.includes(`"${name}"`), `${name} must be in the shared vocabulary`);
  }
});

// A tiny guard so an unused import cannot silently rot this file.
test("integrity harness: normalizeMove is the shape gate this suite assumes", () => {
  assert.equal(normalizeMove({ kind: "draw" }).ok, true);
  assert.equal(normalizeMove({ kind: "teleport" }).ok, false);
  assert.equal(normalizeMove("draw").ok, false);
});
