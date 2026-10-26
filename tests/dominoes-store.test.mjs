/**
 * dominoes-store.test.mjs
 *
 * THE ONLINE DOMINOES MATCH STORE, driven for real.
 *
 * The model under test, in one line: a client may only ever say WHICH ACTION IT
 * MEANT (play this tile on that end / draw / pass) and WHICH VERSION it was
 * looking at. The chain, both hands, the face-down pile, whose turn it is,
 * whether the action is legal, the winner and the result are all derived by the
 * SERVER from its own row through the shared rules engine.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/barricade-online-store.test.mjs and
 * tests/tic-tac-toe-security.test.mjs: an in-memory Drizzle client that ignores
 * WHERE clauses (every store read targets the one row under test), so each
 * scenario seeds exactly the rows it means to act on. Two deliberate additions:
 *
 *   1. TRANSACTIONS ARE SERIALISED. That is the fake's model of `FOR UPDATE`:
 *      the second transaction reads the row the first one committed, which is
 *      what makes a concurrent-submission assertion meaningful.
 *   2. `failInserts` can make the move-log insert raise a Postgres
 *      unique-violation, so the store's race-loser path is driven for real.
 *
 * The store module is cached for the whole file, so every test must be mocked
 * with THE SAME fake — a fresh instance per test would leave the cached module
 * pointing at the first one. The one fake is reset before each test instead.
 *
 * The shared progression writers are SPIES: the settlement tests assert that
 * they are called exactly once with the right shape, never that they compute
 * anything (that is src/lib/rating.js's own suite).
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/dominoes-store.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { dominoesMatches, dominoesMoves, users } from "../src/db/schema.ts";
import {
  END_REASONS,
  MATCH_STATUS,
  RESULT,
  TURN_WINDOW_MS,
} from "../src/lib/dominoes/constants.ts";
import { openEndsOf } from "../src/lib/dominoes/rules.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run with --experimental-test-module-mocks";

const MATCH_ID = "99999999-9999-4999-8999-999999999999";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

/* -------------------------------------------------------------------------- *
 * The fake database
 * -------------------------------------------------------------------------- */

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    writes: [],
    locks: [],
    inFlight: 0,
    maxConcurrent: 0,
    failInserts: new Set(),
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
            // The W/L counters are SQL increments; emulate just that so a read
            // after the write sees a number.
            row[key] = isSqlExpression(value) ? (Number(row[key]) || 0) + 1 : value;
          }
        }
        return Promise.resolve(rowsOf(table).map((row) => ({ ...row })));
      },
      then: (resolve, reject) => b.returning().then(resolve, reject),
    };
    return b;
  };

  const NULLABLE_DEFAULTS = new Map([
    [
      dominoesMatches,
      {
        player2Id: null,
        currentTurnUserId: null,
        turnDeadlineAt: null,
        gameState: null,
        p1Hand: [],
        p2Hand: [],
        drawPile: [],
        winnerId: null,
        result: null,
        resultReason: null,
        startedAt: null,
        endedAt: null,
      },
    ],
    [dominoesMoves, { tile: null, chainEnd: null, timedOut: false }],
  ]);

  const insert = (table) => ({
    values: (v) => {
      if (state.failInserts.has(table)) {
        throw Object.assign(
          new Error("duplicate key value violates unique constraint"),
          { code: "23505" },
        );
      }
      const row = {
        // Match rows are addressed by a uuid in the real schema, so the fake
        // mints one too.
        id: table === dominoesMatches ? crypto.randomUUID() : `row-${state.nextId++}`,
        createdAt: new Date(),
        ...(NULLABLE_DEFAULTS.get(table) ?? {}),
        ...v,
      };
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

  // The row lock, modelled: two transactions can never overlap.
  let chain = Promise.resolve();
  const transaction = (fn) => {
    const run = async () => {
      state.transactions += 1;
      state.inFlight += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
      try {
        return await fn(tx);
      } finally {
        state.inFlight -= 1;
      }
    };
    const result = chain.then(run);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    state,
    rowsOf,
    reset: () => {
      state.tables.clear();
      state.nextId = 1;
      state.transactions = 0;
      state.writes = [];
      state.locks = [];
      state.inFlight = 0;
      state.maxConcurrent = 0;
      state.failInserts.clear();
      chain = Promise.resolve();
    },
    db: { transaction, select, update, insert },
  };
}

let sharedFake = null;
const writers = { rating: [], trophy: [] };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  sharedFake.reset();
  writers.rating.length = 0;
  writers.trophy.length = 0;

  t.mock.module("../src/db/client.ts", { namedExports: { db: sharedFake.db } });
  t.mock.module("../src/lib/rating.js", {
    namedExports: {
      applyRatingResult: async (args) => {
        writers.rating.push(args);
        return { applied: true };
      },
    },
  });
  t.mock.module("../src/lib/trophyStore.js", {
    namedExports: {
      applyTrophyResult: async (args) => {
        writers.trophy.push(args);
        return { applied: true };
      },
    },
  });
  return sharedFake;
}

const loadStore = () => import("../src/lib/dominoes/serverStore.ts");

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** The public half of a state — the exact split the store persists. */
function publicState(state) {
  return {
    status: state.status,
    turn: state.turn,
    ply: state.ply,
    chain: state.chain,
    openEnds: state.openEnds,
    startingSeat: state.startingSeat,
    startingTile: state.startingTile,
    winner: state.winner,
    outcome: state.outcome,
    lastAction: state.lastAction,
  };
}

/**
 * A crafted mid-game position. `openEnds` is derived from the chain, so a test
 * cannot create a position the engine would call inconsistent.
 */
function craftState({
  p1 = [],
  p2 = [],
  pile = [],
  chain = [],
  turn = "player1",
  ply = 0,
  status = MATCH_STATUS.PLAYING,
  winner = null,
  outcome = null,
} = {}) {
  return {
    status,
    turn,
    ply,
    hands: { player1: p1, player2: p2 },
    drawPile: pile,
    chain,
    openEnds: openEndsOf(chain),
    startingSeat: "player1",
    startingTile: p1[0] ?? p2[0] ?? "0-0",
    winner,
    outcome,
    lastAction: null,
  };
}

/** A live row: Alice to move, a fresh 15-second window, three tiles each. */
function matchRow(overrides = {}) {
  const state =
    overrides.state ??
    craftState({
      p1: ["6-3", "1-1", "2-2"],
      p2: ["6-6", "5-5", "0-0"],
      pile: ["4-4", "3-1", "3-2"],
      turn: "player1",
    });
  delete overrides.state;
  return {
    id: MATCH_ID,
    player1Id: ALICE,
    player2Id: BOB,
    status: MATCH_STATUS.PLAYING,
    ply: state.ply,
    currentTurnUserId: state.turn === "player1" ? ALICE : BOB,
    turnDeadlineAt: new Date(NOW + TURN_WINDOW_MS),
    gameState: publicState(state),
    p1Hand: [...state.hands.player1],
    p2Hand: [...state.hands.player2],
    drawPile: [...state.drawPile],
    winnerId: null,
    result: null,
    resultReason: null,
    startedAt: new Date(NOW),
    endedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function seedMatch(fake, overrides = {}) {
  const row = matchRow(overrides);
  fake.rowsOf(dominoesMatches).push(row);
  return row;
}

const liveMatch = (fake) => fake.rowsOf(dominoesMatches)[0];
const moveLog = (fake) => fake.rowsOf(dominoesMoves);

const play = (tile, end) => ({ type: "play", tile, ...(end ? { end } : {}) });
const DRAW = { type: "draw" };
const PASS = { type: "pass" };

/* -------------------------------------------------------------------------- *
 * The split: public state vs secrets
 * -------------------------------------------------------------------------- */

test("publicStateOf is exactly the engine state minus both hands and the pile", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const state = craftState({
    p1: ["6-3", "1-1"],
    p2: ["5-5"],
    pile: ["0-0"],
  });

  const stored = store.publicStateOf(state);
  assert.deepEqual(stored, publicState(state));
  for (const secret of ["hands", "drawPile"]) {
    assert.equal(
      Object.hasOwn(stored, secret),
      false,
      `${secret} must not be part of the persisted public state`,
    );
  }

  // Round-tripping through the columns restores the identical engine state.
  const row = matchRow({ state });
  assert.deepEqual(store.stateOf(row), state);
  // A lobby has no deal, and `stateOf` says so instead of inventing one.
  assert.equal(store.stateOf(matchRow({ gameState: null })), null);
});

/* -------------------------------------------------------------------------- *
 * The viewer projection (hidden information)
 * -------------------------------------------------------------------------- */

test("fetchMatch: each seat sees its own hand and only a COUNT of the other", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const asAlice = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(asAlice.dto.viewerSeat, "player1");
  assert.equal(asAlice.dto.opponentSeat, "player2");
  assert.equal(asAlice.dto.isViewerTurn, true);
  assert.deepEqual(asAlice.dto.hand, ["6-3", "1-1", "2-2"]);
  assert.equal(asAlice.dto.opponentTileCount, 3);
  assert.equal(asAlice.dto.drawPileCount, 3);
  assert.deepEqual(asAlice.dto.openEnds, { left: null, right: null });
  assert.equal(asAlice.dto.version, 0);

  // The opponent's tiles and the pile are nowhere in the payload — not as a
  // field, not nested inside one.
  const aliceWire = JSON.stringify(asAlice.dto);
  for (const secret of ["6-6", "5-5", "0-0", "4-4", "3-1", "3-2"]) {
    assert.equal(
      aliceWire.includes(`"${secret}"`),
      false,
      `player2's tile ${secret} must not appear in player1's snapshot`,
    );
  }
  for (const field of ["hands", "drawPile", "p2Hand", "p1Hand", "gameState"]) {
    assert.equal(
      Object.hasOwn(asAlice.dto, field),
      false,
      `the projection must not carry ${field}`,
    );
  }

  const asBob = await store.fetchMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(asBob.dto.viewerSeat, "player2");
  assert.equal(asBob.dto.isViewerTurn, false, "the same row projects per viewer");
  assert.deepEqual(asBob.dto.hand, ["6-6", "5-5", "0-0"]);
  assert.equal(asBob.dto.opponentTileCount, 3);
  const bobWire = JSON.stringify(asBob.dto);
  for (const secret of ["6-3", "1-1", "2-2"]) {
    assert.equal(
      bobWire.includes(`"${secret}"`),
      false,
      `player1's tile ${secret} must not appear in player2's snapshot`,
    );
  }
});

test("fetchMatch: a stranger is refused, and an unknown match is a 404", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const stranger = await store.fetchMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.dto, undefined);

  // No such row: the store reports 404 rather than a 500 from a uuid cast.
  fake.state.tables.set(dominoesMatches, []);
  const missing = await store.fetchMatch({
    userId: ALICE,
    matchId: "11111111-1111-4111-8111-111111111111",
    nowMs: NOW,
  });
  assert.equal(missing.status, 404);
});

