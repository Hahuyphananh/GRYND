/**
 * barricade-online-store.test.mjs
 *
 * THE ONLINE BARRICADE MATCH STORE, driven for real.
 *
 * The model under test, in one line: a client may only ever say WHICH ACTION
 * ADDRESS IT MEANT (a destination square, or a groove plus an orientation) and
 * WHICH VERSION it was looking at. The position, both pawns, every barricade,
 * both reserves, whose turn it is, whether the action is legal, the winner and
 * the match result are all derived by the SERVER from its own row through the
 * shared rules engine. So most of what these tests do is try to make the store
 * accept something a client is not allowed to decide — and watch it refuse, or
 * ignore the claim and derive the truth anyway.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/tic-tac-toe-store.test.mjs and
 * tests/solitaire-duel-store.test.mjs: a fake Drizzle client that ignores WHERE
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
 * Barricade is UNSTAKED and deliberately unrated, so there is no rating, trophy
 * or queue mock here — the only shared writer a finished match touches is the
 * terminal columns of its own row, and those are asserted directly.
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/barricade-online-store.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { barricadeMatches, barricadeMoves } from "../src/db/schema.ts";
import {
  ACTION_TYPES,
  END_REASONS,
  MATCH_STATUS,
  REJECTION,
} from "../src/lib/barricade/constants.ts";
import {
  applyAction,
  createInitialState,
  legalWalls,
  validateAction,
} from "../src/lib/barricade/rules.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:barricade";

const MATCH_ID = "99999999-9999-4999-8999-999999999999";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";

/** A SQL expression object (Drizzle's `sql\`…\``) rather than a literal value. */
const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

// ── The fake database ─────────────────────────────────────────────────────

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    writes: [],
    locks: [],
    // Tables whose next INSERT should fail with a Postgres unique-violation, so
    // the store's race-loser path (a replayed ply) can be driven for real.
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
      barricadeMatches,
      {
        player2Id: null,
        winnerId: null,
        result: null,
        resultReason: null,
        startedAt: null,
        endedAt: null,
      },
    ],
    [barricadeMoves, { orientation: null }],
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

  return {
    state,
    rowsOf,
    reset: () => {
      state.tables.clear();
      state.nextId = 1;
      state.transactions = 0;
      state.writes = [];
      state.locks = [];
      state.failInserts.clear();
    },
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

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  sharedFake.reset();
  t.mock.module("../src/db/client.ts", { namedExports: { db: sharedFake.db } });
  return sharedFake;
}

const loadStore = () => import("../src/lib/barricade/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A live match row on the opening position, player1 (Alice) to move. */
function matchRow(overrides = {}) {
  const state = createInitialState();
  return {
    id: MATCH_ID,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    currentTurnUserId: ALICE,
    ply: state.ply,
    status: MATCH_STATUS.PLAYING,
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

/** Seed the one match row the store will read. */
function seedMatch(fake, overrides = {}) {
  const row = matchRow(overrides);
  fake.rowsOf(barricadeMatches).push(row);
  return row;
}

/** The live match row (updates persist, so this reflects the latest write). */
const liveMatch = (fake) => fake.rowsOf(barricadeMatches)[0];
const moveLog = (fake) => fake.rowsOf(barricadeMoves);

/** A row seeded directly from an engine state built by the test. */
const rowFromState = (state, overrides = {}) =>
  matchRow({ gameState: state, ply: state.ply, ...overrides });

/**
 * The opening position after `actions` (a list of `[seat, action]` pairs) have
 * been applied through the engine — so every fixture a scenario plays from is a
 * position the rules engine itself produced.
 */
function stateAfter(actions) {
  return actions.reduce((state, [seat, action]) => applyAction(state, seat, action), createInitialState());
}

const move = (to) => ({ type: "move", to });
const wall = (col, row, orientation = "horizontal") => ({
  type: "wall",
  wall: { col, row, orientation },
});

// ── Trust boundary: the action ADDRESS is the whole request ───────────────

test("move: a claim about the position is refused before it can be believed", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  // The engine derives `kind`; a client that supplies a contradicting one is
  // refused (400: a malformed action address, not a stale board).
  const forged = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { type: "move", to: { col: 4, row: 1 }, kind: "jump-diagonal" },
    expectedVersion: 0,
  });
  assert.equal(forged.status, 400);
  assert.equal(row.ply, 0);
  assert.equal(moveLog(fake).length, 0);

  // A destination that the client's own imagined board would allow, but this
  // row's position does not, is refused by the ENGINE (409: stale view).
  const teleport = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 4 }),
    expectedVersion: 0,
  });
  assert.equal(teleport.status, 409);
  assert.equal(row.ply, 0);
  assert.equal(moveLog(fake).length, 0);

  // Nothing a client sends is ever stored as the position: the row still holds
  // the state the engine wrote, byte for byte.
  assert.deepEqual(row.gameState.pawns.player1, { col: 4, row: 0 });

  // The only action that IS accepted is the one the engine already agreed with.
  const accepted = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 1 }),
    expectedVersion: 0,
  });
  assert.equal(accepted.ply, 0);
  assert.equal(accepted.kind, "step");
  assert.deepEqual(accepted.state.pawns.player1, { col: 4, row: 1 });
  assert.equal(accepted.match.ply, 1);
});

