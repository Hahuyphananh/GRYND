/**
 * solitaire-duel-store.test.mjs
 *
 * THE AUTHORITATIVE MATCH STORE, driven for real.
 *
 * The model under test, in one line: a client may only ever say WHICH CARDS IT
 * MEANT AND WHERE. The board, the stock order, the face-up/face-down state, the
 * progress, the completion, the completion instant, the winner, the result, the
 * rating change and the trophies are all derived by the server from its own
 * state. So most of what these tests do is try to make the store accept
 * something a client is not allowed to decide — and watch it refuse, or ignore
 * the claim and derive the truth anyway.
 *
 * The three fairness properties this file exists to prove:
 *
 *   1. ONE deal per match: `createOrJoin` mints a seed, commits its hash and
 *      derives one deal; BOTH seats are written from it, and joining never
 *      regenerates anything.
 *   2. SEAT ISOLATION: a seat's move writes only that seat's columns. The other
 *      seat's board is byte-identical afterwards.
 *   3. SERVER-DERIVED SETTLEMENT: progress, completion and the winner come from
 *      the boards, and the shared writers are called exactly once with the
 *      canonical literal `gameKey: "solitaire-duel"`.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/tic-tac-toe-store.test.mjs and
 * tests/speed-typing-store.test.mjs: a fake Drizzle client that ignores WHERE
 * clauses (every store read targets the one match row under test), so each
 * scenario seeds exactly the rows it means to act on. Updates persist, so a read
 * after a write observes the new state the way a real transaction would.
 *
 * The store module is cached for the whole file, so every test must be mocked
 * with THE SAME fake — a fresh instance per test would leave the cached module
 * pointing at the first one. The one fake is reset before each test instead. The
 * store is loaded LAZILY (never with a static import) so `t.mock.module` can
 * still intercept its dependencies.
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/solitaire-duel-store.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import {
  solitaireDuelMatches,
  solitaireDuelMoves,
  users,
} from "../src/db/schema.ts";
import {
  INACTIVITY_ALARM_MS,
  INACTIVITY_FORFEIT_MS,
  MATCH_STATUS,
  MAX_MOVES_PER_SEAT,
  READY_COUNTDOWN_MS,
  SOLITAIRE_DUEL_AI_PLAYER_ID,
  SUITS,
  VARIANT,
  VARIANT_VERSION,
} from "../src/lib/solitaire-duel/constants.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import {
  isDealSolvable,
  solvableDealFromSeed,
} from "../src/lib/solitaire-duel/solvable.ts";
import { initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { deriveDealSeed, getServerSeedHash } from "../src/lib/solitaire-duel/seeds.js";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:solitaire-duel";

const MATCH_ID = "88888888-8888-4888-8888-888888888888";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const NOW = 1_800_000_000_000;

const SERVER_SEED = "ab".repeat(32);
const DEAL_SEED = deriveDealSeed({ serverSeed: SERVER_SEED, variantVersion: VARIANT_VERSION });
const DEAL = dealFromSeed(DEAL_SEED);

const card = (suit, rank) => ({ suit, rank });
const openBoard = () => initialStateFromDeal(DEAL);

/**
 * A board carrying `count` cards on its foundations.
 *
 * Fills suits in order with distinct ascending ranks, so the state stays a
 * plausible Klondike board and the progress metric is exactly `count`.
 */
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

/** Every card identity reachable inside a payload — used to prove nothing leaked. */
function identitiesIn(value) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.suit === "string" && typeof node.rank === "number") {
      found.add(`${node.suit}-${node.rank}`);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child);
  };
  walk(value);
  return found;
}

// ── The fake database ─────────────────────────────────────────────────────

/** A SQL expression object (Drizzle's `sql\`…\``) rather than a literal value. */
const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    writes: [],
    locks: [],
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
            // Counter columns are written as SQL increments; emulate just that
            // one expression so the counter stays a number the reads can use.
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
    execute: async (query) => {
      state.locks.push(query);
    },
  };

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.writes = [];
    state.locks = [];
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

/** Clear the fake database and the recorded settlement calls. */
function resetAll(fake) {
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;
  settlement.queue.length = 0;
}

/**
 * Register the mocks for ONE test context.
 *
 * Node's MockTracker rejects a second `mock.module` for the same specifier on
 * the same tracker, so each test gets its own tracker (`t`) and the ONE shared
 * fake is reset afterwards.
 */
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

// ── Fixtures ──────────────────────────────────────────────────────────────

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
  // Each board's own move cursor must agree with its denormalised column, the
  // way a real write keeps them in step (the state is the source of truth).
  if (row.p1State) row.p1State = { ...row.p1State, ply: row.p1Ply };
  if (row.p2State) row.p2State = { ...row.p2State, ply: row.p2Ply };
  fake.rowsOf(solitaireDuelMatches).push(row);
  return row;
}

/**
 * A board one legal move away from solving the puzzle.
 *
 * `boardWithFoundationCards(51)` fills spades/hearts/diamonds to King and stops
 * clubs at Queen, so the single missing card is K♣ — placed as the only card of
 * tableau column 0.
 */
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

// ── 1. One seed, one deck, one deal ───────────────────────────────────────