test("fetchMatch: a waiting lobby projects as an empty, unstarted match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { player2Id: null, status: MATCH_STATUS.WAITING, gameState: null, p1Hand: [], p2Hand: [], drawPile: [], turnDeadlineAt: null, currentTurnUserId: null });

  const result = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.dto.status, MATCH_STATUS.WAITING);
  assert.deepEqual(result.dto.hand, []);
  assert.equal(result.dto.opponentTileCount, 0);
  assert.equal(result.dto.drawPileCount, 0);
  assert.equal(result.dto.isLive, false);
  assert.equal(result.dto.turn, null);
  assert.equal(result.dto.turnDeadlineAt, null);
});

/* -------------------------------------------------------------------------- *
 * Matchmaking: the deal is minted when the second seat lands
 * -------------------------------------------------------------------------- */

test("createOrJoin: no deal exists until an opponent arrives, and only one is ever opened", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const created = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  assert.equal(created.joined, false);
  assert.equal(created.match.player1Id, ALICE);
  assert.equal(created.match.player2Id, null);
  assert.equal(created.match.status, MATCH_STATUS.WAITING);
  // No deal, no hands, no clock: the host cannot preview tiles.
  assert.equal(created.match.gameState ?? null, null);
  assert.deepEqual(created.match.p1Hand, []);
  assert.deepEqual(created.match.p2Hand, []);
  assert.deepEqual(created.match.drawPile, []);
  assert.equal(created.match.turnDeadlineAt ?? null, null);
  assert.equal(created.match.currentTurnUserId ?? null, null);
  // One advisory lock guards the whole critical section.
  assert.equal(fake.state.locks.length, 1);

  // The host asking again gets its OWN lobby back rather than a second one.
  const resumed = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  assert.equal(resumed.joined, false);
  assert.equal(resumed.match.id, created.match.id);
  assert.equal(fake.rowsOf(dominoesMatches).length, 1, "no second lobby is opened");

  // The joiner takes the second seat and the match starts with a real deal.
  const joined = await store.createOrJoin({ userId: BOB, nowMs: NOW });
  assert.equal(joined.joined, true);
  assert.equal(joined.match.player2Id, BOB);
  assert.equal(joined.match.status, MATCH_STATUS.PLAYING);
  assert.equal(
    joined.match.p1Hand.length + joined.match.p2Hand.length + joined.match.gameState.chain.length,
    14,
  );
  assert.equal(joined.match.drawPile.length, 14);
  assert.equal(
    new Set([
      ...joined.match.p1Hand,
      ...joined.match.p2Hand,
      ...joined.match.drawPile,
      ...joined.match.gameState.chain.map((tile) => tile.id),
    ]).size,
    28,
    "the deal uses all 28 tiles exactly once",
  );
  assert.ok(joined.match.startedAt instanceof Date);

  // The deal plays the highest double itself, so the opening tile is already on
  // the chain: the holder is down to six tiles, ply counts the placement, and
  // the row names the OTHER seat as the one to move. (A deal holding no double
  // whatsoever — about 0.3% of them — is the one start left to the opener.)
  const gameState = joined.match.gameState;
  const openingSeat = gameState.startingSeat;
  const openingHand = openingSeat === "player1" ? joined.match.p1Hand : joined.match.p2Hand;
  const otherHand = openingSeat === "player1" ? joined.match.p2Hand : joined.match.p1Hand;
  const placed = gameState.chain.length === 1;

  assert.equal(joined.match.ply, placed ? 1 : 0);
  assert.equal(openingHand.length, placed ? 6 : 7);
  assert.equal(otherHand.length, 7);
  assert.equal(
    gameState.turn,
    placed ? (openingSeat === "player1" ? "player2" : "player1") : openingSeat,
  );
  assert.equal(
    joined.match.currentTurnUserId,
    gameState.turn === "player1" ? ALICE : BOB,
  );
  if (placed) {
    assert.deepEqual(gameState.chain.map((tile) => tile.id), [gameState.startingTile]);
    assert.equal(gameState.chain[0].isDouble, true);
  }

  // …and that placement is in the move log, at the turn number it was made at,
  // credited to its author — so the board the players see is fully explained.
  assert.equal(moveLog(fake).length, placed ? 1 : 0);
  if (placed) {
    const opening = moveLog(fake)[0];
    assert.equal(opening.ply, 0);
    assert.equal(opening.playerId, openingSeat === "player1" ? ALICE : BOB);
    assert.equal(opening.action, "play");
    assert.equal(opening.tile, gameState.startingTile);
    assert.equal(opening.chainEnd, "left");
    assert.equal(opening.timedOut, false);
  }
  assert.equal(
    joined.match.turnDeadlineAt.getTime(),
    NOW + TURN_WINDOW_MS,
    "the first turn gets the full window, stamped from the server clock",
  );
});