test("move: the logged address is the one the server validated", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // A barricade that the server itself accepted earlier, then Alice's turn.
  const seeded = stateAfter([
    ["player1", wall(0, 0, "horizontal")],
    ["player2", move({ col: 4, row: 7 })],
  ]);
  const row = seedMatch(fake, rowFromState(seeded));
  // The row mutates in place as the fake persists the write, so the ply the
  // action was taken at is read before it moves.
  const plyBefore = row.ply;

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    // A barricade: the groove plus the orientation it faces.
    action: wall(0, 1, "vertical"),
    expectedVersion: plyBefore,
  });

  assert.equal(result.state.walls.length, seeded.walls.length + 1);
  // An accepted barricade spends exactly one of the acting seat's reserves.
  assert.equal(
    result.state.wallsRemaining.player1,
    seeded.wallsRemaining.player1 - 1,
  );
  assert.equal(result.state.wallsRemaining.player2, seeded.wallsRemaining.player2);
  assert.equal(result.state.turn, "player2");
  assert.equal(result.match.currentTurnUserId, BOB);
  assert.equal(result.state.lastAction.seat, "player1");

  const [logged] = moveLog(fake);
  assert.equal(moveLog(fake).length, 1);
  assert.equal(logged.actionType, ACTION_TYPES.WALL);
  assert.equal(logged.playerId, ALICE);
  assert.equal(logged.col, 0);
  assert.equal(logged.row, 1);
  assert.equal(logged.orientation, "vertical");
  // The log records the ply that was OPEN when the action was taken.
  assert.equal(logged.ply, plyBefore);
  assert.equal(result.match.ply, plyBefore + 1);
});

// ── Authorization and lifecycle ───────────────────────────────────────────

test("move: an unrelated account cannot act, and nothing is written", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const result = await store.move({
    userId: MALLORY,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 1 }),
    expectedVersion: 0,
  });

  assert.equal(result.status, 403);
  assert.equal(fake.state.writes.length, 0, "a 403 must not write anything");
  assert.equal(moveLog(fake).length, 0);
});

test("move: an open lobby accepts no actions until a second seat lands", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 1 }),
    expectedVersion: 0,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /waiting for an opponent/i);
  assert.equal(fake.state.writes.length, 0);
});

test("move: acting out of turn is refused even though the action is legal", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  // In the equivalent position where it IS Bob's turn, the very same step is
  // legal — so the refusal below is about who is acting, not about the action.
  const bobsTurn = stateAfter([["player1", move({ col: 4, row: 1 })]]);
  const precondition = validateAction(bobsTurn, "player2", move({ col: 4, row: 7 }));
  assert.equal(precondition.ok, true);

  const result = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 7 }),
    expectedVersion: 0,
  });

  assert.equal(result.status, 409);
  assert.equal(result.error !== undefined, true);
  assert.equal(row.ply, 0);
  assert.deepEqual(row.gameState.pawns.player2, { col: 4, row: 8 });
  assert.equal(moveLog(fake).length, 0);
});

test("move: a stale expectedVersion is a clean 409, not a second action", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const seeded = stateAfter([
    ["player1", move({ col: 4, row: 1 })],
    ["player2", move({ col: 4, row: 7 })],
  ]);
  const row = seedMatch(fake, rowFromState(seeded));

  const stale = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 2 }),
    expectedVersion: 0,
  });
  assert.equal(stale.status, 409);
  assert.match(stale.error, /stale/i);
  assert.equal(row.ply, seeded.ply);
  assert.equal(moveLog(fake).length, 0);

  // A version that is not a whole number cannot be a version either.
  const malformed = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 2 }),
    expectedVersion: "not-a-version",
  });
  assert.equal(malformed.status, 409);
  assert.equal(row.ply, seeded.ply);
});