test("create-or-join: opens a lobby with ONE seed, ONE deal and two identical boards", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const { match, joined } = await store.createOrJoin({ userId: ALICE, nowMs: NOW });

  assert.equal(joined, false);
  assert.equal(match.status, MATCH_STATUS.WAITING);
  assert.ok(!match.player2Id, "an open lobby has no second seat");
  assert.equal(match.variant, VARIANT);
  assert.equal(match.variantVersion, VARIANT_VERSION);

  // The seed pair: random server entropy, publicly committed.
  assert.match(match.serverSeed, /^[0-9a-f]{64}$/);
  assert.equal(match.serverSeedHash, getServerSeedHash(match.serverSeed));

  // The deal is exactly the one that seed derives.
  assert.equal(
    match.dealSeed,
    deriveDealSeed({ serverSeed: match.serverSeed, variantVersion: VARIANT_VERSION }),
  );
  // ...and it is the VERIFIED, hard deal of that seed (`VARIANT_VERSION` 3),
  // not a plain shuffle.
  assert.deepEqual(match.deal, solvableDealFromSeed(match.dealSeed));
  assert.ok(isDealSolvable(match.deal), "a stored deal must be solvable");

  // A real Klondike opening: 28 in the tableau (1..7 per column), 24 in stock.
  assert.equal(match.deal.tableau.length, 7);
  assert.deepEqual(match.deal.tableau.map((column) => column.length), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(match.deal.stock.length, 24);

  // BOTH seats hold the same board, and it is that deal's opening position.
  assert.deepEqual(match.p1State, match.p2State);
  assert.deepEqual(match.p1State, initialStateFromDeal(match.deal));
  assert.equal(match.p1Ply, 0);
  assert.equal(match.p2Ply, 0);
  assert.equal(match.p1PeakFoundation, 0);
  assert.equal(match.p1Revealed, 7);
  assert.equal(match.p2Revealed, 7);

  // Nothing has started: no clock yet.
  assert.ok(!match.goAt, "a waiting lobby has no GO instant");
  assert.equal(fake.rowsOf(solitaireDuelMatches).length, 1);
});

test("create-or-join: a second caller joins WITHOUT touching the puzzle", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const first = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const serverSeed = first.match.serverSeed;
  const dealSeed = first.match.dealSeed;
  const board = structuredClone(first.match.p1State);

  const second = await store.createOrJoin({ userId: BOB, nowMs: NOW + 1_000 });

  assert.equal(second.joined, true);
  assert.equal(second.match.player2Id, BOB);
  assert.equal(second.match.status, MATCH_STATUS.PLAYING);

  // No new entropy, no new deal, no regenerated board.
  assert.equal(second.match.serverSeed, serverSeed);
  assert.equal(second.match.serverSeedHash, first.match.serverSeedHash);
  assert.equal(second.match.dealSeed, dealSeed);
  assert.deepEqual(second.match.deal, first.match.deal);
  assert.deepEqual(second.match.p1State, board, "seat 1's board must be untouched");
  assert.deepEqual(second.match.p2State, board, "seat 2 starts from the same board");

  // The clock: one absolute GO instant, no match deadline. The match is
  // untimed; both seats' inactivity clocks start at GO instead.
  const goAt = second.match.goAt.getTime();
  assert.equal(goAt, NOW + 1_000 + READY_COUNTDOWN_MS);
  assert.equal(second.match.p1LastActionAt.getTime(), goAt);
  assert.equal(second.match.p2LastActionAt.getTime(), goAt);

  // Re-asking as the host returns the SAME row rather than opening a second.
  const again = await store.createOrJoin({ userId: ALICE, nowMs: NOW + 2_000 });
  assert.equal(again.match.id, first.match.id);
  assert.equal(fake.rowsOf(solitaireDuelMatches).length, 1);
});

test("create-or-join: two lobbies get different seeds and different deals", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const one = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  // A fresh database is a fresh lobby. (The fake cannot evaluate WHERE, so the
  // "an open lobby already exists" path is covered by the join test above.)
  fake.reset();
  const two = await store.createOrJoin({ userId: MALLORY, nowMs: NOW });

  assert.notEqual(one.match.serverSeed, two.match.serverSeed);
  assert.notEqual(one.match.dealSeed, two.match.dealSeed);
  assert.notDeepEqual(one.match.deal, two.match.deal);
  assert.notDeepEqual(one.match.p1State, two.match.p1State);
});

// ── 2. The deal is revealed to both seats, and only when racing ───────────

test("dto: the deal is NOT revealed while the lobby is waiting", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const { match } = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const dto = store.matchToDto(match, ALICE, NOW);

  assert.equal(dto.view, null, "no board before the race is live");
  assert.equal(dto.opponent, null);
  assert.equal(dto.serverSeed, null, "the seed stays secret until terminal");
  assert.equal(dto.seedHash, match.serverSeedHash, "the commitment is public");
  assert.equal(identitiesIn(dto).size, 0, "no card may appear before GO");
});

