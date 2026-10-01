/**
 * tic-tac-toe-store.test.mjs
 *
 * The AUTHORITATIVE MATCH STORE, driven for real.
 *
 * The model under test, in one line: a client may only ever say WHICH CELL IT
 * MEANT. Every mark, the board, whose turn it is, the winner, the draw, the
 * match result, the Elo change and the trophies are derived by the server from
 * its own state. So most of what these tests do is try to make the store accept
 * something a client is not allowed to decide — and watch it refuse, or ignore
 * the claim and derive the truth anyway.
 *
 * The store reuses the platform's shared writers rather than owning any rating
 * or trophy maths, so the settlement assertions here are about the SEAM:
 * `applyRatingResult` / `applyTrophyResult` are called exactly once per finished
 * match, with the canonical literal `gameKey: "tic-tac-toe"`, inside the same
 * transaction that flips the row terminal — and NEVER for a practice match, a
 * cancelled lobby or a draw's win counters.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/speed-typing-store.test.mjs and
 * tests/keno-pvp-ai-audit.test.mjs: a fake Drizzle client that ignores WHERE
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
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/tic-tac-toe-store.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { ticTacToeMatches, ticTacToeMoves, users } from "../src/db/schema.ts";
import { MATCH_STATUS, RESULT } from "../src/lib/tic-tac-toe/constants.ts";
import { createInitialState } from "../src/lib/tic-tac-toe/rules.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:tic-tac-toe";

const MATCH_ID = "77777777-7777-4777-8777-777777777777";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";

const seatAt = (ply) => (ply % 2 === 0 ? "player1" : "player2");
const userAt = (ply) => (seatAt(ply) === "player1" ? ALICE : BOB);

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
    // Tables whose next INSERT should fail with a Postgres unique-violation,
    // so the store's race-loser path can be driven for real.
    failInserts: new Set(),
  };

  // Columns a real INSERT leaves unset read back as NULL (or the column
  // default). The fake has no schema metadata, so the nullable columns the
  // assertions care about are declared here rather than silently reading as
  // `undefined`.

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

  const NULLABLE_DEFAULTS = new Map([
    [
      ticTacToeMatches,
      {
        player2Id: null,
        winnerId: null,
        result: null,
        startedAt: null,
        endedAt: null,
      },
    ],
    [users, { gamesWon: 0, gamesLost: 0 }],
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

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.writes = [];
    state.locks = [];
    state.failInserts.clear();
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
 * the same tracker (`ERR_INVALID_STATE`), so a test that needs several scenarios
 * calls this ONCE and then `resetAll(fake)` + re-seeds between them.
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

const loadStore = () => import("../src/lib/tic-tac-toe/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A match row in whatever lifecycle the scenario needs. */
function matchRow(overrides = {}) {
  return {
    id: MATCH_ID,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    currentTurnUserId: ALICE,
    ply: 0,
    status: MATCH_STATUS.PLAYING,
    gameState: createInitialState(),
    isAi: false,
    result: null,
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
  fake.rowsOf(ticTacToeMatches).push(row);
  return row;
}

/** Seed a user row so `gamesWon` / `gamesLost` increments are observable. */
function seedUser(fake, clerkId) {
  const row = { clerkId, gamesWon: 0, gamesLost: 0 };
  fake.rowsOf(users).push(row);
  return row;
}

/** The live match row (updates persist, so this reflects the latest write). */
const liveMatch = (fake) => fake.rowsOf(ticTacToeMatches)[0];

/** Play a list of cells in turn order, threading the version. */
async function playCells(store, fake, cells, { player2Id = BOB } = {}) {
  const results = [];
  for (let ply = 0; ply < cells.length; ply += 1) {
    const result = await store.move({
      userId: seatAt(ply) === "player1" ? ALICE : player2Id,
      matchId: MATCH_ID,
      cellIndex: cells[ply],
      expectedVersion: liveMatch(fake).gameState.version,
    });
    results.push(result);
    if ("error" in result) break;
  }
  return results;
}

const A_WIN = [0, 3, 1, 4, 2]; // X: 0,1,2 — wins on the fifth move
const A_DRAW = [0, 4, 8, 2, 6, 3, 5, 7, 1]; // nine moves, no line

// ── Matchmaking ───────────────────────────────────────────────────────────

test("createOrJoin opens a waiting lobby holding the fresh server state", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const result = await store.createOrJoin({ userId: ALICE });
  assert.equal("error" in result, false);
  assert.equal(result.joined, false);

  const row = liveMatch(fake);
  assert.equal(row.player1Id, ALICE);
  assert.equal(row.player2Id, null);
  assert.equal(row.status, MATCH_STATUS.WAITING);
  assert.equal(row.ply, 0);
  assert.equal(row.isAi, false);
  assert.equal(row.result, null);
  assert.equal(row.currentTurnUserId, ALICE);
  assert.deepEqual(row.gameState.board, new Array(9).fill(null));
  assert.equal(row.gameState.currentTurn, "player1");
  assert.equal(row.gameState.version, 1);

  // The advisory lock is taken, and the queue lifecycle mirror is told about a
  // one-seat lobby.
  assert.equal(fake.state.locks.length, 1);
  assert.deepEqual(
    settlement.queue.filter((entry) => entry.kind === "created").map((e) => e.playerCount),
    [1],
  );
});

