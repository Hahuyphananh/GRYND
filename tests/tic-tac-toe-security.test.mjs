/**
 * tic-tac-toe-security.test.mjs
 *
 * COMPETITIVE-INTEGRITY / MULTIPLAYER-SYNC pass. Every client → server path,
 * attacked — and every state transition, observed from BOTH seats.
 *
 * ── WHY THIS FILE IS DIFFERENT ──────────────────────────────────────────
 *
 * `tic-tac-toe-rules.test.mjs` pins the pure engine, `tic-tac-toe-store.test.mjs`
 * pins the authoritative store, and `tic-tac-toe-ui-contract.test.mjs` pins the
 * source. This one drives the ACTUAL HTTP HANDLERS (move / forfeit / cancel /
 * match snapshot / create-or-join) with hostile payloads, exactly like
 * `speed-typing-security.test.mjs`.
 *
 * Only three things are faked:
 *
 *   * the age/auth gate  — so a request can be issued AS a chosen identity,
 *   * the database       — an in-memory fake whose transactions are SERIALISED,
 *                          which models the store's `SELECT … FOR UPDATE`,
 *   * the shared progression writers + seat identity — spied on, never
 *                          implemented here.
 *
 * The ROUTES and the STORE are the real production modules, so an assertion
 * like "forging `winner` changes nothing" is a statement about the shipped
 * code path, not about a regex.
 *
 * ── THE TRUST MODEL UNDER ATTACK ────────────────────────────────────────
 *
 *   A CLIENT MAY ONLY EVER SAY WHICH CELL IT MEANT.
 *
 * The mark, the board, whose turn it is, the winner, the draw, the match
 * result, the rating change and the trophies are all derived by the server from
 * the row it locked. Everything else in a request body is not "validated", it
 * is IGNORED, because no code path reads it.
 *
 * Run:  npm run test:tic-tac-toe
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ticTacToeMatches, ticTacToeMoves } from "../src/db/schema.ts";
import { MATCH_STATUS, RESULT } from "../src/lib/tic-tac-toe/constants.ts";
import { createInitialState } from "../src/lib/tic-tac-toe/rules.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:tic-tac-toe";

const MATCH_ID = "1a2b3c4d-1111-4111-8111-111111111111";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";

const R = {
  createOrJoin: "src/app/api/tic-tac-toe/create-or-join/route.ts",
  createAi: "src/app/api/tic-tac-toe/create-ai/route.ts",
  available: "src/app/api/tic-tac-toe/available/route.ts",
  match: "src/app/api/tic-tac-toe/match/[matchId]/route.ts",
  move: "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts",
  forfeit: "src/app/api/tic-tac-toe/match/[matchId]/forfeit/route.ts",
  cancel: "src/app/api/tic-tac-toe/match/[matchId]/cancel/route.ts",
  disconnect: "src/app/api/tic-tac-toe/disconnect-forfeit/route.ts",
};

// X opens game shapes used across the suite.
const A_WIN = [0, 3, 1, 4, 2]; // X: 0,1,2 — horizontal, wins on ply 5
const O_WIN = [1, 0, 2, 3, 4, 6]; // O: 0,3,6 — vertical, wins on ply 6
const A_DRAW = [0, 4, 8, 2, 6, 3, 5, 7, 1]; // nine moves, no line

// ── The fake database (transactions serialised, like a row lock) ──────────

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    writes: [],
    locks: [],
    inFlight: 0,
    maxConcurrent: 0,
  };

  const rowsOf = (table) => {
    if (!state.tables.has(table)) state.tables.set(table, []);
    return state.tables.get(table);
  };

  const isSqlExpression = (value) =>
    Boolean(value) && typeof value === "object" && "queryChunks" in value;

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
            // The win/loss counters are SQL increments; emulate just that so a
            // read after the write sees a number.
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
      const row = {
        id: `row-${state.nextId++}`,
        createdAt: new Date(),
        ...(table === ticTacToeMatches
          ? { player2Id: null, winnerId: null, result: null, startedAt: null, endedAt: null }
          : {}),
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

  // The row lock, modelled: two transactions can never overlap, so the second
  // one reads the state the first committed — exactly as `FOR UPDATE` behaves.
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

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.writes = [];
    state.locks = [];
    state.inFlight = 0;
    state.maxConcurrent = 0;
    chain = Promise.resolve();
  };

  return { state, reset, rowsOf, db: { transaction, select, update, insert } };
}

// ── Mutable attack surface, shared across tests ───────────────────────────

/** WHO the request is issued as. The routes must never read an id from a body. */
const session = { userId: ALICE, gate: "ok", queue: null };
/** Every shared progression writer call. */
const writers = { rating: [], trophy: [], queue: [] };
/** Every broadcast a route attempted. */
const broadcasts = [];