test("dto: once racing, both seats receive the identical puzzle", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const first = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const { match } = await store.createOrJoin({ userId: BOB, nowMs: NOW + 1_000 });

  const fromAlice = store.matchToDto(match, ALICE, NOW + 1_000);
  const fromBob = store.matchToDto(match, BOB, NOW + 1_000);

  assert.deepEqual(fromAlice.view, fromBob.view, "the same tableau, stock count and waste");
  assert.deepEqual(fromAlice.view.tableau, fromBob.view.tableau);
  assert.equal(fromAlice.view.stockCount, fromBob.view.stockCount);
  assert.equal(fromAlice.view.stockCount, 24);
  assert.equal(fromAlice.seat, "player1");
  assert.equal(fromBob.seat, "player2");
  assert.equal(fromAlice.view.tableau.flat().filter((slot) => slot.faceUp).length, 7);
  assert.equal(fromAlice.view.tableau.flat().filter((slot) => !slot.faceUp).length, 21);
  assert.equal(identitiesIn(fromAlice.view).size, 7, "only the seven face-up cards");

  // The opponent appears as counts and status, never as a board.
  assert.equal(fromAlice.opponent.seatKey, "player2");
  assert.equal(fromAlice.opponent.foundationCards, 0);
  assert.equal(fromAlice.opponent.completed, false);
  for (const key of ["tableau", "stock", "waste", "foundations", "deal", "p1State", "p2State"]) {
    assert.equal(key in fromAlice.opponent, false, `${key} must not be in OpponentProgress`);
  }
  assert.equal(identitiesIn(fromAlice.opponent).size, 0);

  assert.equal(first.match.id, match.id);
});

test("dto: a non-participant is refused, and told nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const result = await store.fetchMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.status, 403);
  assert.match(result.error, /not a participant/i);

  const dto = store.matchToDto(row, MALLORY, NOW);
  assert.equal(dto.isParticipant, false);
  assert.equal(dto.seat, null);
  assert.equal(dto.view, null);
  assert.equal(dto.opponent, null);
  assert.equal(dto.serverSeed, null);
  assert.equal(identitiesIn(dto).size, 0, "a stranger sees no card at all");
});

test("dto: the revealed seed verifies against the pre-match commitment", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  assert.equal(store.matchToDto(row, ALICE, NOW).serverSeed, null, "secret while live");

  row.status = MATCH_STATUS.FINISHED;
  row.result = "draw";
  row.resolutionReason = "draw";
  row.endedAt = new Date(NOW);

  const after = store.matchToDto(row, ALICE, NOW);
  assert.equal(after.serverSeed, SERVER_SEED, "revealed once terminal");
  assert.equal(
    getServerSeedHash(after.serverSeed),
    after.seedHash,
    "hashing the revealed seed must reproduce the committed hash",
  );
});

// ── 3. Moves: accepted, derived, and strictly seat-scoped ────────────────

test("move: an accepted move advances ONLY the acting seat's board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const opponentBoard = structuredClone(row.p2State);

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal("error" in result, false, result.error);
  assert.equal(result.ply, 0);
  assert.equal(result.completed, false);
  assert.deepEqual(result.revealed, []);
  assert.equal(result.view.stockCount, 23);
  assert.equal(result.view.waste.length, 1);

  // Seat 1 advanced.
  assert.equal(row.p1Ply, 1);
  assert.equal(row.p1State.stock.length, 23);
  assert.equal(row.p1State.waste.length, 1);

  // Seat 2 did not move, and its board is byte-identical.
  assert.equal(row.p2Ply, 0);
  assert.deepEqual(row.p2State, opponentBoard);

  // The append-only log recorded the validated input at the ply it was played.
  const log = fake.rowsOf(solitaireDuelMoves);
  assert.equal(log.length, 1);
  assert.equal(log[0].seat, "player1");
  assert.equal(log[0].ply, 0);
  assert.equal(log[0].kind, "draw");
  assert.deepEqual(log[0].move, { kind: "draw" });
});

test("move: seat 2's move cannot reach seat 1's board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const hostBoard = structuredClone(row.p1State);

  await store.submitMove({
    userId: BOB,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.deepEqual(row.p1State, hostBoard);
  assert.equal(row.p1Ply, 0);
  assert.equal(row.p2Ply, 1);
});

test("move: progress is computed by the server from the board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: boardWithFoundationCards(9),
    p1PeakFoundation: 9,
    p1Ply: 20,
  });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: 20,
    nowMs: NOW,
  });

  assert.equal(result.progress.foundationCards, 9);
  assert.deepEqual(result.progress, store.progressOf(row.p1State));
  assert.equal(result.view.progress.foundationCards, 9);
  assert.equal(row.p1PeakFoundation, 9);

  // The DTO carries the server's own figure for both seats.
  const dto = store.matchToDto(row, ALICE, NOW);
  assert.equal(dto.progress.foundationCards, 9);
  assert.equal(dto.opponent.foundationCards, 0);
  assert.equal(dto.opponent.revealedTableau, 7);
});

test("move: an illegal move is refused and mutates nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const before = structuredClone(row);

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    // The waste is empty on the opening board.
    move: { kind: "waste-to-foundation", suit: "hearts" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 422);
  assert.deepEqual(row, before, "the whole row must be untouched");
  assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0);
  assert.equal(settlement.rating.length, 0);
});