test("createOrJoin is idempotent for the same caller — no duplicate lobby", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  await store.createOrJoin({ userId: ALICE });
  const again = await store.createOrJoin({ userId: ALICE });

  assert.equal(again.joined, false);
  assert.equal(fake.rowsOf(ticTacToeMatches).length, 1);
});

test("createOrJoin seats the second player and takes the match straight to playing", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  await store.createOrJoin({ userId: ALICE });
  const joined = await store.createOrJoin({ userId: BOB });

  assert.equal(joined.joined, true);
  const row = liveMatch(fake);
  assert.equal(row.player2Id, BOB);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.ok(row.startedAt);
  // X still to move — joining does not consume a turn.
  assert.equal(row.gameState.currentTurn, "player1");
  assert.equal(row.currentTurnUserId, ALICE);
  assert.equal(row.ply, 0);
  assert.deepEqual(
    settlement.queue.filter((entry) => entry.kind === "created").map((e) => e.playerCount),
    [1, 2],
  );
});

test("listOpenMatches only ever returns lobbies with a free second seat", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  await store.createOrJoin({ userId: ALICE });
  const open = await store.listOpenMatches();
  assert.equal(open.length, 1);
  assert.equal(open[0].player2Id, null);
});

// ── The move: server authority ────────────────────────────────────────────

test("move places the server-derived mark and hands the turn over", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    cellIndex: 4,
    expectedVersion: 1,
  });

  assert.equal("error" in result, false);
  assert.equal(result.mark, "X");
  assert.equal(result.ply, 0);
  const row = liveMatch(fake);
  assert.equal(row.gameState.board[4], "X");
  assert.equal(row.gameState.ply, 1);
  assert.equal(row.gameState.currentTurn, "player2");
  assert.equal(row.currentTurnUserId, BOB);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(row.ply, 1);

  // One append-only log row, keyed by the turn number the seat just played.
  const moves = fake.rowsOf(ticTacToeMoves);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].ply, 0);
  assert.equal(moves[0].playerId, ALICE);
  assert.equal(moves[0].cellIndex, 4);
});

test("move refuses a non-participant with 403 BEFORE reporting match status", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // A FINISHED match: if the status check ran first this would be a 409, which
  // would leak the match's lifecycle to a stranger.
  seedMatch(fake, { status: MATCH_STATUS.FINISHED, endedAt: new Date() });

  const result = await store.move({
    userId: MALLORY,
    matchId: MATCH_ID,
    cellIndex: 0,
  });
  assert.equal(result.status, 403);
  assert.match(result.error, /participant/i);
});

test("move refuses a waiting lobby and a terminal match with 409", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const cases = [
    ["waiting lobby", { status: MATCH_STATUS.WAITING, player2Id: null }, /waiting/i],
    ["finished match", { status: MATCH_STATUS.FINISHED }, /no longer active/i],
    ["cancelled match", { status: MATCH_STATUS.CANCELLED }, /no longer active/i],
  ];

  for (const [label, overrides, pattern] of cases) {
    resetAll(fake);
    seedMatch(fake, overrides);
    const res = await store.move({ userId: ALICE, matchId: MATCH_ID, cellIndex: 0 });
    assert.equal(res.status, 409, label);
    assert.match(res.error, pattern, label);
    // Nothing was written.
    assert.equal(fake.rowsOf(ticTacToeMoves).length, 0, label);
    assert.equal(settlement.rating.length, 0, label);
  }
});