test("reconnect: two reads restore the identical deal, with no re-shuffle", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const first = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  const second = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  assert.deepEqual(second.dto.hand, first.dto.hand);
  assert.deepEqual(second.dto.chain, first.dto.chain);
  assert.equal(second.dto.drawPileCount, first.dto.drawPileCount);
  assert.equal(second.dto.version, first.dto.version);
  assert.equal(second.dto.turn, first.dto.turn);
  // No write happened: a read can advance the CLOCK, never re-deal.
  assert.equal(fake.state.writes.length, 0);
  assert.deepEqual(liveMatch(fake).p1Hand, first.dto.hand);
});

/* -------------------------------------------------------------------------- *
 * Actions: valid, invalid, stale, duplicate
 * -------------------------------------------------------------------------- */

test("move: a legal play is derived, applied and logged", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: play("6-3"),
    expectedVersion: 0,
    nowMs: NOW,
  });

  assert.equal(result.match.ply, 1);
  assert.equal(result.state.turn, "player2");
  assert.equal(result.match.currentTurnUserId, BOB);
  assert.deepEqual(result.match.p1Hand, ["1-1", "2-2"]);
  // Opening the chain exposes both halves.
  assert.deepEqual(result.match.gameState.openEnds, { left: 6, right: 3 });
  assert.equal(result.match.gameState.chain.length, 1);
  // Every accepted action stamps a fresh window for the next seat.
  assert.equal(result.match.turnDeadlineAt.getTime(), NOW + TURN_WINDOW_MS);
  assert.equal(result.match.currentTurnUserId, BOB);
  assert.equal(result.matchCompleted, false);

  const [logged] = moveLog(fake);
  assert.equal(moveLog(fake).length, 1);
  assert.equal(logged.ply, 0, "the log records the turn the action was taken at");
  assert.equal(logged.playerId, ALICE);
  assert.equal(logged.action, "play");
  assert.equal(logged.tile, "6-3");
  assert.equal(logged.chainEnd, "left");
  assert.equal(logged.timedOut, false);
});