test("move: a malformed move is refused BEFORE any database work", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  for (const bad of [
    { kind: "waste-to-tableau", toColumn: "0" },
    { kind: "waste-to-tableau", toColumn: 99 },
    { kind: "teleport" },
    null,
    "draw",
  ]) {
    const result = await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: bad, nowMs: NOW });
    assert.equal(result.status, 400, `${JSON.stringify(bad)} must be a 400`);
  }

  assert.equal(fake.state.transactions, 0, "shape-checking must not open a transaction");
});

test("move: a stale expectedPly is refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, { p1Ply: 7, p1State: { ...openBoard(), ply: 7 } });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: 6,
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /stale/i);
  assert.equal(row.p1Ply, 7);
  assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0);

  // A malformed cursor is a client error, not a stale one.
  const malformed = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    expectedPly: "7",
    nowMs: NOW,
  });
  assert.equal(malformed.status, 400);
});

test("move: no move is accepted before the synchronized GO instant", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, { goAt: new Date(NOW + 1_000) });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: { kind: "draw" },
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /has not started/i);
  assert.equal(row.p1Ply, 0);
});

test("move: refused while waiting, and once the match is terminal", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });
  const waiting = await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: { kind: "draw" }, nowMs: NOW });
  assert.equal(waiting.status, 409);
  assert.match(waiting.error, /waiting for an opponent/i);

  fake.reset();
  const terminal = seedMatch(fake, { status: MATCH_STATUS.FINISHED, result: "player1" });
  const after = await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: { kind: "draw" }, nowMs: NOW });
  assert.equal(after.status, 409);
  assert.equal(terminal.p1Ply, 0);
});

test("move: the per-seat cap bounds move spam", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const board = openBoard();
  board.ply = MAX_MOVES_PER_SEAT;
  seedMatch(fake, { p1State: board, p1Ply: MAX_MOVES_PER_SEAT });

  const result = await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: { kind: "draw" }, nowMs: NOW });
  assert.equal(result.status, 409);
  assert.match(result.error, /limit/i);
});

// ── 4. The client cannot submit a result ─────────────────────────────────

test("fake result: every claim smuggled into a move is ignored", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedPly: 0,
    nowMs: NOW,
    move: {
      kind: "draw",
      // Claims about the board, the score, the result and the rewards.
      progress: 52,
      foundationCards: 52,
      peakFoundation: 52,
      completed: true,
      completedAtMs: NOW,
      board: { tableau: [], stock: [], waste: [] },
      winner: "player1",
      result: "player1",
      winnerId: ALICE,
      score: 9999,
      elo: 2400,
      rating: 2400,
      trophy: 99,
      trophies: 99,
      status: MATCH_STATUS.FINISHED,
    },
    // ...and at the top level, for good measure.
    winner: "player1",
    result: "player1",
    status: MATCH_STATUS.FINISHED,
    progress: 52,
  });

  assert.equal("error" in result, false, result.error);
  assert.equal(result.completed, false);
  assert.equal(result.raceResolved, false);

  // The board decided everything: one plain draw, no rating, no trophies.
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(row.result, null);
  assert.equal(row.winnerId, null);
  assert.equal(row.resolutionReason, null);
  assert.equal(row.p1Ply, 1);
  assert.equal(row.p1PeakFoundation, 0);
  assert.equal(row.p1State.completed, false);
  assert.equal(row.p1State.completedAtMs, null);
  assert.equal(row.p1State.stock.length, 23);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("fake result: a fabricated board in the payload never reaches storage", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const before = structuredClone(row.p1State);

  await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedPly: 0,
    nowMs: NOW,
    move: {
      kind: "draw",
      tableau: [[{ card: card("spades", 13), faceUp: true }]],
      foundations: { spades: [card("spades", 1)], hearts: [], diamonds: [], clubs: [] },
      stock: [],
    },
  });

  assert.equal(row.p1State.tableau.length, 7);
  assert.equal(row.p1State.foundations.spades.length, 0);
  assert.equal(row.p1State.stock.length, 23);
  assert.notDeepEqual(row.p1State, before, "only the draw applied");
  assert.equal(row.p1State.ply, 1);
});

// ── 5. Completion is detected by the server ───────────────────────────────

test("completion: the server detects it, decides the winner and settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: boardOneMoveFromComplete(),
    p1PeakFoundation: 51,
    p1Ply: 80,
  });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    move: FINAL_MOVE,
    expectedPly: 80,
    nowMs: NOW,
  });

  assert.equal(result.completed, true);
  assert.equal(result.raceResolved, true);
  assert.equal(result.progress.foundationCards, 52);
  assert.equal(result.progress.progressPercent, 100);

  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.resolutionReason, "finish");
  assert.equal(row.winnerId, ALICE);
  assert.ok(row.p1FinishedAt instanceof Date, "the completion instant is server-stamped");
  assert.equal(row.p1State.completed, true);
  assert.equal(row.p1State.completedAtMs, NOW, "stamped from the server clock, not the client");

  // Exactly one settlement, with the literal canonical game key.
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].gameKey, "solitaire-duel");
  assert.equal(settlement.rating[0].matchId, MATCH_ID);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);
  assert.equal(settlement.rating[0].result, undefined, "a win is the default outcome");
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.trophy[0].gameKey, "solitaire-duel");
  assert.equal(settlement.trophy[0].winnerClerkId, ALICE);

  // The queue mirror saw the transition, not a second creation.
  assert.deepEqual(
    settlement.queue.map((entry) => [entry.kind, entry.gameKey]),
    [["transition", "solitaire-duel"]],
  );
});