test("move refuses an out-of-turn move", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const result = await store.move({ userId: BOB, matchId: MATCH_ID, cellIndex: 0 });
  assert.equal(result.status, 409);
  assert.match(result.error, /not your turn/i);
  assert.equal(liveMatch(fake).gameState.ply, 0);
});

test("move refuses an occupied cell", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  await store.move({ userId: ALICE, matchId: MATCH_ID, cellIndex: 4, expectedVersion: 1 });
  const taken = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    cellIndex: 4,
    expectedVersion: 2,
  });
  assert.equal(taken.status, 409);
  assert.match(taken.error, /occupied/i);
  // The board is untouched and the turn has not advanced twice.
  assert.equal(liveMatch(fake).gameState.ply, 1);
});

test("move refuses malformed cell indexes as 400 — no Number() coercion", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  for (const bad of [undefined, null, "0", "", true, [], {}, -1, 9, 1.5, NaN, Infinity]) {
    resetAll(fake);
    seedMatch(fake);
    const result = await store.move({ userId: ALICE, matchId: MATCH_ID, cellIndex: bad });
    assert.equal(result.status, 400, JSON.stringify(bad));
    assert.equal(result.error, "Cell index must be an integer in [0, 8]");
    assert.equal(liveMatch(fake).gameState.ply, 0, JSON.stringify(bad));
  }
});

test("move refuses a stale expectedVersion", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  await store.move({ userId: ALICE, matchId: MATCH_ID, cellIndex: 0, expectedVersion: 1 });
  const stale = await store.move({
    userId: BOB,
    matchId: MATCH_ID,
    cellIndex: 1,
    expectedVersion: 1, // the version BEFORE the first move
  });
  assert.equal(stale.status, 409);
  assert.match(stale.error, /stale/i);
  assert.equal(liveMatch(fake).gameState.ply, 1);
});

test("move IGNORES every client-supplied decision attached to the body", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    cellIndex: 3,
    expectedVersion: 1,
    // Hostile extras the store's signature does not even accept:
    winner: BOB,
    winnerId: BOB,
    result: "player2",
    status: "finished",
    ply: 9,
    mark: "O",
    board: ["O", "O", "O", null, null, null, null, null, null],
    currentTurn: "player2",
    matchCompleted: true,
    elo: 9999,
    trophies: 50,
  });

  assert.equal("error" in result, false);
  const row = liveMatch(fake);
  assert.deepEqual(row.gameState.board, [
    null, null, null,
    "X", null, null,
    null, null, null,
  ]);
  assert.equal(row.gameState.board[3], "X"); // the mark derived from ALICE, not "O"
  assert.equal(row.gameState.board[0], null); // the client's board is gone
  assert.equal(row.gameState.ply, 1); // not 9
  assert.equal(row.gameState.currentTurn, "player2"); // derived, not accepted
  assert.equal(row.status, MATCH_STATUS.PLAYING); // not "finished"
  assert.equal(row.winnerId, null);
  assert.equal(row.result, null);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

// ── Completion + settlement ───────────────────────────────────────────────

test("a winning move completes the match and settles exactly once, with the literal game key", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);
  seedUser(fake, ALICE);
  seedUser(fake, BOB);

  const results = await playCells(store, fake, A_WIN);
  assert.equal(results.filter((r) => "error" in r).length, 0);
  assert.equal(results.at(-1).matchCompleted, true);
  assert.deepEqual(results.at(-1).winningLine, [0, 1, 2]);

  const row = liveMatch(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER1);
  assert.equal(row.winnerId, ALICE);
  assert.ok(row.endedAt);
  assert.equal(row.gameState.winner, "player1");
  assert.deepEqual(row.gameState.winningLine, [0, 1, 2]);

  // The shared writers, called ONCE each, with the canonical literal key.
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);
  assert.deepEqual(settlement.rating[0].gameKey, "tic-tac-toe");
  assert.deepEqual(settlement.trophy[0].gameKey, "tic-tac-toe");
  assert.equal(settlement.rating[0].matchId, MATCH_ID);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);

  // Win counters move once each.
  const byId = new Map(fake.rowsOf(users).map((u) => [u.clerkId, u]));
  assert.equal(byId.get(ALICE).gamesWon, 1);
  assert.equal(byId.get(BOB).gamesLost, 1);

  // The canonical queue mirror is told the match completed.
  assert.deepEqual(
    settlement.queue.filter((e) => e.kind === "transition").map((e) => [e.gameKey, e.status]),
    [["tic-tac-toe", "completed"]],
  );
});