test("a dealt match: the placement owns ply 0, the first real action is taken at ply 1", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const joined = await store.createOrJoin({ userId: BOB, nowMs: NOW });
  const matchId = joined.match.id;
  const onTurn = joined.match.gameState.turn;
  const mover = onTurn === "player1" ? ALICE : BOB;

  // The version a client is shown right after the deal already counts the
  // placement, and THAT is the version the first real action echoes back.
  const read = await store.fetchMatch({ userId: mover, matchId, nowMs: NOW });
  const placed = read.dto.chain.length === 1;
  assert.equal(read.dto.version, placed ? 1 : 0);
  assert.equal(read.dto.isViewerTurn, true);
  assert.equal(read.dto.startingSeat, joined.match.gameState.startingSeat);
  assert.equal(read.dto.startingTile ?? null, null, "the tile stays out of the DTO");

  // Play whatever the projection says is legal, on the end it says. (A deal with
  // no double anywhere is the one case that opens by hand, from an empty chain.)
  const open = read.dto.openEnds;
  const fitted = read.dto.chain.length
    ? read.dto.hand
        .map((candidate) => {
          const [a, b] = String(candidate).split("-").map(Number);
          if (a === open.left || b === open.left) return { type: "play", tile: candidate, end: "left" };
          if (a === open.right || b === open.right) return { type: "play", tile: candidate, end: "right" };
          return null;
        })
        .find(Boolean)
    : { type: "play", tile: read.dto.hand[0] };
  const action = fitted ?? (read.dto.drawPileCount > 0 ? { type: "draw" } : { type: "pass" });

  const result = await store.move({
    userId: mover,
    matchId,
    action,
    expectedVersion: read.dto.version,
    nowMs: NOW,
  });
  assert.ok(result.match, `the first action after the deal must be accepted (${JSON.stringify(action)})`);

  // The log reads: the deal's placement at ply 0 when there was one, then this
  // action at ply 1.
  const history = await store.fetchMatchMoves(matchId);
  assert.deepEqual(
    history.map((row) => [row.ply, row.action]),
    placed
      ? [
          [0, "play"],
          [1, action.type],
        ]
      : [[0, action.type]],
  );
  if (placed) {
    assert.equal(
      history[0].playerId,
      joined.match.gameState.startingSeat === "player1" ? ALICE : BOB,
    );
    assert.equal(history[0].tile, joined.match.gameState.startingTile);
  }
  assert.equal(history[history.length - 1].playerId, mover);
  assert.equal(fake.rowsOf(dominoesMoves).length, history.length);
});

