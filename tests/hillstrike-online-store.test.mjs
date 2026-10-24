/**
 * hillstrike-online-store.test.mjs
 *
 * THE ONLINE HILLSTRIKE MATCH STORE, driven for real.
 *
 * The model under test, in one line: a client may only ever say WHERE IT AIMED
 * (`{ angleDeg, power }`) and WHICH VERSION it was looking at. The trajectory,
 * the impact and its kind, the crater, both towers, both lives, whose turn it is,
 * the shots left in the volley, the winner and the match result are all derived by
 * the SERVER from its own row through the shared engine. So most of what these
 * tests do is try to make the store believe something a client is not allowed to
 * decide — and watch it ignore the claim and resolve the truth anyway.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/barricade-online-store.test.mjs: a fake Drizzle
 * client that ignores WHERE clauses (every store read targets the one match row
 * under test) and serialises transactions, which is its model of `FOR UPDATE`.
 * Updates persist, so a read after a write observes the new state the way a real
 * transaction would. The rating and trophy writers are mocked so settlement can
 * be counted; nothing else is.
 *
 * The store module is cached for the whole file, so every test must be mocked
 * with THE SAME fake — a fresh instance per test would leave the cached module
 * pointing at the first one. The one fake is reset before each test instead. The
 * store is loaded LAZILY (never with a static import) so `t.mock.module` can
 * intercept its dependencies.
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/hillstrike-online-store.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { hillstrikeMatches, hillstrikeShots } from "../src/db/schema.ts";
import {
  END_REASONS,
  IMPACT_KINDS,
  LIVES_PER_PLAYER,
  MATCH_STATUS,
  SHOTS_PER_VOLLEY,
} from "../src/lib/hillstrike/constants.ts";
import { simulateShot } from "../src/lib/hillstrike/physics.ts";
import { applyShot, createInitialState } from "../src/lib/hillstrike/rules.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:hillstrike";

const MATCH_ID = "99999999-9999-4999-8999-999999999999";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const SEED = 424242;

const other = (seat) => (seat === "player1" ? "player2" : "player1");

// ── Engine helpers (the same search the engine suites use) ────────────────

function simulate(state, seat, shot) {
  return simulateShot({
    battlefield: state.battlefield,
    shooterSeat: seat,
    shot,
    projectile: state.projectile,
  });
}

function findShot(state, seat, kind, { target = null } = {}) {
  const arc = seat === "player1" ? [4, 86] : [94, 176];
  for (let angle = arc[0]; angle <= arc[1]; angle += 1) {
    for (let power = 30; power <= 100; power += 2) {
      const shot = { angleDeg: angle, power };
      const simulation = simulate(state, seat, shot);
      if (simulation.impact.kind !== kind) continue;
      if (target && simulation.impact.target !== target) continue;
      return shot;
    }
  }
  throw new Error(`no ${kind} shot for ${seat} on seed ${state.seed}`);
}

const hitShot = (state, seat) =>
  findShot(state, seat, IMPACT_KINDS.PLAYER, { target: other(seat) });

function outOfBoundsShot(state, seat) {
  const arc = seat === "player1" ? [20, 80] : [100, 160];
  for (let angle = arc[0]; angle <= arc[1]; angle += 1) {
    const shot = { angleDeg: angle, power: 100 };
    if (simulate(state, seat, shot).impact.kind === IMPACT_KINDS.OUT_OF_BOUNDS) {
      return shot;
    }
  }
  throw new Error(`no out-of-bounds line for ${seat} on seed ${state.seed}`);
}

// ── The fake database ─────────────────────────────────────────────────────

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
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
      hillstrikeMatches,
      {
        player2Id: null,
        winnerId: null,
        currentTurnUserId: null,
        result: null,
        resultReason: null,
        startedAt: null,
        endedAt: null,
      },
    ],
    [hillstrikeShots, { targetSeat: null, livesLost: 0 }],
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
        id: `row-${state.nextId++}`,
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

  let chain = Promise.resolve();
  const transaction = (fn) => {
    const run = async () => {
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

const loadStore = () => import("../src/lib/hillstrike/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A live match row on the opening position, player1 (Alice) to move. */
function matchRow(overrides = {}) {
  const state = overrides.gameState ?? createInitialState({ seed: SEED, openingSeat: "player1" });
  return {
    id: MATCH_ID,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    currentTurnUserId: ALICE,
    ply: state.turnIndex,
    status: MATCH_STATUS.PLAYING,
    seed: state.seed,
    fieldVersion: state.fieldVersion,
    openingSeat: state.openingSeat,
    initialBattlefield: state.battlefield,
    gameState: state,
    result: null,
    resultReason: null,
    startedAt: new Date(),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function seedMatch(fake, overrides = {}) {
  const row = matchRow(overrides);
  fake.rowsOf(hillstrikeMatches).push(row);
  return row;
}

const liveMatch = (fake) => fake.rowsOf(hillstrikeMatches)[0];
const shotLog = (fake) => fake.rowsOf(hillstrikeShots);

/** The opening position after `shots` ([seat, shot] pairs) have resolved. */
function stateAfter(shots, seed = SEED) {
  return shots.reduce(
    (state, [seat, shot]) => applyShot(state, seat, shot).state,
    createInitialState({ seed, openingSeat: "player1" }),
  );
}

/** A row seeded directly from an engine state built by the test. */
const rowFromState = (state, overrides = {}) => matchRow({ gameState: state, ...overrides });

// ── Trust boundary: the aim is the whole request ──────────────────────────

test("submitShot: only the aim and the version are read", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const state = row.gameState;
  const shot = hitShot(state, "player1");
  const expected = applyShot(state, "player1", shot).state;

  // Everything a client might try to claim rides along with the aim. None of it
  // is read: the engine's own resolution is what gets stored.
  const result = await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot: {
      ...shot,
      damage: 99,
      livesLost: 3,
      target: "player2",
      winner: "player1",
      impact: { kind: "player", target: "player2", x: 0, y: 0, tick: 1 },
      completed: true,
    },
  });

  assert.equal(result.state.lives.player2, LIVES_PER_PLAYER - 1);
  assert.equal(result.state.lives.player1, LIVES_PER_PLAYER);
  assert.equal(result.matchCompleted, false, "the forged completion flag is ignored");
  assert.equal(result.winnerSeat, null);
  assert.deepEqual(result.match.gameState, expected, "the engine's state is what is stored");
  assert.equal(result.match.status, MATCH_STATUS.PLAYING);
  assert.equal(row.ply, 1);
  assert.equal(row.currentTurnUserId, BOB, "the opening one-shot volley hands over");
});