let sharedFake = null;

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  session.userId = ALICE;
  session.gate = "ok";
  session.queue = null;
  writers.rating.length = 0;
  writers.trophy.length = 0;
  writers.queue.length = 0;
  broadcasts.length = 0;

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });

  // The gate is the ONE thing a request cannot choose for itself — it is
  // mocked to a known identity so the attacker's choices are visible.
  t.mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: {
      requireAgeVerifiedUser: async () => {
        if (session.gate === "signed-out") {
          return {
            response: Response.json(
              { success: false, error: "Unauthorized" },
              { status: 401 },
            ),
            userId: null,
          };
        }
        if (session.gate === "blocked") {
          return {
            response: Response.json(
              { success: false, error: "Age verification required" },
              { status: 403 },
            ),
            userId: null,
          };
        }
        // Concurrent requests may each need a distinct identity; the queue
        // hands one out per call, otherwise the standing session is used.
        const id =
          session.queue && session.queue.length ? session.queue.shift() : session.userId;
        return { response: null, userId: id };
      },
    },
  });

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
  t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
    namedExports: {
      mirrorQueueCreated: (args) => writers.queue.push({ kind: "created", ...args }),
      mirrorQueueTransition: (args) => writers.queue.push({ kind: "transition", ...args }),
    },
  });
  t.mock.module("../src/lib/seatIdentity.js", {
    namedExports: {
      getSeatIdentity: async (player1Id, player2Id) => ({
        player1: { name: "Alice", iconKey: null, profileFrame: null },
        player2: player2Id
          ? { name: "Bob", iconKey: null, profileFrame: null }
          : null,
      }),
    },
  });
  t.mock.module("../src/lib/logError.ts", { namedExports: { logError: async () => {} } });

  // Capture every broadcast, so a leak can be asserted on the wire too.
  const previousIo = globalThis.io;
  globalThis.io = {
    to: (room) => ({
      emit: (event, payload) => broadcasts.push({ room, event, payload }),
    }),
  };
  t.after(() => {
    globalThis.io = previousIo;
  });

  return fake;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

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

function seedMatch(fake, overrides = {}) {
  const row = matchRow(overrides);
  fake.rowsOf(ticTacToeMatches).push(row);
  return row;
}

const rowOf = (fake) => fake.rowsOf(ticTacToeMatches)[0];
const liveVersion = (fake) => rowOf(fake).gameState.version;

// ── Request helper: the REAL route handlers ───────────────────────────────

/**
 * Invoke a real route handler. `as` picks the mocked age-gate identity; the
 * param signature is identical for every route, so one helper covers them all.
 */