test("completion: an already-finished match never settles twice", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: boardOneMoveFromComplete(),
    p1PeakFoundation: 51,
    p1Ply: 80,
  });

  await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: FINAL_MOVE, expectedPly: 80, nowMs: NOW });
  assert.equal(settlement.rating.length, 1);

  // A later inactivity pass over the same row must be a no-op.
  const again = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW + 60_000 });
  assert.equal(again.resolved, false);
  assert.equal(again.match.status, MATCH_STATUS.FINISHED);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);

  // ...and so must a second attempt to move.
  const second = await store.submitMove({ userId: BOB, matchId: MATCH_ID, move: { kind: "draw" }, nowMs: NOW + 1 });
  assert.equal(second.status, 409);
  assert.equal(settlement.rating.length, 1);
  assert.equal(row.p2Ply, 0);
});

test("completion: the earliest completion wins — a later seat cannot steal it", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Seat 1 already completed, well outside the dead-heat tolerance.
  const p1Board = boardOneMoveFromComplete();
  p1Board.foundations.clubs.push(card("clubs", 13));
  p1Board.tableau[0] = [];
  p1Board.completed = true;
  p1Board.completedAtMs = NOW - 5_000;
  p1Board.peakFoundation = 52;

  seedMatch(fake, {
    p1State: p1Board,
    p1Ply: 81,
    p1PeakFoundation: 52,
    p1FinishedAt: new Date(NOW - 5_000),
    p2State: boardOneMoveFromComplete(),
    p2Ply: 60,
    p2PeakFoundation: 51,
  });

  const result = await store.submitMove({
    userId: BOB,
    matchId: MATCH_ID,
    move: FINAL_MOVE,
    expectedPly: 60,
    nowMs: NOW,
  });

  assert.equal(result.raceResolved, true);
  assert.equal(fake.rowsOf(solitaireDuelMatches)[0].result, "player1");
  assert.equal(fake.rowsOf(solitaireDuelMatches)[0].winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
});

// ── 6. Inactivity (the untimed match) ────────────────────────────────────

test("inactivity: the idle seat forfeits past the threshold and the opponent wins", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    // ALICE has not moved for longer than the forfeit threshold; BOB moved a
    // moment ago, so only ALICE is idle.
    p1LastActionAt: new Date(NOW - INACTIVITY_FORFEIT_MS - 1),
    p2LastActionAt: new Date(NOW),
    p1State: boardWithFoundationCards(3),
    p1PeakFoundation: 3,
    p1Ply: 5,
    p2State: boardWithFoundationCards(9),
    p2PeakFoundation: 9,
    p2Ply: 20,
  });

  const result = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.resolved, true);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player2", "the active seat wins");
  assert.equal(row.winnerId, BOB);
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, BOB);
});

test("inactivity: nothing resolves while every seat is still active", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1LastActionAt: new Date(NOW - 1_000),
    p2LastActionAt: new Date(NOW - 2_000),
  });

  const result = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.resolved, false);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(settlement.rating.length, 0);
});

test("inactivity: a read resolves the forfeit without a sweeper", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    p1LastActionAt: new Date(NOW - INACTIVITY_FORFEIT_MS - 1),
    p2LastActionAt: new Date(NOW),
  });

  const result = await store.fetchMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.dto.status, MATCH_STATUS.FINISHED);
  assert.equal(result.dto.result, "player2");
  assert.equal(result.dto.resolutionReason, "forfeit");
});

test("inactivity: each viewer is served their OWN alarm and forfeit instants", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    p1LastActionAt: new Date(NOW - 1_000),
    p2LastActionAt: new Date(NOW - 2_000),
  });

  const result = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.dto.inactivityAlarmAtMs, NOW - 1_000 + INACTIVITY_ALARM_MS);
  assert.equal(result.dto.inactivityForfeitAtMs, NOW - 1_000 + INACTIVITY_FORFEIT_MS);
  // The opponent's own clock is projected too, so the active seat can be warned.
  assert.equal(result.dto.opponentInactivityAlarmAtMs, NOW - 2_000 + INACTIVITY_ALARM_MS);
  assert.equal(result.dto.opponentInactivityForfeitAtMs, NOW - 2_000 + INACTIVITY_FORFEIT_MS);
});

// ── 7. Forfeit, cancel and disconnect ─────────────────────────────────────

test("forfeit: the conceding seat loses, whoever was ahead", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Seat 2 is far ahead, and concedes.
  const row = seedMatch(fake, {
    p1Ply: 2,
    p2State: boardWithFoundationCards(20),
    p2PeakFoundation: 20,
    p2Ply: 40,
  });

  const result = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });

  assert.equal("error" in result, false, result.error);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(row.winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);

  // A non-participant cannot force it.
  fake.reset();
  seedMatch(fake);
  const stranger = await store.forfeitMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(stranger.status, 403);
});