test("submitShot: an accepted shot is logged with its aim and resolved outcome", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const shot = outOfBoundsShot(row.gameState, "player1");

  const result = await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot,
  });

  assert.equal(result.actionIndex, 0);
  const [logged] = shotLog(fake);
  assert.equal(shotLog(fake).length, 1);
  assert.equal(logged.actionIndex, 0);
  assert.equal(logged.playerId, ALICE);
  assert.equal(logged.seat, "player1");
  assert.equal(logged.angleDeg, shot.angleDeg);
  assert.equal(logged.power, shot.power);
  assert.equal(logged.impactKind, IMPACT_KINDS.OUT_OF_BOUNDS);
  assert.equal(logged.livesLost, 0);
  assert.equal(logged.targetSeat, null);
  assert.equal(logged.outcome.turn, "player2");
  assert.equal(logged.outcome.status, MATCH_STATUS.PLAYING);
  // The trajectory is not duplicated into the log: `game_state.lastShot` holds it.
  assert.equal(Object.hasOwn(logged, "path"), false);
});

test("submitShot: a hit inside a two-shot volley keeps the turn", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // The opening seat fires one shot out of bounds; Bob then owns a two-shot volley.
  const opening = outOfBoundsShot(createInitialState({ seed: SEED, openingSeat: "player1" }), "player1");
  const state = stateAfter([["player1", opening]]);
  const row = seedMatch(fake, rowFromState(state));

  const shot = hitShot(state, "player2");
  const result = await store.submitShot({
    userId: BOB,
    matchId: MATCH_ID,
    expectedVersion: state.turnIndex,
    shot,
  });

  assert.equal(result.state.lives.player1, LIVES_PER_PLAYER - 1);
  assert.equal(result.state.lives.player2, LIVES_PER_PLAYER);
  assert.equal(result.state.turn, "player2", "a connecting shot does not end the volley");
  assert.equal(result.state.shotsRemaining, 1);
  assert.equal(result.match.currentTurnUserId, BOB);
  assert.equal(result.matchCompleted, false);
  assert.equal(writers.rating.length, 0);
});