test("move: a draw takes one tile, keeps the turn and is allowed only when stuck", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Alice holds nothing that matches 6-5.
  const state = craftState({
    p1: ["0-0"],
    p2: ["1-1"],
    pile: ["4-4", "2-2"],
    chain: [{ id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: "player2" }],
    turn: "player1",
  });
  seedMatch(fake, { state });

  const drawn = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: DRAW,
    expectedVersion: 0,
    nowMs: NOW,
  });
  assert.equal(drawn.state.turn, "player1", "a draw keeps the turn");
  assert.deepEqual(drawn.match.p1Hand, ["0-0", "4-4"]);
  assert.deepEqual(drawn.match.drawPile, ["2-2"]);
  assert.equal(drawn.match.currentTurnUserId, ALICE);
  // The retried draw is a stale version, and the double-submit guard is what
  // stops it consuming a second tile.
  const replayed = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: DRAW,
    expectedVersion: 0,
    nowMs: NOW,
  });
  assert.equal(replayed.status, 409);
  assert.match(replayed.error, /stale/i);
});

test("move: missing, malformed and stale versions are refused without a write", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const before = JSON.stringify({ ply: row.ply, hand: row.p1Hand });

  for (const expectedVersion of [undefined, null, "not-a-version", 1.5, 7]) {
    const result = await store.move({
      userId: ALICE,
      matchId: MATCH_ID,
      action: play("6-3"),
      expectedVersion,
      nowMs: NOW,
    });
    assert.equal(result.status, 409, `version ${String(expectedVersion)} must be refused`);
    assert.equal(result.match, undefined);
  }
  assert.equal(JSON.stringify({ ply: row.ply, hand: row.p1Hand }), before);
  assert.equal(moveLog(fake).length, 0);
  assert.equal(fake.state.writes.length, 0);
});

test("move: illegal actions are refused by the engine, with the engine's codes", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  // Out of turn (Bob acts on Alice's window).
  const outOfTurn = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: play("6-6"),
    expectedVersion: 0,
    nowMs: NOW,
  });
  assert.equal(outOfTurn.status, 409);
  assert.match(outOfTurn.error, /not your turn/i);

  // A real tile that is not in the caller's hand.
  const notHeld = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: play("6-6"),
    expectedVersion: 0,
    nowMs: NOW,
  });
  assert.equal(notHeld.status, 409);
  assert.match(notHeld.error, /not in your hand/i);

  // A tile that does not match the open end (the chain opens with 6-3).
  await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: play("6-3"),
    expectedVersion: 0,
    nowMs: NOW,
  });
  const mismatch = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: play("5-5", "right"),
    expectedVersion: 1,
    nowMs: NOW,
  });
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.error, /does not match/i);

  // A malformed action is the client's fault, not a stale view.
  const malformed = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: { type: "teleport" },
    expectedVersion: 1,
    nowMs: NOW,
  });
  assert.equal(malformed.status, 400);
  const offSet = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: play("7-1", "right"),
    expectedVersion: 1,
    nowMs: NOW,
  });
  assert.equal(offSet.status, 400);

  // Only the one legal action was ever logged.
  assert.equal(moveLog(fake).length, 1);
});