test("cancel: only the lobby creator, and only while waiting", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const stranger = await store.cancelMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(stranger.status, 403);

  const owner = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal("error" in owner, false, owner.error);
  assert.equal(row.status, MATCH_STATUS.CANCELLED);
  assert.equal(row.result, null);
  assert.equal(settlement.rating.length, 0, "a cancelled lobby never settles");
  assert.equal(settlement.trophy.length, 0);

  // A live match cannot be cancelled out from under the opponent.
  fake.reset();
  const live = seedMatch(fake);
  const tooLate = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(tooLate.status, 409);
  assert.equal(live.status, MATCH_STATUS.PLAYING);
});

test("disconnect: releases a lobby, forfeits a live match, ignores a finished one", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // An abandoned lobby is cancelled, and never settles.
  const lobby = seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });
  const released = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(released.cancelled, true);
  assert.equal(released.forfeited, false);
  assert.equal(lobby.status, MATCH_STATUS.CANCELLED);
  assert.equal(settlement.rating.length, 0);

  // A live match is forfeited to the opponent.
  fake.reset();
  const live = seedMatch(fake, { p1Ply: 4 });
  const forfeited = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(forfeited.forfeited, true);
  assert.equal(live.result, "player2");
  assert.equal(live.resolutionReason, "forfeit");
  assert.equal(settlement.rating.length, 1);

  // A terminal match is a no-op, reported so a retry loop can stop.
  fake.reset();
  const settledSoFar = settlement.rating.length;
  const done = seedMatch(fake, { status: MATCH_STATUS.FINISHED, result: "player1", winnerId: ALICE });
  const noop = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(noop.forfeited, false);
  assert.equal(noop.cancelled, false);
  assert.equal(done.result, "player1");
  assert.equal(settlement.rating.length, settledSoFar, "a terminal match must not re-settle");
});

// ── 8. Reads ──────────────────────────────────────────────────────────────

test("lobby: the open-lobby list exposes nothing but the fact that it is waiting", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const { match } = await store.createOrJoin({ userId: ALICE, nowMs: NOW });

  const rows = await store.listOpenMatches();
  assert.equal(rows.length, 1);

  const entry = store.lobbyEntry(match, NOW);
  assert.equal(entry.open, true);
  assert.equal(entry.matchId, match.id);
  assert.equal(entry.seedHash, match.serverSeedHash);
  for (const key of ["deal", "p1State", "p2State", "serverSeed", "player1Id", "player2Id"]) {
    assert.equal(key in entry, false, `${key} must not be in a public lobby entry`);
  }
  assert.equal(identitiesIn(entry).size, 0);

  const mine = await store.listMyWaitingMatch({ userId: ALICE });
  assert.equal(mine.id, match.id);
});

test("moves: the append-only log records each seat's own ply sequence", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: { kind: "draw" }, expectedPly: 0, nowMs: NOW });
  await store.submitMove({ userId: ALICE, matchId: MATCH_ID, move: { kind: "draw" }, expectedPly: 1, nowMs: NOW });
  await store.submitMove({ userId: BOB, matchId: MATCH_ID, move: { kind: "draw" }, expectedPly: 0, nowMs: NOW });

  const log = fake.rowsOf(solitaireDuelMoves);
  assert.deepEqual(log.map((entry) => [entry.seat, entry.ply]), [
    ["player1", 0],
    ["player1", 1],
    ["player2", 0],
  ]);
  assert.equal(log.every((entry) => entry.kind === "draw"), true);

  // The per-seat reader exists and returns the log rows (the fake ignores WHERE,
  // so the seat scoping itself is proven by the rows above).
  const read = await store.fetchSeatMoves(MATCH_ID, "player1");
  assert.equal(read.length, 3);

  assert.equal(store.isMatchId(MATCH_ID), true);
  assert.equal(store.isMatchId("not-a-uuid"), false);
  assert.equal(store.isParticipant(row, ALICE), true);
  assert.equal(store.isParticipant(row, BOB), true);
  assert.equal(store.isParticipant(row, MALLORY), false);
});

// ════════════════════════════════════════════════════════════════════════
// Practice vs AI — the bot genuinely plays and settles nothing
// ════════════════════════════════════════════════════════════════════════

const practiceRow = (fake, overrides = {}) =>
  seedMatch(fake, {
    isAi: true,
    player2Id: SOLITAIRE_DUEL_AI_PLAYER_ID,
    aiDifficulty: "hard",
    goAt: new Date(NOW - 120_000),
    ...overrides,
  });

test("practice: createAiMatch seats the bot, deals the same puzzle and starts the clock", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const { match } = await store.createAiMatch({ userId: ALICE, difficulty: "hard", nowMs: NOW });
  assert.equal(match.player1Id, ALICE);
  assert.equal(match.player2Id, SOLITAIRE_DUEL_AI_PLAYER_ID);
  assert.equal(match.isAi, true);
  assert.equal(match.aiDifficulty, "hard");
  assert.equal(match.status, MATCH_STATUS.PLAYING);
  // One deal, two independent boards — the same shape a real join produces.
  assert.ok(match.deal);
  assert.ok(match.p1State && match.p2State);
  assert.equal(match.p1Ply, 0);
  assert.equal(match.p2Ply, 0);
  assert.equal(match.goAt.getTime(), NOW + READY_COUNTDOWN_MS);
  assert.equal(match.p1LastActionAt.getTime(), NOW + READY_COUNTDOWN_MS);
  assert.equal(match.p2LastActionAt.getTime(), NOW + READY_COUNTDOWN_MS);
  // A practice row is never mirrored into the queue lifecycle.
  assert.equal(settlement.queue.length, 0);
});