// ── Termination and settlement ────────────────────────────────────────────

test("submitShot: zero lives ends the match and settles exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // Bob has one life left, Alice to move.
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  const state = { ...base, lives: { player1: 3, player2: 1 } };
  const row = seedMatch(fake, rowFromState(state));

  const shot = hitShot(state, "player1");
  const result = await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot,
  });

  assert.equal(result.matchCompleted, true);
  assert.equal(result.state.status, MATCH_STATUS.FINISHED);
  assert.equal(result.winnerSeat, "player1");
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.winnerId, ALICE);
  assert.equal(row.resultReason, END_REASONS.LIVES_EXHAUSTED);
  assert.ok(row.endedAt instanceof Date);
  // The engine's own terminal state is what was persisted.
  assert.equal(row.gameState.winner, "player1");

  // Progression: one W, one L, one rating event, one trophy event.
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
  assert.equal(writers.rating[0].gameKey, "hillstrike");
  assert.equal(writers.rating[0].winnerClerkId, ALICE);
  assert.equal(writers.rating[0].loserClerkId, BOB);
  assert.equal(writers.trophy[0].gameKey, "hillstrike");

  // A second shot, and a resignation, are both refused; nothing settles twice.
  const late = await store.submitShot({
    userId: BOB,
    matchId: MATCH_ID,
    expectedVersion: result.match.ply,
    shot: { angleDeg: 150, power: 60 },
  });
  assert.equal(late.status, 409);
  const lateForfeit = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(lateForfeit.status, 409);
  assert.equal(writers.rating.length, 1, "the first settlement stands");
  assert.equal(shotLog(fake).length, 1);
});

test("submitShot: a replayed action index loses the race as a clean 409", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  fake.state.failInserts.add(hillstrikeShots);

  const result = await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot: outOfBoundsShot(row.gameState, "player1"),
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /already recorded/i);
  assert.equal(row.ply, 0);
  assert.equal(row.gameState.turn, "player1");
});

test("submitShot: two submissions in flight cannot both be accepted", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const shot = outOfBoundsShot(row.gameState, "player1");

  const [first, second] = await Promise.all([
    store.submitShot({ userId: ALICE, matchId: MATCH_ID, expectedVersion: 0, shot }),
    store.submitShot({ userId: ALICE, matchId: MATCH_ID, expectedVersion: 0, shot }),
  ]);

  const statuses = [first.status ?? 200, second.status ?? 200].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one shot is accepted");
  assert.equal(row.ply, 1);
  assert.equal(shotLog(fake).length, 1);
  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialises the two requests");
});

// ── Authorization and lifecycle ───────────────────────────────────────────