test("move: a duplicated action loses on the (match, ply) index as a clean 409", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  fake.state.failInserts.add(dominoesMoves);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: play("6-3"),
    expectedVersion: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /already recorded/i);
  assert.equal(row.ply, 0);
  assert.deepEqual(row.p1Hand, ["6-3", "1-1", "2-2"]);
});

test("move: concurrent submissions produce exactly one accepted action", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const [first, second] = await Promise.all([
    store.move({ userId: ALICE, matchId: MATCH_ID, action: play("6-3"), expectedVersion: 0, nowMs: NOW }),
    store.move({ userId: ALICE, matchId: MATCH_ID, action: play("6-3"), expectedVersion: 0, nowMs: NOW }),
  ]);

  const accepted = [first, second].filter((result) => result.match);
  const refused = [first, second].filter((result) => !result.match);
  assert.equal(accepted.length, 1, "exactly one submission may consume the turn");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].status, 409);
  assert.equal(row.ply, 1);
  assert.equal(moveLog(fake).length, 1);
  // The fake serialises transactions, which is what `FOR UPDATE` guarantees.
  assert.equal(fake.state.maxConcurrent, 1);
});

/* -------------------------------------------------------------------------- *
 * The clock
 * -------------------------------------------------------------------------- */

test("isTurnExpired is a pure server-clock test", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const row = matchRow();

  assert.equal(store.isTurnExpired(row, NOW), false);
  assert.equal(store.isTurnExpired(row, NOW + TURN_WINDOW_MS - 1), false);
  assert.equal(store.isTurnExpired(row, NOW + TURN_WINDOW_MS), true, "the deadline itself is late");
  assert.equal(store.isTurnExpired({ ...row, status: MATCH_STATUS.FINISHED }, NOW + 1e9), false);
  assert.equal(store.isTurnExpired({ ...row, turnDeadlineAt: null }, NOW + 1e9), false);
});

test("a late move is refused, and the clock is advanced in the same transaction", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const late = NOW + TURN_WINDOW_MS + 500;
  const row = seedMatch(fake);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: play("6-3"),
    expectedVersion: 0,
    nowMs: late,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /expired/i);
  // The player's tile was NOT played — the hand keeps the tile it wanted to
  // play and gains the one the clock drew for it instead.
  assert.deepEqual(row.p1Hand, ["6-3", "1-1", "2-2", "4-4"]);
  // …the clock drew one instead, and stamped a fresh window.
  assert.equal(row.ply, 1);
  assert.equal(row.turnDeadlineAt.getTime(), late + TURN_WINDOW_MS);
  const [logged] = moveLog(fake);
  assert.equal(logged.action, "draw");
  assert.equal(logged.timedOut, true);
  assert.equal(logged.ply, 0);
});

test("the clock resolves an expired turn at most once, even for two readers", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const late = NOW + TURN_WINDOW_MS + 500;
  const row = seedMatch(fake);

  const [a, b] = await Promise.all([
    store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: late }),
    store.fetchMatch({ userId: BOB, matchId: MATCH_ID, nowMs: late }),
  ]);

  const resolved = [a, b].filter((result) => result.timedOut === true);
  assert.equal(resolved.length, 1, "exactly one reader may resolve the turn");
  assert.equal(moveLog(fake).length, 1);
  assert.equal(row.ply, 1);
  assert.equal(row.p1Hand.length, 4, "exactly one tile was drawn");
  assert.equal(row.drawPile.length, 2);

  // A third read finds the deadline already moved and applies nothing.
  const third = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: late });
  assert.equal(third.timedOut, false);
  assert.equal(moveLog(fake).length, 1);
  assert.equal(row.ply, 1);
});