test("practice: createAiMatch coerces an unknown difficulty onto the shared scale", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const { match } = await store.createAiMatch({ userId: ALICE, difficulty: "nonsense", nowMs: NOW });
  assert.equal(match.aiDifficulty, "normal");
});

test("practice: advanceAiMatch plays the bot's own board from the server clock", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = practiceRow(fake);
  const humanBefore = structuredClone(row.p1State);

  const result = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.advanced, true);

  const after = fake.rowsOf(solitaireDuelMatches)[0];
  assert.ok(after.p2Ply > 0, "the bot made moves");
  // Every logged move is the bot's, and the human's board is untouched.
  const log = fake.rowsOf(solitaireDuelMoves);
  assert.ok(log.length > 0);
  assert.equal(log.every((entry) => entry.seat === "player2"), true);
  assert.deepEqual(after.p1State, humanBefore);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("practice: advanceAiMatch is a no-op before GO and between the bot's moves", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    isAi: true,
    player2Id: SOLITAIRE_DUEL_AI_PLAYER_ID,
    aiDifficulty: "hard",
    goAt: new Date(NOW + 5_000),
  });
  // Before GO: nothing is played.
  const before = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW });
  assert.equal(before.advanced, false);
  // 100ms after GO: the (hard) bot has not yet earned its first move.
  const between = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW + 5_100 });
  assert.equal(between.advanced, false);
  assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0);
});

test("practice: advanceAiMatch never touches a human match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { goAt: new Date(NOW - 120_000) });

  const human = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW });
  assert.equal(human.advanced, false);
  assert.equal(fake.rowsOf(solitaireDuelMoves).length, 0);
  assert.equal(fake.rowsOf(solitaireDuelMatches)[0].p2Ply, 0);
});

// ════════════════════════════════════════════════════════════════════════
// Re-dealing a dead board — per seat, and never the clock
// ════════════════════════════════════════════════════════════════════════

/** A board with NO legal move at all: seven columns topped by black fives. */
function deadBoard(ply = 0) {
  const state = openBoard();
  state.tableau = Array.from({ length: 7 }, () => [
    { card: card("spades", 5), faceUp: true },
  ]);
  state.stock = [];
  state.waste = [];
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };
  state.ply = ply;
  state.peakFoundation = 0;
  return state;
}

/**
 * A board with a move but NO way to progress: seven empty columns and a stock
 * of non-Ace, non-King cards, so the only legal move is the draw (then the
 * recycle) and the progress key never changes.
 *
 * This is the exact board class the OLD re-deal gate misjudged: the planner
 * gives up after `AI_STAGNATION_LIMIT` unchanging moves and reports `stuck`,
 * but `legalMoves` is NOT empty. A player must keep it; a bot that cannot
 * progress may be given a fresh deal.
 */
function movableButStuckBoard(ply = 0) {
  const state = openBoard();
  state.tableau = Array.from({ length: 7 }, () => []);
  state.stock = [
    card("spades", 2), card("hearts", 3), card("diamonds", 4), card("clubs", 5),
    card("spades", 6), card("hearts", 7), card("diamonds", 8), card("clubs", 9),
    card("spades", 10), card("hearts", 11), card("diamonds", 12), card("clubs", 2),
    card("spades", 3), card("hearts", 4), card("diamonds", 5), card("clubs", 6),
    card("spades", 7), card("hearts", 8), card("diamonds", 9), card("clubs", 10),
    card("spades", 11), card("hearts", 12), card("diamonds", 2), card("clubs", 3),
  ];
  state.waste = [];
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };
  state.ply = ply;
  state.peakFoundation = 0;
  return state;
}

/** A VALID board one move from won: 51 on the foundations, K♣ alone on column 0. */
function boardWinnableInOne(ply = 40) {
  const state = openBoard();
  state.tableau = Array.from({ length: 7 }, () => []);
  state.tableau[0] = [{ card: card("clubs", 13), faceUp: true }];
  state.stock = [];
  state.waste = [];
  state.foundations = {
    spades: Array.from({ length: 13 }, (_, i) => card("spades", i + 1)),
    hearts: Array.from({ length: 13 }, (_, i) => card("hearts", i + 1)),
    diamonds: Array.from({ length: 13 }, (_, i) => card("diamonds", i + 1)),
    clubs: Array.from({ length: 12 }, (_, i) => card("clubs", i + 1)),
  };
  state.ply = ply;
  state.peakFoundation = 51;
  return state;
}