test("submitShot: authorization, lifecycle and turn are checked in order", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const shot = { angleDeg: 45, power: 60 };

  const stranger = await store.submitShot({
    userId: MALLORY,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot,
  });
  assert.equal(stranger.status, 403);
  assert.equal(fake.state.writes.length, 0, "a 403 must not write anything");

  const outOfTurn = await store.submitShot({
    userId: BOB,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot,
  });
  assert.equal(outOfTurn.status, 409);
  assert.match(outOfTurn.error, /not your turn/i);
  assert.equal(row.ply, 0);

  // An open lobby accepts nothing until the second seat lands.
  fake.reset();
  const waiting = seedMatch(fake, {
    status: MATCH_STATUS.WAITING,
    player2Id: null,
  });
  const lobby = await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot,
  });
  assert.equal(lobby.status, 409);
  assert.match(lobby.error, /waiting for an opponent/i);
  assert.equal(waiting.ply, 0);

  // A settled match refuses even the seat that would otherwise be on turn.
  fake.reset();
  seedMatch(fake, { status: MATCH_STATUS.FINISHED, result: "player1", winnerId: ALICE });
  const finished = await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot,
  });
  assert.equal(finished.status, 409);
  assert.match(finished.error, /no longer active/i);

  // A missing row is a 404, not an empty match.
  fake.reset();
  const missing = await store.submitShot({
    userId: ALICE,
    matchId: "11111111-1111-4111-8111-111111111111",
    expectedVersion: 0,
    shot,
  });
  assert.equal(missing.status, 404);
});

test("submitShot: malformed aims are refused, never repaired", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const malformed = [
    undefined,
    null,
    {},
    { angleDeg: 400, power: 60 },
    { angleDeg: -1, power: 60 },
    { angleDeg: 45, power: 70.5 },
    { angleDeg: 45, power: "70" },
    { angleDeg: "45", power: 60 },
    { angleDeg: Number.NaN, power: 60 },
    { angleDeg: 45, power: 101 },
  ];

  for (const shot of malformed) {
    const result = await store.submitShot({
      userId: ALICE,
      matchId: MATCH_ID,
      expectedVersion: 0,
      shot,
    });
    assert.equal(result.status, 400, `${JSON.stringify(shot)} must be a 400`);
    assert.equal(result.match, undefined);
  }
  assert.equal(row.ply, 0);
  assert.equal(shotLog(fake).length, 0);
});

test("submitShot: the version is required, and a stale one cannot consume a shot", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const shot = { angleDeg: 45, power: 60 };

  for (const expectedVersion of [undefined, null, "zero", 0.5, true]) {
    const result = await store.submitShot({
      userId: ALICE,
      matchId: MATCH_ID,
      expectedVersion,
      shot,
    });
    assert.equal(result.status, 400, `version ${String(expectedVersion)} must be a 400`);
  }

  for (const expectedVersion of [1, 2, -1]) {
    const result = await store.submitShot({
      userId: ALICE,
      matchId: MATCH_ID,
      expectedVersion,
      shot,
    });
    assert.equal(result.status, 409, `version ${expectedVersion} must be a 409`);
    assert.match(result.error, /stale/i);
  }

  assert.equal(row.ply, 0);
  assert.equal(shotLog(fake).length, 0);
});

// ── Replayability ─────────────────────────────────────────────────────────

test("replay: the stored row reproduces the engine from its own seed and shots", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const firstShot = outOfBoundsShot(row.gameState, "player1");
  await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot: firstShot,
  });
  const second = hitShot(row.gameState, "player2");
  await store.submitShot({
    userId: BOB,
    matchId: MATCH_ID,
    expectedVersion: 1,
    shot: second,
  });

  const replay = stateAfter([
    ["player1", firstShot],
    ["player2", second],
  ]);
  assert.equal(Number(row.seed), SEED);
  assert.deepEqual(row.gameState, replay, "the persisted state is the engine's own");
  assert.deepEqual(
    row.initialBattlefield,
    createInitialState({ seed: Number(row.seed), openingSeat: "player1" }).battlefield,
    "the seed reproduces the layout that was dealt",
  );
});

// ── Matchmaking ───────────────────────────────────────────────────────────