test("a second completion attempt is refused and never settles twice", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);
  seedUser(fake, ALICE);
  seedUser(fake, BOB);

  await playCells(store, fake, A_WIN);
  const before = settlement.rating.length;

  // The opponent retries the move that was already played, and the winning seat
  // retries too — both hit a terminal match.
  for (const userId of [BOB, ALICE]) {
    const retry = await store.move({
      userId,
      matchId: MATCH_ID,
      cellIndex: 6,
      expectedVersion: liveMatch(fake).gameState.version,
    });
    assert.equal(retry.status, 409);
  }
  // The move log did not grow, and the rating was not applied again.
  assert.equal(fake.rowsOf(ticTacToeMoves).length, A_WIN.length);
  assert.equal(settlement.rating.length, before);
  assert.equal(settlement.trophy.length, 1);
});

test("a duplicate move that loses a storage race surfaces as a clean 409, not a 500", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);
  // The row-lock loser in a simultaneous-move race: the append-only log's
  // unique index rejects the second write for the same ply/cell with a
  // Postgres 23505, which must be reported as a conflict and roll back cleanly —
  // never a 500, and never a second settlement.
  fake.state.failInserts.add(ticTacToeMoves);

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    cellIndex: 0,
    expectedVersion: 1,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /already recorded/i);
  // The rejected race wrote nothing and settled nothing.
  assert.equal(fake.rowsOf(ticTacToeMoves).length, 0);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("a draw settles with result \"draw\" and changes no win counter", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);
  seedUser(fake, ALICE);
  seedUser(fake, BOB);

  const results = await playCells(store, fake, A_DRAW);
  assert.equal(results.at(-1).matchCompleted, true);

  const row = liveMatch(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.TIE);
  assert.equal(row.winnerId, null);
  assert.equal(row.gameState.winner, null);
  assert.equal(row.gameState.ply, 9);

  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].result, "draw");
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.trophy[0].result, "draw");

  const byId = new Map(fake.rowsOf(users).map((u) => [u.clerkId, u]));
  assert.equal(byId.get(ALICE).gamesWon, 0);
  assert.equal(byId.get(ALICE).gamesLost, 0);
  assert.equal(byId.get(BOB).gamesWon, 0);
  assert.equal(byId.get(BOB).gamesLost, 0);
});

test("a practice (isAi) match is never rated, trophied or queued", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const BOT = "tic_tac_toe_ai_bot";
  seedMatch(fake, { isAi: true, player2Id: BOT, aiDifficulty: "hard" });
  settlement.queue.length = 0;

  // The human opens; the bot answers INSIDE the same call. Because the bot
  // always replies, it is the human's turn again after every accepted move.
  let guard = 0;
  while (liveMatch(fake).status === MATCH_STATUS.PLAYING && guard < 9) {
    guard += 1;
    const live = liveMatch(fake);
    if (live.gameState.currentTurn !== "player1") break;
    const cell = live.gameState.board.findIndex((c) => c === null);
    const res = await store.move({
      userId: ALICE,
      matchId: MATCH_ID,
      cellIndex: cell,
      expectedVersion: live.gameState.version,
    });
    if ("error" in res) break;
  }

  const row = liveMatch(fake);
  // Whatever the outcome, a practice match is excluded from competitive
  // progression entirely — no rating, no trophy and no queue mirror.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  assert.equal(settlement.queue.length, 0);

  // The bot really played: every human move has a bot reply in the log.
  const moves = fake.rowsOf(ticTacToeMoves);
  const botMoves = moves.filter((m) => m.playerId === BOT).length;
  const humanMoves = moves.filter((m) => m.playerId === ALICE).length;
  assert.ok(humanMoves >= 1, "the human played at least once");
  assert.ok(botMoves >= 1, "the bot answered the human's move");
  assert.ok(botMoves <= humanMoves, "the bot never moves twice in a row");
});