test("with an empty pile the clock passes, and a blocked round settles as a draw", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const late = NOW + TURN_WINDOW_MS + 500;
  // Chain is 6-5, the pile is empty, and NEITHER hand can play. Alice holds
  // 2-2 (4 pips) and Bob 3-1 (4 pips), so the blockage is an exact tie.
  const state = craftState({
    p1: ["2-2"],
    p2: ["3-1"],
    pile: [],
    chain: [{ id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: "player2" }],
    turn: "player1",
  });
  const row = seedMatch(fake, { state });

  const result = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: late });

  assert.equal(result.timedOut, true);
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, RESULT.DRAW);
  assert.equal(result.match.winnerId, null);
  assert.equal(result.match.resultReason, END_REASONS.BLOCKED_PIPS);
  assert.equal(result.match.turnDeadlineAt ?? null, null, "a decided match has no clock");
  assert.equal(row.ply, 1);

  // The clock's action is logged as its own.
  const [logged] = moveLog(fake);
  assert.equal(logged.action, "pass");
  assert.equal(logged.timedOut, true);

  // A draw settles through the shared writers with `result: "draw"` and moves
  // no W/L counter.
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.rating[0].result, "draw");
  assert.equal(writers.rating[0].gameKey, "dominoes");
  assert.equal(writers.trophy.length, 1);
  assert.equal(writers.trophy[0].result, "draw");
  const userWrites = fake.state.writes.filter((write) => write.table === users);
  assert.equal(userWrites.length, 0, "a draw must not increment gamesWon/gamesLost");
});

/* -------------------------------------------------------------------------- *
 * Victory and settlement
 * -------------------------------------------------------------------------- */

test("a winning play finishes the match and settles it exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Alice's last tile is the only thing between her and an emptied hand.
  const state = craftState({
    p1: ["6-3"],
    p2: ["1-1", "2-2"],
    pile: ["4-4"],
    turn: "player1",
  });
  const row = seedMatch(fake, { state });

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: play("6-3"),
    expectedVersion: 0,
    nowMs: NOW,
  });

  assert.equal(result.matchCompleted, true);
  assert.equal(result.winnerSeat, "player1");
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, RESULT.PLAYER1);
  assert.equal(result.match.winnerId, ALICE);
  assert.equal(result.match.resultReason, END_REASONS.EMPTIED_HAND);
  assert.ok(result.match.endedAt instanceof Date);
  assert.equal(result.match.turnDeadlineAt ?? null, null);
  assert.deepEqual(row.gameState.hands, undefined, "hands are never part of the public state");

  // One settlement, through the shared writers, inside the claiming transaction.
  assert.equal(writers.rating.length, 1);
  assert.deepEqual(
    {
      gameKey: writers.rating[0].gameKey,
      matchId: writers.rating[0].matchId,
      winner: writers.rating[0].winnerClerkId,
      loser: writers.rating[0].loserClerkId,
      result: writers.rating[0].result,
    },
    {
      gameKey: "dominoes",
      matchId: MATCH_ID,
      winner: ALICE,
      loser: BOB,
      result: undefined,
    },
  );
  assert.equal(writers.trophy.length, 1);
  const userWrites = fake.state.writes.filter((write) => write.table === users);
  assert.equal(userWrites.length, 2, "winner +1 win, loser +1 loss");

  // Terminal matches are final: another action and a resignation are both 409,
  // and re-reading settles nothing a second time.
  const late = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: play("1-1", "right"),
    expectedVersion: result.match.ply,
    nowMs: NOW,
  });
  assert.equal(late.status, 409);
  const resign = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(resign.status, 409);
  await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(writers.rating.length, 1, "a settled match must never settle twice");
  assert.equal(writers.trophy.length, 1);
  assert.equal(result.match.result, RESULT.PLAYER1);
});

/* -------------------------------------------------------------------------- *
 * Resignation, cancellation, disconnects
 * -------------------------------------------------------------------------- */

test("forfeit: resigning awards the opponent the win and leaves the position alone", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const positionBefore = JSON.stringify(row.gameState);

  const stranger = await store.forfeitMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(stranger.status, 403);

  const result = await store.forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, RESULT.PLAYER2);
  assert.equal(result.match.winnerId, BOB);
  assert.equal(result.match.resultReason, END_REASONS.RESIGNED);
  // Resigning ends the match; it never plays a tile.
  assert.equal(JSON.stringify(result.match.gameState), positionBefore);
  assert.equal(moveLog(fake).length, 0);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.rating[0].winnerClerkId, BOB);

  // A second resignation — from either seat — is a 409, never a second
  // settlement.
  const again = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(again.status, 409);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
});