async function invoke(routeRelPath, { method = "POST", matchId = MATCH_ID, body, raw, as } = {}) {
  if (as) session.userId = as;
  const mod = await import(`../${routeRelPath}`);
  const path = routeRelPath.replace(/\[matchId\]/g, matchId);
  const req = new Request(`http://ttt.test/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) }),
  });
  const res = await mod[method](req, { params: Promise.resolve({ matchId }) });
  return { status: res.status, json: await res.json() };
}

const getMatch = (opts = {}) => invoke(R.match, { method: "GET", ...opts });
const move = (body, opts = {}) => invoke(R.move, { body, ...opts });
const forfeit = (opts = {}) => invoke(R.forfeit, opts);
const cancel = (opts = {}) => invoke(R.cancel, opts);

/** Play a list of cells through the REAL /move route, threading the version. */
async function playRoute(fake, cells) {
  const results = [];
  for (let ply = 0; ply < cells.length; ply += 1) {
    const who = ply % 2 === 0 ? ALICE : BOB;
    const res = await move(
      { boardIndex: 0, cellIndex: cells[ply], expectedVersion: liveVersion(fake) },
      { as: who },
    );
    results.push(res);
    if (res.status !== 200) break;
  }
  return results;
}

// ════════════════════════════════════════════════════════════════════════
// 0. The surface itself
// ════════════════════════════════════════════════════════════════════════

test("surface: the route list is exactly the audited one, and every route is gated", () => {
  const root = "src/app/api/tic-tac-toe";
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "route.ts") found.push(join(dir, entry.name).replace(/\\/g, "/"));
    }
  };
  walk(root);
  assert.deepEqual(found.sort(), Object.values(R).sort());

  for (const [name, path] of Object.entries(R)) {
    const src = readFileSync(path, "utf8");
    if (name === "disconnect") {
      assert.match(src, /verifyToken\(/, `${name} must verify its own token`);
      continue;
    }
    assert.match(src, /requireAgeVerifiedUser\(\)/, `${name} must be session-gated`);
  }

  // No route accepts a decision-shaped field off a body.
  for (const path of Object.values(R)) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(
      src,
      /body\??\.(winner|winnerId|loserId|result|draw|tie|board|mark|currentTurn|turn|ply|status|elo|rating|trophies|trophy|matchCompleted|completed)\b/,
      `${path} must not read a client-supplied decision`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// 1. Authorization / participation
// ════════════════════════════════════════════════════════════════════════

test("unauthorized: a signed-out or age-blocked caller is refused before any work", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  for (const gate of ["signed-out", "blocked"]) {
    session.gate = gate;
    const expected = gate === "signed-out" ? 401 : 403;
    assert.equal((await getMatch({ as: ALICE })).status, expected, `GET ${gate}`);
    assert.equal(
      (await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE })).status,
      expected,
      `move ${gate}`,
    );
    assert.equal((await forfeit({ as: ALICE })).status, expected, `forfeit ${gate}`);
    assert.equal((await cancel({ as: ALICE })).status, expected, `cancel ${gate}`);
    assert.equal((await invoke(R.createOrJoin, { as: ALICE })).status, expected, `create ${gate}`);
  }

  assert.equal(fake.state.writes.length, 0, "nothing was written");
  assert.equal(fake.state.transactions, 0, "the gate runs before any transaction");
  assert.equal(writers.rating.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
});

test("non-participant: a stranger cannot read, move, forfeit or cancel", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  session.userId = MALLORY;
  assert.equal((await getMatch()).status, 403, "the snapshot is participant-only");
  assert.equal((await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 })).status, 403);
  assert.equal((await forfeit()).status, 403);
  assert.equal((await cancel()).status, 403, "only the creator may cancel");
  // An unjoined lobby cannot be forfeited either (no opponent to award).
  assert.equal(fake.state.writes.length, 0);
  assert.equal(writers.rating.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
});

test("non-participant: a well-formed but unknown match id is a 404, and a bad id never reaches the driver", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);

  // No match of that id exists → the not-found path, for both a read and a write.
  const ghost = "2b3c4d5e-1111-4111-8111-111111111111";
  session.userId = ALICE;
  assert.equal((await getMatch({ matchId: ghost })).status, 404);
  assert.equal((await move({ boardIndex: 0, cellIndex: 0 }, { matchId: ghost })).status, 404);

  // A malformed id is rejected at the route — it never reaches a uuid cast.
  seedMatch(fake);
  for (const bad of ["", "not-a-uuid", "1 OR 1=1", "../../etc/passwd", "a".repeat(200)]) {
    assert.equal((await move({ boardIndex: 0, cellIndex: 0 }, { matchId: bad })).status, 400, `move ${bad}`);
    assert.equal((await forfeit({ matchId: bad })).status, 400, `forfeit ${bad}`);
  }
  assert.equal(fake.state.writes.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Server authority — the client cannot decide anything
// ════════════════════════════════════════════════════════════════════════

test("authority: a client cannot declare a winner, a draw, a result or a completion", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const res = await move(
    {
      boardIndex: 0,
      cellIndex: 3,
      expectedVersion: liveVersion(fake),
      // Every field a hostile client might attach. None of them is read.
      winner: BOB,
      winnerId: BOB,
      loserId: ALICE,
      result: "player2",
      outcome: "win",
      draw: true,
      tie: true,
      matchCompleted: true,
      completed: true,
      finished: true,
      status: "finished",
      phase: "finished",
      ply: 9,
      mark: "O",
      board: ["O", "O", "O", null, null, null, null, null, null],
      currentTurn: "player2",
      turn: "player2",
      currentTurnUserId: BOB,
      elo: 9_999,
      rating: 9_999,
      delta: 500,
      trophies: 9_999,
      trophy: 9_999,
      settle: true,
      appliedRating: true,
    },
    { as: ALICE },
  );

  assert.equal(res.status, 200);
  const row = rowOf(fake);
  // The server derived everything: the mark from ALICE's seat, the board from
  // its own state, the turn from the ply.
  assert.equal(row.gameState.boards[0].cells[3], "X", "the mark is the mover's, not the body's");
  assert.equal(row.gameState.boards[0].cells.filter(Boolean).length, 1, "the client's board is gone");
  assert.deepEqual(row.gameState.boards[0].cells.slice(0, 3), [null, null, null]);
  assert.equal(row.gameState.ply, 1, "not 9");
  assert.equal(row.gameState.currentTurn, "player2", "derived, not accepted");
  assert.equal(row.status, MATCH_STATUS.PLAYING, "not finished");
  assert.equal(row.gameState.phase, "playing");
  assert.equal(row.gameState.winner, null);
  assert.equal(row.result, null);
  assert.equal(row.winnerId, null);
  // No progression was touched.
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
  assert.equal(writers.queue.filter((q) => q.status === "completed").length, 0);
  // The response reports the SERVER's outcome, not the body's.
  assert.equal(res.json.data.result, null);
  assert.equal(res.json.data.winnerId, null);
  assert.equal(res.json.data.matchCompleted, false);
  assert.equal(res.json.data.match.status, MATCH_STATUS.PLAYING);
  assert.equal(res.json.data.match.viewerCanMove, false, "it is now the opponent's turn");
});

test("authority: the game logic enforces turn, occupancy and a valid index through the route", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // Out of turn: O cannot open the match.
  const wrongTurn = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: BOB });
  assert.equal(wrongTurn.status, 409);
  assert.match(wrongTurn.json.error, /not your turn/i);
  assert.equal(rowOf(fake).gameState.ply, 0);

  // A valid move by X.
  const opened = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.data.move.mark, "X");
  assert.equal(opened.json.data.move.boardIndex, 0);
  assert.equal(opened.json.data.move.cellIndex, 0);

  // Occupied cell: O cannot take the cell X just claimed.
  const taken = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(taken.status, 409);
  assert.match(taken.json.error, /occupied/i);
  assert.equal(rowOf(fake).gameState.ply, 1);

  // Invalid / malformed indexes are a 400, and each attempt leaves the board
  // untouched. A fresh match is seeded per case so it is X's turn throughout.
  for (const bad of [-1, 9, 1.5, "0", "", true, [], {}, null, undefined, NaN, Infinity]) {
    fake.reset();
    seedMatch(fake);
    const res = await move({ boardIndex: 0, cellIndex: bad, expectedVersion: 1 }, { as: ALICE });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(res.json.error, /cell index/i);
    assert.equal(rowOf(fake).gameState.ply, 0, JSON.stringify(bad));
  }

  // Invalid / malformed BOARD indexes are a 400 too, and a valid-but-not-yet
  // materialised slot is a clean 409 — never a silent play on another board.
  for (const badBoard of [undefined, null, "0", true, [], -1, 9, 1.5, NaN]) {
    fake.reset();
    seedMatch(fake);
    const res = await move({ boardIndex: badBoard, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
    assert.equal(res.status, 400, JSON.stringify(badBoard));
    assert.match(res.json.error, /board index/i);
    assert.equal(rowOf(fake).gameState.ply, 0, JSON.stringify(badBoard));
  }
  for (const notYet of [1, 4, 8]) {
    fake.reset();
    seedMatch(fake);
    const res = await move({ boardIndex: notYet, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
    assert.equal(res.status, 409, `board ${notYet}`);
    assert.match(res.json.error, /not in play/i, `board ${notYet}`);
  }

  // A body that is not JSON at all is a 400, not a 500.
  fake.reset();
  seedMatch(fake);
  const garbage = await move("{not json", { as: ALICE, raw: true });
  assert.equal(garbage.status, 400);
});

test("authority: a stale expectedVersion is refused, and a double-submit cannot apply twice", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  assert.equal((await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE })).status, 200);
  const stale = await move({ boardIndex: 0, cellIndex: 1, expectedVersion: 1 }, { as: BOB });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /stale/i);
  assert.equal(rowOf(fake).gameState.ply, 1, "only one move landed");
  // Malformed tokens are refused rather than coerced.
  for (const bad of [true, "2", [2], 2.5]) {
    assert.equal(
      (await move({ boardIndex: 0, cellIndex: 1, expectedVersion: bad }, { as: BOB })).status,
      409,
      JSON.stringify(bad),
    );
  }
});

test("authority: a move after the match is decided is refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, A_WIN);
  assert.equal(rowOf(fake).status, MATCH_STATUS.FINISHED);

  const movesAfter = fake.rowsOf(ticTacToeMoves).length;
  for (const who of [ALICE, BOB]) {
    const res = await move({ boardIndex: 0, cellIndex: 6, expectedVersion: liveVersion(fake) }, { as: who });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /no longer active/i);
  }
  assert.equal(fake.rowsOf(ticTacToeMoves).length, movesAfter);
  assert.equal(writers.rating.length, 1, "and never re-settled");
});

// ════════════════════════════════════════════════════════════════════════
// 3. Game logic end-to-end (through the real route)
// ════════════════════════════════════════════════════════════════════════

test("logic: X completes a line and the match settles once, with the shared writers", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const results = await playRoute(fake, A_WIN);
  assert.equal(results.filter((r) => r.status !== 200).length, 0);
  assert.equal(results.at(-1).json.data.matchCompleted, true);
  assert.deepEqual(results.at(-1).json.data.winningLine, [0, 1, 2]);
  assert.equal(results.at(-1).json.data.winnerId, ALICE);
  assert.equal(results.at(-1).json.data.result, RESULT.PLAYER1);

  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER1);
  assert.equal(row.winnerId, ALICE);
  assert.ok(row.endedAt);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
  assert.equal(writers.rating[0].gameKey, "tic-tac-toe");
  assert.equal(writers.rating[0].matchId, MATCH_ID);
  assert.equal(writers.rating[0].winnerClerkId, ALICE);
  assert.equal(writers.rating[0].loserClerkId, BOB);
});

test("logic: O completes a vertical line and loses nothing to the turn order", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  await playRoute(fake, O_WIN);
  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER2);
  assert.equal(row.winnerId, BOB);
  assert.deepEqual(row.gameState.boards[0].winningLine, [0, 3, 6]);
  assert.deepEqual(row.gameState.winningBoards, [0]);
  assert.equal(writers.rating[0].winnerClerkId, BOB);
  assert.equal(writers.rating[0].loserClerkId, ALICE);
});

test("logic: a full opening board with no line EXPANDS — it never settles", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const results = await playRoute(fake, A_DRAW);
  // The last move resolved the board but did NOT finish the match.
  assert.equal(results.at(-1).json.data.matchCompleted, false);
  assert.equal(results.at(-1).json.data.stage, 2);

  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(row.result, null);
  assert.equal(row.winnerId, null);
  assert.equal(row.gameState.stage, 2);
  assert.equal(row.gameState.ply, 9);
  assert.equal(row.gameState.boards[0].control, "draw");
  // An expansion is not a result: no rating, trophy or queue completion.
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
  assert.equal(writers.queue.filter((q) => q.status === "completed").length, 0);
});

test("logic: after an expansion, play continues on the new empty boards", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, A_DRAW); // nine plies: O (BOB) is to move at stage 2

  // Board 0 is locked; a move on it is refused. The three new boards accept.
  const locked = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(locked.status, 409);
  assert.match(locked.json.error, /locked/i);

  const opened = await move({ boardIndex: 1, cellIndex: 4, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.data.move.boardIndex, 1);
  const row = rowOf(fake);
  assert.equal(row.gameState.boards[1].cells[4], "O");
  assert.equal(row.gameState.boards[0].control, "draw", "the original board is untouched");
  assert.equal(row.gameState.stage, 2);
  assert.equal(row.gameState.ply, 10);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Concurrency
// ════════════════════════════════════════════════════════════════════════

test("concurrency: two simultaneous moves — the row lock commits exactly one", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // Both requests are entered before either transaction commits; the queue
  // hands each one a distinct identity so the two seats really are different.
  session.queue = [ALICE, BOB];
  const [a, b] = await Promise.all([
    move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }),
    move({ boardIndex: 0, cellIndex: 4, expectedVersion: 1 }),
  ]);

  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialised the two writes");
  const accepted = [a, b].filter((r) => r.status === 200);
  const rejected = [a, b].filter((r) => r.status !== 200);
  assert.equal(accepted.length, 1, "exactly one move wins");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].status, 409, "the loser is a clean conflict");
  assert.equal(fake.rowsOf(ticTacToeMoves).length, 1, "one mark was persisted");
  assert.equal(rowOf(fake).gameState.boards[0].cells.filter(Boolean).length, 1);
  assert.equal(writers.rating.length, 0, "an unfinished match settled nothing");
});

test("concurrency: a duplicated move request cannot apply twice", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // The same click, retried while the first request is still in flight.
  const [first, second] = await Promise.all([
    move({ boardIndex: 0, cellIndex: 2, expectedVersion: 1 }, { as: ALICE }),
    move({ boardIndex: 0, cellIndex: 2, expectedVersion: 1 }, { as: ALICE }),
  ]);

  assert.equal(fake.state.maxConcurrent, 1);
  assert.equal([first, second].filter((r) => r.status === 200).length, 1);
  assert.equal([first, second].filter((r) => r.status === 409).length, 1);
  assert.equal(fake.rowsOf(ticTacToeMoves).length, 1);
  const row = rowOf(fake);
  assert.equal(row.gameState.boards[0].cells.filter(Boolean).length, 1);
  assert.equal(row.gameState.ply, 1, "the ply advanced once, never twice");
});

test("concurrency: a storage-level duplicate (unique violation) is a clean 409", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // Simulate the unique index rejecting a replayed append. The store must map
  // it to a 409 and roll back, never surface a 500 or settle.
  const original = fake.rowsOf(ticTacToeMoves);
  const realPush = original.push.bind(original);
  let fail = true;
  original.push = (row) => {
    if (fail) {
      fail = false;
      throw Object.assign(new Error("duplicate key values"), { code: "23505" });
    }
    return realPush(row);
  };

  const res = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /already recorded/i);
  assert.equal(writers.rating.length, 0);

  // The next (honest) attempt succeeds once the constraint is satisfied.
  const ok = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
  assert.equal(ok.status, 200);
});

test("concurrency: repeated completion and repeated settlement happen exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, A_WIN);

  assert.equal(writers.rating.length, 1, "settled once");
  assert.equal(writers.trophy.length, 1);
  const movesAfter = fake.rowsOf(ticTacToeMoves).length;
  const writesAfter = fake.state.writes.length;

  // Hammer the board from both seats…
  for (let i = 0; i < 20; i += 1) {
    const who = i % 2 === 0 ? BOB : ALICE;
    const res = await move({ boardIndex: 0, cellIndex: 6, expectedVersion: liveVersion(fake) }, { as: who });
    assert.equal(res.status, 409, `retry ${i}`);
  }
  // …and the forfeit path too.
  assert.equal((await forfeit({ as: BOB })).status, 409);
  assert.equal((await forfeit({ as: ALICE })).status, 409);

  assert.equal(fake.rowsOf(ticTacToeMoves).length, movesAfter, "no replay wrote a row");
  assert.equal(fake.state.writes.length, writesAfter, "no replay wrote anything");
  assert.equal(writers.rating.length, 1, "rating settled exactly once");
  assert.equal(writers.trophy.length, 1, "trophies settled exactly once");
  assert.equal(writers.queue.filter((q) => q.status === "completed").length, 1);
  assert.equal(rowOf(fake).winnerId, ALICE);
});

test("concurrency: repeated disconnect resolution (the realtime retry loop) settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // Drive the same store call the socket endpoint delegates to; the endpoint's
  // own token verification is asserted separately.
  const { forfeitMatchOnDisconnect } = await import("../src/lib/tic-tac-toe/serverStore.ts");
  const first = await forfeitMatchOnDisconnect({ userId: BOB, matchId: MATCH_ID });
  assert.equal(first.forfeited, true);
  assert.equal(rowOf(fake).winnerId, ALICE);
  assert.equal(writers.rating.length, 1);

  const writesAfter = fake.state.writes.length;
  for (let i = 0; i < 5; i += 1) {
    const retry = await forfeitMatchOnDisconnect({ userId: BOB, matchId: MATCH_ID });
    assert.equal(retry.forfeited, false, "a decided match is not forfeited again");
    assert.equal(retry.cancelled, false);
  }
  assert.equal(fake.state.writes.length, writesAfter);
  assert.equal(writers.rating.length, 1, "and never re-settles");
});

test("authority: the disconnect endpoint is token-bound and cannot be forged", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  const src = readFileSync(R.disconnect, "utf8");

  assert.equal((await invoke(R.disconnect, { body: { matchId: MATCH_ID } })).status, 400, "no token");
  assert.equal((await invoke(R.disconnect, { body: { token: "tok" } })).status, 400, "no match id");
  assert.equal(
    (await invoke(R.disconnect, { body: { matchId: "not-a-uuid", token: "tok" } })).status,
    400,
    "malformed id never reaches the driver",
  );
  // The token is the only identity; a body cannot name one.
  assert.doesNotMatch(
    src,
    /body\??\.(userId|clerkId|playerId|player1Id|player2Id|winner)/,
    "the endpoint must never accept an identity from the body",
  );
  assert.match(src, /clerkUserId = verified\.sub \?\? ""/);
  assert.equal(fake.state.writes.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Multiplayer synchronisation
// ════════════════════════════════════════════════════════════════════════

test("multiplayer: both seats read the same authoritative board, with mirrored viewer state", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, [0, 4, 8]); // X:0,8 ; O:4 — now O (BOB) to move

  const asAlice = (await getMatch({ as: ALICE })).json.data;
  const asBob = (await getMatch({ as: BOB })).json.data;

  // The game state is IDENTICAL for both viewers.
  assert.deepEqual(asAlice.board, asBob.board);
  assert.equal(asAlice.version, asBob.version);
  assert.equal(asAlice.ply, asBob.ply);
  assert.equal(asAlice.status, asBob.status);
  assert.equal(asAlice.currentTurn, asBob.currentTurn);
  assert.equal(asAlice.winningLine, asBob.winningLine);
  assert.equal(asAlice.result, asBob.result);
  assert.equal(asAlice.player1Id, asBob.player1Id);
  assert.equal(asAlice.player2Id, asBob.player2Id);

  // Only the per-viewer projection is mirrored.
  assert.equal(asAlice.viewerSeat, "player1");
  assert.equal(asBob.viewerSeat, "player2");
  assert.equal(asAlice.viewerMark, "X");
  assert.equal(asBob.viewerMark, "O");
  assert.equal(asAlice.isViewerTurn, false);
  assert.equal(asBob.isViewerTurn, true);
  assert.equal(asAlice.viewerCanMove, false);
  assert.equal(asBob.viewerCanMove, true);
  // The move log is the server's, in ply order, for both viewers.
  assert.equal(asAlice.moves.length, 3);
  assert.deepEqual(asBob.moves.map((m) => m.cellIndex), [0, 4, 8]);
  assert.equal(asAlice.players.player1.name, "Alice");
  assert.equal(asBob.players.player2.name, "Bob");
});

test("multiplayer: a reconnect (or a missed realtime event) recovers the CURRENT state", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, [0, 4, 1, 5]); // X:0,1 ; O:4,5

  // No socket push is ever delivered in this test — a fresh GET is the whole
  // recovery path, and it must reflect the latest committed state.
  const snap = (await getMatch({ as: ALICE })).json.data;
  assert.equal(snap.ply, 4);
  assert.equal(snap.version, 5);
  assert.deepEqual(snap.board.slice(0, 2), ["X", "X"]);
  assert.equal(snap.board[4], "O");
  assert.equal(snap.board[5], "O");
  assert.equal(snap.board[2], null);
  assert.equal(snap.moves.length, 4, "the move log is server-derived");
  assert.equal(snap.isViewerTurn, true, "X to move again (ply 4)");
});

test("multiplayer: a decided match is terminal for both viewers and accepts no further move", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, A_WIN);

  for (const who of [ALICE, BOB]) {
    const snap = (await getMatch({ as: who })).json.data;
    assert.equal(snap.status, MATCH_STATUS.FINISHED, `status as ${who}`);
    assert.equal(snap.phase, "finished");
    assert.equal(snap.viewerCanMove, false, `no move offered to ${who}`);
    assert.equal(snap.result, RESULT.PLAYER1);
    assert.equal(snap.winnerId, ALICE);
    assert.deepEqual(snap.winningLine, [0, 1, 2]);
    // The settled row is the same for both seats; only the viewer's reading
    // of it differs, derived from their own seat against the server's result.
    const perspective = snap.viewerSeat === snap.result ? "win" : "loss";
    assert.equal(perspective, who === ALICE ? "win" : "loss", `outcome as ${who}`);
  }

  assert.equal(
    (await move({ boardIndex: 0, cellIndex: 6, expectedVersion: liveVersion(fake) }, { as: BOB })).status,
    409,
  );
});

test("multiplayer: a cancelled lobby is terminal and unrated for its creator", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null, currentTurnUserId: ALICE });

  const res = await cancel({ as: ALICE });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.match.status, MATCH_STATUS.CANCELLED);
  assert.equal(rowOf(fake).status, MATCH_STATUS.CANCELLED);
  assert.equal(writers.rating.length, 0, "a cancelled lobby never settled");
  assert.equal(writers.trophy.length, 0);

  // A non-creator cannot cancel, and a joined match cannot be cancelled.
  assert.equal((await cancel({ as: BOB })).status, 403);
  fake.reset();
  seedMatch(fake);
  assert.equal((await cancel({ as: ALICE })).status, 409, "an active match must be forfeited, not cancelled");
});

// ════════════════════════════════════════════════════════════════════════
// The wire: broadcasts carry hints only, never a board or a decision
// ════════════════════════════════════════════════════════════════════════

test("wire: a move broadcast is an invalidation hint, never an authoritative board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  await playRoute(fake, A_WIN);

  assert.ok(broadcasts.length > 0, "the routes did broadcast");
  for (const { room, event, payload } of broadcasts) {
    assert.equal(room, `tic-tac-toe:match:${MATCH_ID}`, "every push targets the match room");
    assert.equal(event, "lobby:updated");
    // The hint may name the turn / status / result, but it must NOT carry a
    // board the client could mistake for the source of truth.
    assert.equal("board" in payload, false, "the board is never pushed");
    assert.equal("winningLine" in payload, false, "nor the winning line");
    assert.equal("moves" in payload, false, "nor the move log");
  }
});