test("createAiMatch seats the bot on player2 and marks the row unrated", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  settlement.queue.length = 0;

  const { match } = await store.createAiMatch({ userId: ALICE, difficulty: "normal" });

  assert.equal(match.player1Id, ALICE);
  assert.equal(match.player2Id, "tic_tac_toe_ai_bot");
  assert.equal(match.isAi, true);
  assert.equal(match.aiDifficulty, "normal");
  assert.equal(match.status, MATCH_STATUS.PLAYING);
  assert.equal(match.gameState.currentTurn, "player1");
  assert.equal(match.gameState.ply, 0);
  // Never enters the open-lobby pool: the bot fills player2 immediately, so
  // the row can never satisfy the `player2_id IS NULL` open-lobby predicate,
  // and no queue transition is mirrored.
  assert.equal(settlement.queue.length, 0);
});

test("createAiMatch coerces an unknown difficulty onto the shared scale", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const { match } = await store.createAiMatch({ userId: ALICE, difficulty: "nonsense" });
  assert.equal(match.aiDifficulty, "normal");
});

test("move on a practice match plays the bot's reply in the same call", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const BOT = "tic_tac_toe_ai_bot";
  seedMatch(fake, { isAi: true, player2Id: BOT, aiDifficulty: "hard" });

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    cellIndex: 4,
    expectedVersion: 1,
  });
  assert.equal("error" in result, false);
  // Two plies were applied: the human's X and the bot's O.
  assert.equal(result.state.ply, 2);
  assert.equal(result.state.board[4], "X");
  assert.equal(result.state.board.filter((c) => c === "O").length, 1);
  assert.equal(result.state.board.filter((c) => c === null).length, 7);
  // It is the human's turn again — the bot never leaves itself on move.
  assert.equal(result.state.currentTurn, "player1");
  assert.equal(liveMatch(fake).currentTurnUserId, ALICE);
  const botMoves = fake.rowsOf(ticTacToeMoves).filter((m) => m.playerId === BOT);
  assert.equal(botMoves.length, 1);
});

test("the bot can end the match on its own reply and never moves again after", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const BOT = "tic_tac_toe_ai_bot";
  // O (the bot) already holds 0 and 3; the human must play 8, then the bot
  // needs only cell 6 to complete 0,3,6 and win.
  const board = ["O", null, null, "O", null, null, null, null, null];
  seedMatch(fake, {
    isAi: true,
    player2Id: BOT,
    aiDifficulty: "hard",
    gameState: { ...createInitialState(), board, currentTurn: "player1", ply: 4, version: 5 },
  });

  const result = await store.move({
    userId: ALICE,
    matchId: MATCH_ID,
    cellIndex: 8,
    expectedVersion: 5,
  });
  assert.equal("error" in result, false);
  assert.equal(result.matchCompleted, true);
  assert.equal(result.winnerSeat, "player2");
  const row = liveMatch(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.winnerId, BOT);
  // A bot win must never settle a rating or trophy either.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
  // After the match is decided the bot does not append any further move.
  assert.equal(fake.rowsOf(ticTacToeMoves).filter((m) => m.playerId === BOT).length, 1);
});

test("a human move on a practice match is still validated as usual", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { isAi: true, player2Id: "tic_tac_toe_ai_bot", aiDifficulty: "easy" });

  // Out-of-turn: the bot is player2 and X (player1) opens, so a player2 claim
  // from the human is rejected before anything is played.
  const outOfTurn = await store.move({
    userId: "tic_tac_toe_ai_bot",
    matchId: MATCH_ID,
    cellIndex: 0,
    expectedVersion: 1,
  });
  assert.equal(outOfTurn.status, 409);
  assert.match(outOfTurn.error, /not your turn/i);
});

// ── Forfeit / cancel / disconnect ─────────────────────────────────────────

test("forfeit awards the opponent the win through the same settlement path", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);
  seedUser(fake, ALICE);
  seedUser(fake, BOB);

  const result = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal("error" in result, false);
  const row = liveMatch(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER1);
  assert.equal(row.winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);
});