test("move: a replayed ply loses the race as a 409, never as a 500", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  // The unique (match_id, ply) index rejects the second writer structurally.
  fake.state.failInserts.add(barricadeMoves);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 1 }),
    expectedVersion: 0,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /already recorded/i);
  assert.equal(row.ply, 0);
  assert.deepEqual(row.gameState.pawns.player1, { col: 4, row: 0 });
});

test("move: a barricade that seals a route is refused by the engine", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // One barricade is already in the groove that player1's own baseline row
  // touches; his next action goes elsewhere (a legal sideways step), so it is
  // player1's turn again on a position the engine built itself.
  const seeded = stateAfter([
    ["player1", wall(4, 0, "horizontal")],
    ["player2", move({ col: 4, row: 7 })],
    ["player1", move({ col: 3, row: 0 })],
  ]);
  const row = seedMatch(fake, rowFromState(seeded));

  // Two grooves the engine refuses on THIS position — the occupied slot
  // (overlap) and the same slot the other way (crossing). Neither is in the
  // engine's own legal list, which is what the store must agree with.
  const legalKeys = new Set(
    legalWalls(row.gameState, "player1").map(
      (action) => `${action.wall.col}:${action.wall.row}:${action.wall.orientation}`,
    ),
  );
  const refused = [wall(4, 0, "horizontal"), wall(4, 0, "vertical")];
  for (const illegal of refused) {
    assert.equal(
      legalKeys.has(`${illegal.wall.col}:${illegal.wall.row}:${illegal.wall.orientation}`),
      false,
      "the fixture must contain a groove the engine refuses",
    );
  }

  for (const illegal of refused) {
    const result = await store.move({
      userId: ALICE,
      matchId: MATCH_ID,
      action: illegal,
      expectedVersion: row.ply,
    });
    assert.equal(result.status, 409, `${JSON.stringify(illegal)} must be refused`);
    assert.equal(result.match, undefined);
  }
  assert.equal(row.ply, seeded.ply);
  assert.equal(moveLog(fake).length, 0);
});

// ── Victory and settlement ────────────────────────────────────────────────

test("move: reaching the far baseline finishes the match exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Alice's pawn one diagonal jump from row 8, with Bob's pawn blocking the
  // straight line — the engine's own diagonal-jump case.
  const seeded = {
    ...createInitialState(),
    ply: 12,
    pawns: { player1: { col: 4, row: 7 }, player2: { col: 4, row: 8 } },
    wallsRemaining: { player1: 10, player2: 10 },
  };
  const winning = move({ col: 3, row: 8 });
  const verdict = validateAction(seeded, "player1", winning);
  assert.equal(verdict.ok, true, "the fixture must be a legal winning jump");
  assert.equal(verdict.kind, "jump-diagonal");

  const row = seedMatch(fake, rowFromState(seeded));

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: winning,
    expectedVersion: 12,
  });

  assert.equal(result.matchCompleted, true);
  assert.equal(result.winnerSeat, "player1");
  assert.equal(result.reason, END_REASONS.REACHED_BASELINE);
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, "player1");
  assert.equal(result.match.winnerId, ALICE);
  assert.equal(result.match.resultReason, END_REASONS.REACHED_BASELINE);
  assert.ok(result.match.endedAt instanceof Date);
  // The engine's own terminal state is what was persisted.
  assert.equal(row.gameState.status, MATCH_STATUS.FINISHED);
  assert.equal(row.gameState.winner, "player1");

  // Settled matches are final: a resignation and a second action are both 409.
  const lateForfeit = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(lateForfeit.status, 409);
  const lateMove = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    action: move({ col: 3, row: 7 }),
    expectedVersion: result.match.ply,
  });
  assert.equal(lateMove.status, 409);
  assert.equal(result.match.result, "player1", "the first settlement stands");
});

// ── Resignation, cancellation, disconnects ────────────────────────────────

test("forfeit: resigning awards the opponent the win and records the reason", { skip: SKIP_REASON }, async (t) => {
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
  // Resigning ends the match; it never moves a pawn.
  assert.equal(JSON.stringify(result.match.gameState), positionBefore);
  assert.equal(moveLog(fake).length, 0);
});

test("cancel: only the creator, and only an open lobby", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const hijack = await store.cancelMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(hijack.status, 403);

  const cancelled = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(cancelled.match.status, MATCH_STATUS.CANCELLED);
  // A cancelled lobby never settled: no winner, no result.
  assert.equal(cancelled.match.result ?? null, null);
  assert.equal(cancelled.match.winnerId ?? null, null);

  // A live match is not a lobby and cannot be cancelled out from under a game.
  fake.reset();
  seedMatch(fake);
  const live = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(live.status, 409);
});