test("cancel: only the creator, only while waiting, and it settles nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    player2Id: null,
    status: MATCH_STATUS.WAITING,
    gameState: null,
    p1Hand: [],
    p2Hand: [],
    drawPile: [],
    turnDeadlineAt: null,
    currentTurnUserId: null,
  });

  const hijack = await store.cancelMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(hijack.status, 403);

  const cancelled = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(cancelled.match.status, MATCH_STATUS.CANCELLED);
  assert.equal(cancelled.match.result ?? null, null);
  assert.equal(cancelled.match.winnerId ?? null, null);
  assert.equal(writers.rating.length, 0, "an abandoned lobby never settles");

  // A live match is not a lobby and cannot be cancelled out from under a game.
  fake.reset();
  seedMatch(fake);
  const live = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(live.status, 409);
});

test("disconnect-forfeit: an abandoned duel goes to the seat still present", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const stranger = await store.forfeitMatchOnDisconnect({
    userId: MALLORY,
    matchId: MATCH_ID,
    nowMs: NOW,
  });
  assert.equal(stranger.status, 403);

  const result = await store.forfeitMatchOnDisconnect({
    userId: BOB,
    matchId: MATCH_ID,
    nowMs: NOW,
  });
  assert.equal(result.forfeited, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.match.result, RESULT.PLAYER1);
  assert.equal(result.match.winnerId, ALICE);
  assert.equal(result.match.resultReason, END_REASONS.ABANDONED);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.rating[0].winnerClerkId, ALICE);
});

test("disconnect-forfeit: an abandoned lobby is cancelled, a settled match is a no-op", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    player2Id: null,
    status: MATCH_STATUS.WAITING,
    gameState: null,
    p1Hand: [],
    p2Hand: [],
    drawPile: [],
    turnDeadlineAt: null,
    currentTurnUserId: null,
  });

  const abandoned = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: MATCH_ID,
    nowMs: NOW,
  });
  assert.equal(abandoned.cancelled, true);
  assert.equal(abandoned.forfeited, false);
  assert.equal(abandoned.match.status, MATCH_STATUS.CANCELLED);

  // Idempotent: the realtime retry loop calls this until it is told to stop.
  const again = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: MATCH_ID,
    nowMs: NOW,
  });
  assert.equal(again.forfeited, false);
  assert.equal(again.cancelled, false);
  assert.equal(fake.state.writes.length, 1, "the second call must not write");
  assert.equal(writers.rating.length, 0);
});

/* -------------------------------------------------------------------------- *
 * Guards
 * -------------------------------------------------------------------------- */

test("guards: a malformed id never reaches a Postgres uuid cast", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  assert.equal(store.isMatchId(MATCH_ID), true);
  for (const bad of ["", "1", "not-a-uuid", "99999999-9999-9999-9999-999999999999", null, 42]) {
    assert.equal(store.isMatchId(bad), false, `${String(bad)} is not a match id`);
  }

  assert.equal(store.seatForUser({ player1Id: ALICE, player2Id: null }, ALICE), "player1");
  assert.equal(store.seatForUser({ player1Id: ALICE, player2Id: null }, BOB), null);
  assert.equal(store.seatForUser({ player1Id: ALICE, player2Id: BOB }, null), null);
  assert.equal(store.isParticipant({ player1Id: ALICE, player2Id: BOB }, MALLORY), false);
  assert.equal(store.userIdForSeat({ player1Id: ALICE, player2Id: null }, "player2"), null);
});

test("guards: an open lobby accepts no actions until a second seat lands", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    player2Id: null,
    status: MATCH_STATUS.WAITING,
    gameState: null,
    p1Hand: [],
    p2Hand: [],
    drawPile: [],
    turnDeadlineAt: null,
    currentTurnUserId: null,
  });

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: DRAW,
    expectedVersion: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /waiting for an opponent/i);
  assert.equal(fake.state.writes.length, 0);
});

test("move history is append-only and ordered by ply", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  await store.move({ userId: ALICE, matchId: MATCH_ID, action: play("6-3"), expectedVersion: 0, nowMs: NOW });
  // Bob's 6-6 matches the left end (6), so the engine requires him to play it
  // rather than draw — either way the log has to record his turn.
  await store.move({ userId: BOB, matchId: MATCH_ID, action: play("6-6", "left"), expectedVersion: 1, nowMs: NOW });

  const history = await store.fetchMatchMoves(MATCH_ID);
  assert.deepEqual(
    history.map((moveRow) => [moveRow.ply, moveRow.playerId, moveRow.action]),
    [
      [0, ALICE, "play"],
      [1, BOB, "play"],
    ],
  );
  assert.equal(history[0].tile, "6-3");
  assert.equal(history[0].chainEnd, "left", "the opening tile records the left end");
  assert.equal(history[1].tile, "6-6");
  assert.equal(history[1].chainEnd, "left");
  assert.equal(history[1].timedOut, false);
});