test("forfeit is refused on a lobby that has not been joined", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const result = await store.forfeitMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(result.status, 409);
  assert.equal(settlement.rating.length, 0);
});

test("forfeit is refused for a non-participant", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const result = await store.forfeitMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(result.status, 403);
  assert.equal(settlement.rating.length, 0);
});

test("disconnect on an active match forfeits to the seat still present", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);
  seedUser(fake, ALICE);
  seedUser(fake, BOB);

  const result = await store.forfeitMatchOnDisconnect({ userId: BOB, matchId: MATCH_ID });
  assert.equal(result.forfeited, true);
  assert.equal(result.cancelled, false);
  assert.equal(liveMatch(fake).winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);
});

test("disconnect on an unjoined lobby cancels it and settles nothing", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const result = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(result.forfeited, false);
  assert.equal(result.cancelled, true);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.CANCELLED);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("disconnect on a terminal match is an idempotent no-op, not an error", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.FINISHED });

  const result = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID });
  assert.equal("error" in result, false);
  assert.equal(result.forfeited, false);
  assert.equal(result.cancelled, false);
  assert.equal(settlement.rating.length, 0);
});

test("cancelMatch only closes the creator's own unjoined lobby", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  // A stranger cannot cancel it.
  const refused = await store.cancelMatch({ userId: BOB, matchId: MATCH_ID });
  assert.equal(refused.status, 403);

  const cancelled = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal("error" in cancelled, false);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.CANCELLED);
  // A cancelled lobby never settled.
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("cancelMatch cannot close a match an opponent has already joined", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const result = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(result.status, 409);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.PLAYING);
});

// ── Reads ─────────────────────────────────────────────────────────────────

test("fetchMatch returns the viewer DTO and 403s a non-participant", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  const asAlice = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal("error" in asAlice, false);
  assert.equal(asAlice.dto.viewerSeat, "player1");
  assert.equal(asAlice.dto.viewerMark, "X");
  assert.equal(asAlice.dto.viewerCanMove, true);
  assert.equal(asAlice.dto.boardSize, 3);

  const outsider = await store.fetchMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.dto, undefined);
});

test("matchToDto reports a conceded match from the row, not the board", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    status: MATCH_STATUS.FINISHED,
    result: RESULT.PLAYER2,
    winnerId: BOB,
  });

  const result = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID });
  assert.equal(result.dto.result, RESULT.PLAYER2);
  assert.equal(result.dto.winnerId, BOB);
  assert.equal(result.dto.status, MATCH_STATUS.FINISHED);
  assert.equal(result.dto.viewerCanMove, false);
});

test("every mutator takes exactly one transaction", async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // Matchmaking is the only mutator that needs a cross-matchlock: it takes the
  // per-game advisory lock so two callers cannot both create a lobby.
  await store.createOrJoin({ userId: ALICE });
  assert.equal(fake.state.transactions, 1, "createOrJoin");
  assert.equal(fake.state.locks.length, 1, "createOrJoin advisory lock");

  const cases = [
    ["move", () => store.move({ userId: ALICE, matchId: MATCH_ID, cellIndex: 0, expectedVersion: 1 })],
    ["forfeitMatch", () => store.forfeitMatch({ userId: ALICE, matchId: MATCH_ID })],
    ["cancelMatch", () => store.cancelMatch({ userId: ALICE, matchId: MATCH_ID })],
    ["forfeitMatchOnDisconnect", () => store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID })],
  ];

  for (const [label, run] of cases) {
    resetAll(fake);
    seedMatch(fake);
    await run();
    // One transaction per action — and no advisory lock, because these are all
    // scoped to a single match row (locked with SELECT … FOR UPDATE).
    assert.equal(fake.state.transactions, 1, label);
    assert.equal(fake.state.locks.length, 0, label);
  }
});

// ── Route-level guard ─────────────────────────────────────────────────────

test("isMatchId accepts only a uuid, so a bad id never reaches a Postgres cast", async (t) => {
  installMocks(t);
  const store = await loadStore();

  assert.equal(store.isMatchId(MATCH_ID), true);
  for (const bad of ["", "abc", "1 OR 1=1", null, undefined, 42, {}, `${MATCH_ID}x`]) {
    assert.equal(store.isMatchId(bad), false, JSON.stringify(bad));
  }
});