test("createOrJoin: one lobby, one advisory lock, and a server-drawn seed", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const created = await store.createOrJoin({ userId: ALICE });
  assert.equal(created.joined, false);
  assert.equal(created.match.player1Id, ALICE);
  assert.equal(created.match.player2Id, null);
  assert.equal(created.match.status, MATCH_STATUS.WAITING);
  assert.equal(created.match.ply, 0);
  assert.equal(created.match.currentTurnUserId, null, "nobody owns a turn while waiting");
  assert.equal(fake.rowsOf(hillstrikeMatches).length, 1);
  assert.equal(fake.state.locks.length, 1, "matchmaking runs under one advisory lock");

  // The seed and the layout are the server's, and they agree with each other.
  const stored = created.match;
  assert.ok(Number.isInteger(Number(stored.seed)));
  assert.ok(Number(stored.seed) >= 0 && Number(stored.seed) <= 0xffffffff);
  assert.equal(stored.openingSeat, stored.gameState.openingSeat);
  assert.equal(stored.gameState.turn, stored.openingSeat);
  assert.deepEqual(
    stored.gameState.battlefield,
    createInitialState({ seed: Number(stored.seed), openingSeat: stored.openingSeat })
      .battlefield,
    "a waiting lobby already holds the battlefield both seats will play",
  );

  // The host asking again gets its OWN lobby back rather than a second one.
  const resumed = await store.createOrJoin({ userId: ALICE });
  assert.equal(resumed.joined, false);
  assert.equal(resumed.match.id, created.match.id);
  assert.equal(fake.rowsOf(hillstrikeMatches).length, 1);

  // The joiner takes the second seat; the match is live immediately.
  const joined = await store.createOrJoin({ userId: BOB });
  assert.equal(joined.joined, true);
  assert.equal(joined.match.player2Id, BOB);
  assert.equal(joined.match.status, MATCH_STATUS.PLAYING);
  assert.ok(joined.match.startedAt instanceof Date);
  assert.equal(
    joined.match.currentTurnUserId,
    joined.match.gameState.turn === "player1" ? ALICE : BOB,
    "the seat the engine says is on turn is the one named",
  );
  // Joining regenerates nothing.
  assert.deepEqual(joined.match.gameState, created.match.gameState);
});

// ── Reads ─────────────────────────────────────────────────────────────────

test("fetchMatch: only a participant can read, and the whole position is public", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const stranger = await store.fetchMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(stranger.status, 403);

  const asAlice = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(asAlice.dto.viewerSeat, "player1");
  assert.equal(asAlice.dto.opponentSeat, "player2");
  assert.equal(asAlice.dto.isViewerTurn, true);
  assert.equal(asAlice.dto.version, 0);
  assert.equal(asAlice.dto.turnIndex, 0);
  assert.equal(asAlice.dto.shotsRemaining, 1, "the opening volley is one shot");
  assert.equal(asAlice.dto.openingShotPending, true);
  assert.equal(asAlice.dto.seed, SEED);
  assert.equal(asAlice.dto.openingSeat, "player1");
  assert.deepEqual(asAlice.dto.lives, { player1: 3, player2: 3 });
  assert.equal(asAlice.dto.result, null);
  // Perfect information: the opponent's lives and tower are part of the snapshot.
  assert.equal(asAlice.dto.gameState.battlefield.blocks.length > 0, true);

  const asBob = await store.fetchMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(asBob.dto.viewerSeat, "player2");
  assert.equal(asBob.dto.isViewerTurn, false, "the same row projects per viewer");

  // A waiting row names no turn owner and is not playable by either seat.
  fake.reset();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null, currentTurnUserId: null });
  const lobby = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(lobby.dto.isViewerTurn, false);
  assert.equal(lobby.dto.turnUserId, null);

  // The fake ignores WHERE clauses, so the empty-table case is driven on a fresh
  // table rather than by asking for an id that is not the seeded row.
  fake.state.tables.set(hillstrikeMatches, []);
  const missing = await store.fetchMatch({
    userId: ALICE,
    matchId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(missing.status, 404);
  assert.equal(row.ply, 0);
});

// ── Resignation, cancellation, disconnects ────────────────────────────────