test("disconnect-forfeit: an abandoned duel goes to the seat still present", { skip: SKIP_REASON }, async (t) => {
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
});

test("disconnect-forfeit: an abandoned lobby is cancelled, and a settled match is a no-op", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const abandoned = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: MATCH_ID,
  });
  assert.equal(abandoned.cancelled, true);
  assert.equal(abandoned.forfeited, false);
  assert.equal(abandoned.match.status, MATCH_STATUS.CANCELLED);

  // Idempotent: the realtime retry loop calls this again until it is told to
  // stop, and a terminal row must answer "nothing left to do" rather than fail.
  const again = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: MATCH_ID,
  });
  assert.equal(again.forfeited, false);
  assert.equal(again.cancelled, false);
  assert.equal(fake.state.writes.length, 1, "the second call must not write");
});

// ── Matchmaking (direct create/join only) ─────────────────────────────────

test("createOrJoin: opens one lobby, never seats a host against itself", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // Nobody is waiting: a fresh row is opened, with the caller as host.
  const created = await store.createOrJoin({ userId: ALICE });
  assert.equal(created.joined, false);
  assert.equal(created.match.player1Id, ALICE);
  assert.equal(created.match.player2Id, null);
  assert.equal(created.match.status, MATCH_STATUS.WAITING);
  assert.equal(created.match.ply, 0);
  assert.equal(fake.rowsOf(barricadeMatches).length, 1);
  // One advisory lock guards the whole critical section.
  assert.equal(fake.state.locks.length, 1);

  // The host asking again gets its OWN lobby back rather than a second one.
  const resumed = await store.createOrJoin({ userId: ALICE });
  assert.equal(resumed.joined, false);
  assert.equal(resumed.match.id, created.match.id);
  assert.equal(fake.rowsOf(barricadeMatches).length, 1, "no second lobby is opened");

  // The joiner takes the second seat and the match starts immediately.
  const joined = await store.createOrJoin({ userId: BOB });
  assert.equal(joined.joined, true);
  assert.equal(joined.match.player2Id, BOB);
  assert.equal(joined.match.status, MATCH_STATUS.PLAYING);
  assert.ok(joined.match.startedAt instanceof Date);
  assert.equal(joined.match.currentTurnUserId, ALICE);
  // Joining regenerates nothing: the position is still the engine's opening one.
  assert.deepEqual(joined.match.gameState, createInitialState());
});

// ── Reads and guards ──────────────────────────────────────────────────────

test("fetchMatch: only a participant can read, and both reserves are public", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const stranger = await store.fetchMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(stranger.status, 403);

  const asAlice = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(asAlice.dto.viewerSeat, "player1");
  assert.equal(asAlice.dto.opponentSeat, "player2");
  assert.equal(asAlice.dto.isViewerTurn, true);
  assert.equal(asAlice.dto.version, 0);
  // Perfect information: the opponent's reserve is part of the snapshot, which
  // is what lets a seat show how many barricades the other has left.
  assert.equal(asAlice.dto.wallsRemaining.player2, 10);
  assert.equal(asAlice.dto.winnerId, null);
  assert.equal(asAlice.dto.result, null);

  const asBob = await store.fetchMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(asBob.dto.viewerSeat, "player2");
  assert.equal(asBob.dto.isViewerTurn, false, "the same row projects per viewer");
});

test("fetchMatch: an unknown match is a 404, not an empty snapshot", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const missing = await store.fetchMatch({
    userId: ALICE,
    matchId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(missing.status, 404);

  const nothingToDo = await store.forfeitMatchOnDisconnect({
    userId: ALICE,
    matchId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(nothingToDo.status, 404);
});

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

test("rejection codes: every verdict maps to a stable HTTP status", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  // A shape error is the client's fault (400)…
  const malformed = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { type: "teleport" },
    expectedVersion: 0,
  });
  assert.equal(malformed.status, 400);

  // …while a position the engine refuses is a stale view (409).
  const occupied = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    action: move({ col: 4, row: 8 }),
    expectedVersion: 0,
  });
  assert.equal(occupied.status, 409);
  assert.equal(moveLog(fake).length, 0);

  // The code vocabulary the routes and the UI read is the engine's own.
  assert.equal(REJECTION.NOT_YOUR_TURN, "not-your-turn");
  assert.equal(REJECTION.WALL_OVERLAP, "wall-overlap");
  assert.equal(ACTION_TYPES.MOVE, "move");
});