test("practice: a stuck bot is re-dealt on its OWN seat, clock and human untouched", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = practiceRow(fake, {
    p2State: deadBoard(5),
    p2Ply: 5,
    p2PeakFoundation: 0,
    p1State: { ...openBoard(), ply: 3 },
    p1Ply: 3,
    p1LastActionAt: new Date(NOW - 1_000),
    p2LastActionAt: new Date(NOW - 1_000),
  });
  const humanBefore = structuredClone(row.p1State);
  const goAtBefore = row.goAt.getTime();
  const humanClockBefore = row.p1LastActionAt.getTime();

  const result = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.advanced, true);

  const after = fake.rowsOf(solitaireDuelMatches)[0];
  // The bot's board is a BRAND NEW deal...
  assert.equal(after.p2State.resetCount, 1);
  assert.equal(after.p2State.stock.length, 24);
  assert.equal(after.p2State.completed, false);
  // ...with its move cursor carried forward, never rewound.
  assert.equal(after.p2State.ply, 5);
  assert.equal(after.p2Ply, 5);
  // The human's board is byte-identical, and neither the GO instant nor the
  // human's own inactivity clock moved.
  assert.deepEqual(after.p1State, humanBefore);
  assert.equal(after.p1Ply, 3);
  assert.equal(after.goAt.getTime(), goAtBefore);
  assert.equal(after.p1LastActionAt.getTime(), humanClockBefore);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("read: a provably unwinnable board is re-dealt for the reader alone", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: deadBoard(9),
    p1Ply: 9,
    p1LastActionAt: new Date(NOW - 1_000),
    p2LastActionAt: new Date(NOW - 1_000),
  });
  const opponentBefore = structuredClone(row.p2State);
  const goAtBefore = row.goAt.getTime();

  const result = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  const after = fake.rowsOf(solitaireDuelMatches)[0];
  assert.equal(after.p1State.resetCount, 1);
  assert.equal(after.p1State.stock.length, 24);
  assert.equal(after.p1State.ply, 9, "the cursor is carried across the re-deal");
  assert.deepEqual(after.p2State, opponentBefore, "the opponent's board is untouched");
  assert.equal(after.goAt.getTime(), goAtBefore);
  // The reader's OWN DTO carries the fresh board and its reset counter.
  assert.equal(result.dto.view.resetCount, 1);
  assert.equal(result.dto.view.ply, 9);
  assert.equal(result.dto.status, MATCH_STATUS.PLAYING);
});

test("practice: a bot that cannot PROGRESS gets a fresh deal even though it can still move", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const board = movableButStuckBoard(0);
  assert.ok(legalMoves(board).length > 0, "the fixture must NOT be a dead board");
  const row = practiceRow(fake, {
    p2State: board,
    p2Ply: 0,
    p2PeakFoundation: 0,
    p1State: { ...openBoard(), ply: 3 },
    p1Ply: 3,
  });
  const humanBefore = structuredClone(row.p1State);

  const result = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.advanced, true);

  const after = fake.rowsOf(solitaireDuelMatches)[0];
  // The bot's board is replaced with a fresh SOLVABLE deal...
  assert.equal(after.p2State.resetCount, 1);
  assert.equal(after.p2State.stock.length, 24);
  // ...and the human's board is byte-identical.
  assert.deepEqual(after.p1State, humanBefore, "the human's board is untouched");
});

test("read: a board the PLAYER can still move is never re-dealt, however stuck the planner is", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const board = movableButStuckBoard(40);
  assert.ok(legalMoves(board).length > 0, "the fixture must NOT be a dead board");
  seedMatch(fake, { p1State: board, p1Ply: 40 });
  const before = structuredClone(board);

  await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  const after = fake.rowsOf(solitaireDuelMatches)[0];
  assert.deepEqual(after.p1State, before, "a board with a move must be left exactly alone");
  assert.equal(after.p1State.resetCount ?? 0, 0);
});

test("read: a winnable board is never re-dealt", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: boardWinnableInOne(40),
    p1Ply: 40,
    p1PeakFoundation: 51,
  });
  const before = structuredClone(row.p1State);

  await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  const after = fake.rowsOf(solitaireDuelMatches)[0];
  assert.deepEqual(after.p1State, before, "a winnable board must be left exactly alone");
  assert.equal(after.p1State.resetCount ?? 0, 0);
});

test("practice: the bot can solve the deal, and the win settles nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const botBoard = boardOneMoveFromComplete();
  seedMatch(fake, {
    isAi: true,
    player2Id: SOLITAIRE_DUEL_AI_PLAYER_ID,
    aiDifficulty: "hard",
    goAt: new Date(NOW - 120_000),
    p2State: botBoard,
    p2Ply: 0,
    p2PeakFoundation: botBoard.peakFoundation,
  });

  const result = await store.advanceAiMatch({ matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.advanced, true);

  const row = fake.rowsOf(solitaireDuelMatches)[0];
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player2");
  assert.equal(row.winnerId, SOLITAIRE_DUEL_AI_PLAYER_ID);
  // A practice match must never move a rating, a trophy, a win counter or the
  // queue, even when the bot wins.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  assert.equal(settlement.queue.length, 0);
  const userWrites = fake.state.writes.filter((w) => w.table === users);
  assert.equal(userWrites.length, 0, "no win/loss counter is touched");
});