test("forfeit: resigning awards the opponent the win and leaves the position alone", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const before = seedMatch(fake);
  const positionBefore = JSON.stringify(before.gameState);

  const stranger = await store.forfeitMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(stranger.status, 403);

  const result = await store.forfeitMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, "player2");
  assert.equal(result.match.winnerId, BOB);
  assert.equal(result.match.resultReason, END_REASONS.RESIGNED);
  // Resigning ends the match; it never fabricates a final shot.
  assert.equal(JSON.stringify(result.match.gameState), positionBefore);
  assert.equal(shotLog(fake).length, 0);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
});

test("cancel: only the creator, and only an open lobby", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null, currentTurnUserId: null });

  const hijack = await store.cancelMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(hijack.status, 403);

  const cancelled = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(cancelled.match.status, MATCH_STATUS.CANCELLED);
  // A cancelled lobby never settled: no result, no rating, no trophy.
  assert.equal(cancelled.match.result ?? null, null);
  assert.equal(cancelled.match.winnerId ?? null, null);
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);

  // A live match is not a lobby and cannot be cancelled out from under a duel.
  fake.reset();
  seedMatch(fake);
  const live = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(live.status, 409);
});

test("disconnect: an abandoned duel goes to the seat still present", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const stranger = await store.forfeitMatchOnDisconnect({
    userId: MALLORY,
    matchId: MATCH_ID,
  });
  assert.equal(stranger.status, 403);

  const result = await store.forfeitMatchOnDisconnect({
    userId: BOB,
    matchId: MATCH_ID,
  });
  assert.equal(result.forfeited, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.match.result, "player1");
  assert.equal(result.match.winnerId, ALICE);
  assert.equal(result.match.resultReason, END_REASONS.ABANDONED);
  assert.equal(writers.rating.length, 1);
});

test("disconnect: an abandoned lobby is cancelled, and a settled match is a no-op", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null, currentTurnUserId: null });

  const abandoned = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: MATCH_ID,
  });
  assert.equal(abandoned.cancelled, true);
  assert.equal(abandoned.forfeited, false);
  assert.equal(abandoned.match.status, MATCH_STATUS.CANCELLED);
  assert.equal(writers.rating.length, 0, "a cancelled lobby is never rated");

  const writesAfterFirst = fake.state.writes.length;
  const again = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: MATCH_ID,
  });
  assert.equal(again.forfeited, false);
  assert.equal(again.cancelled, false);
  assert.equal(fake.state.writes.length, writesAfterFirst, "the second call must not write");
});

// ── Guards ────────────────────────────────────────────────────────────────

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
});

test("lobby reads: the open list and the caller's own resumable lobby", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // NOTE: the fake ignores WHERE clauses (see the file header), so this test
  // seeds ONLY rows the predicate would keep. The SQL predicate itself is pinned
  // by the migration/route contract suite, not here.
  fake.rowsOf(hillstrikeMatches).push(
    matchRow({ status: MATCH_STATUS.WAITING, player2Id: null, currentTurnUserId: null }),
    matchRow({
      id: "22222222-2222-4222-8222-222222222222",
      player1Id: BOB,
      status: MATCH_STATUS.WAITING,
      player2Id: null,
      currentTurnUserId: null,
    }),
  );

  const open = await store.listOpenMatches({});
  assert.equal(open.length, 2);
  assert.equal(open[0].player1Id, ALICE, "oldest first");
  assert.equal(open[1].player1Id, BOB);

  const mine = await store.listMyWaitingMatch({ userId: ALICE });
  assert.equal(mine.id, MATCH_ID);
});

test("persistence: the store never writes a stake, pot or prize", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  await store.submitShot({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedVersion: 0,
    shot: outOfBoundsShot(row.gameState, "player1"),
  });

  const writtenKeys = new Set();
  for (const write of fake.state.writes) {
    for (const key of Object.keys(write.values ?? {})) writtenKeys.add(key);
  }
  for (const banned of [
    "stake",
    "stakeAmount",
    "stakeAmountCents",
    "pot",
    "payout",
    "prizePaid",
    "houseFee",
  ]) {
    assert.equal(writtenKeys.has(banned), false, `${banned} must never be written`);
  }
});
