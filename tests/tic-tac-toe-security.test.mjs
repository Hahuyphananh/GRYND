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
import {
  MATCH_STATUS,
  RESULT,
  TIC_TAC_TOE_AI_PLAYER_ID,
} from "../src/lib/tic-tac-toe/constants.ts";
import {
  createEmptyBoard,
  createInitialState,
  resolveBoardControl,
} from "../src/lib/tic-tac-toe/rules.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:tic-tac-toe";

const MATCH_ID = "1a2b3c4d-1111-4111-8111-111111111111";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
// The identity a signed-out practice player is handed (see
// src/lib/auth/guestSession.ts): a synthetic id with no `users` row.
const GUEST = "guest_abcd1234";

// Routes a GUEST may reach: the free practice entry point and the routes that
// drive the practice match it owns. Everything else stays account-only.
const PRACTICE_ROUTES = ["createAi", "match", "move", "forfeit", "cancel"];
const ACCOUNT_ROUTES = ["createOrJoin", "available"];

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

// ── Position fixtures ─────────────────────────────────────────────────────
//
// The suite drives complete sequences through the REAL routes. Mid-game
// positions are seeded in the persisted shape (all nine boards materialised);
// the move under test always goes through the route either way.

function fixtureBoard(cells) {
  assert.equal(cells.length, 9, "a fixture board must have nine cells");
  const { control, winningLine } = resolveBoardControl(cells);
  return {
    cells: [...cells],
    plies: cells.filter((cell) => cell !== null).length,
    control,
    winningLine,
  };
}

const X_BOARD = ["X", "X", "X", "O", "O", null, null, null, null];
const O_BOARD = ["O", "O", "O", "X", "X", null, null, null, null];
const X_TWO = ["X", "X", null, "O", "O", null, null, null, null];
const O_TWO = ["O", "O", null, "X", "X", null, null, null, null];
const DRAW_CELLS = (() => {
  const order = [0, 4, 8, 2, 6, 3, 5, 7, 1];
  const cells = new Array(9).fill(null);
  order.forEach((cell, ply) => {
    cells[cell] = ply % 2 === 0 ? "X" : "O";
  });
  return cells;
})();
const NEAR_DRAW = (() => {
  const cells = [...DRAW_CELLS];
  cells[1] = null; // X's last move completes a drawn board
  return cells;
})();

function craftState({ boards = {}, currentTurn = "player1", ply = 0, nextBoard = null, version = 100 } = {}) {
  return {
    version,
    phase: "playing",
    boards: Array.from({ length: 9 }, (_, slot) => boards[slot] ?? createEmptyBoard()),
    currentTurn,
    ply,
    winner: null,
    winningBoards: null,
    nextBoard,
    lastMove: null,
  };
}

/** X claims the top row of the lattice with one move at (2, 2). */
const xOneMoveFromWinning = () =>
  craftState({
    boards: { 0: fixtureBoard(X_BOARD), 1: fixtureBoard(X_BOARD), 2: fixtureBoard(X_TWO) },
    currentTurn: "player1",
    ply: 20,
    nextBoard: 2,
  });

/** O claims the top row of the lattice with one move at (2, 2). */
const oOneMoveFromWinning = () =>
  craftState({
    boards: { 0: fixtureBoard(O_BOARD), 1: fixtureBoard(O_BOARD), 2: fixtureBoard(O_TWO) },
    currentTurn: "player2",
    ply: 21,
    nextBoard: 2,
  });

/**
 * A REAL match from the opening position: X wins the left column (0, 3, 6) on
 * ply 21. Every move is on the board the previous cell index required.
 */
const MATCH_WIN = [
  { boardIndex: 0, cellIndex: 8 },
  { boardIndex: 8, cellIndex: 5 },
  { boardIndex: 5, cellIndex: 2 },
  { boardIndex: 2, cellIndex: 6 },
  { boardIndex: 6, cellIndex: 0 },
  { boardIndex: 0, cellIndex: 0 },
  { boardIndex: 0, cellIndex: 5 },
  { boardIndex: 5, cellIndex: 3 },
  { boardIndex: 3, cellIndex: 3 },
  { boardIndex: 3, cellIndex: 8 },
  { boardIndex: 8, cellIndex: 1 },
  { boardIndex: 1, cellIndex: 6 },
  { boardIndex: 6, cellIndex: 3 },
  { boardIndex: 3, cellIndex: 0 },
  { boardIndex: 0, cellIndex: 2 },
  { boardIndex: 2, cellIndex: 3 },
  { boardIndex: 3, cellIndex: 4 },
  { boardIndex: 4, cellIndex: 3 },
  { boardIndex: 3, cellIndex: 5 },
  { boardIndex: 5, cellIndex: 0 },
  { boardIndex: 6, cellIndex: 6 },
];

/** A short forced-destination chain: each cell names the next required board. */
const FORCED_CHAIN = [
  { boardIndex: 0, cellIndex: 0 },
  { boardIndex: 0, cellIndex: 4 },
  { boardIndex: 4, cellIndex: 8 },
];

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
        // Match rows are addressed by a uuid in the real schema (and the routes
        // validate it), so the fake mints one too: a test can then take an id
        // from a CREATED match and drive the real routes with it.
        id: table === ticTacToeMatches ? crypto.randomUUID() : `row-${state.nextId++}`,
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
        // "no-guest" is the same visitor as "signed-out" for the account-only
        // routes: no session, and the practice gate is not the one they hit.
        if (session.gate === "signed-out" || session.gate === "no-guest") {
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

  // The PRACTICE gate (create-ai + the routes that drive a practice match) is
  // mocked alongside it. It answers the SAME way for a signed-in caller — the
  // age gate still runs — but a signed-out one is handed a guest identity
  // instead of a 401, which is the whole point of "play vs AI without an
  // account". `session.gate = "no-guest"` models that same visitor with no
  // guest cookie, and `session.userId` is ignored for the guest case.
  t.mock.module("../src/lib/auth/guestSession.ts", {
    namedExports: {
      requirePracticePlayer: async () => {
        if (session.gate === "blocked") {
          return {
            response: Response.json(
              { success: false, error: "Age verification required" },
              { status: 403 },
            ),
            playerId: null,
            isGuest: false,
          };
        }
        if (session.gate === "signed-out") {
          return { response: null, playerId: GUEST, isGuest: true };
        }
        if (session.gate === "no-guest") {
          return {
            response: Response.json(
              { success: false, error: "Unauthorized" },
              { status: 401 },
            ),
            playerId: null,
            isGuest: false,
          };
        }
        const id =
          session.queue && session.queue.length ? session.queue.shift() : session.userId;
        return { response: null, playerId: id, isGuest: false };
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

/** Play { boardIndex, cellIndex } moves through the REAL /move route. */
async function playRoute(fake, moves) {
  const results = [];
  for (let ply = 0; ply < moves.length; ply += 1) {
    const who = ply % 2 === 0 ? ALICE : BOB;
    const res = await move(
      { boardIndex: moves[ply].boardIndex, cellIndex: moves[ply].cellIndex, expectedVersion: liveVersion(fake) },
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
    if (PRACTICE_ROUTES.includes(name)) {
      // Free practice is open to guests — but only through the practice gate,
      // which still age-gates a signed-in caller. A route here must never
      // become ungated.
      assert.match(
        src,
        /requirePracticePlayer\(/,
        `${name} must use the practice gate (age-gated for a session, guest for a visitor)`,
      );
      continue;
    }
    assert.match(src, /requireAgeVerifiedUser\(\)/, `${name} must be session-gated`);
    assert.doesNotMatch(
      src,
      /requirePracticePlayer/,
      `${name} is account-only and must not accept a guest`,
    );
  }

  // No route accepts a decision-shaped field off a body.
  //
  // `mark` is deliberately NOT on this list any more. A practice player chooses
  // which mark they hold — X opens, O hands the opening move to the bot — like
  // chess colours, so it is a PREFERENCE, not an outcome: the store resolves it
  // (`parseMarkChoice` / `resolveHumanMark`) and writes the row's seats from the
  // result, and it is only read by the practice create route. A stale or crafted
  // value can therefore pick a seat and nothing else.
  for (const path of Object.values(R)) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(
      src,
      /body\??\.(winner|winnerId|loserId|result|draw|tie|board|currentTurn|turn|ply|status|elo|rating|trophies|trophy|matchCompleted|completed)\b/,
      `${path} must not read a client-supplied decision`,
    );
    if (path !== R.createAi) {
      assert.doesNotMatch(src, /body\??\.mark\b/, `${path} must not read a seat preference`);
    }
  }
  // The one route that does read it hands it to the store's resolver — it never
  // turns the field into a seat itself.
  assert.match(readFileSync(R.createAi, "utf8"), /mark: body\?\.mark/);
  assert.match(
    readFileSync("src/lib/tic-tac-toe/serverStore.ts", "utf8"),
    /let humanMark = resolveHumanMark\(parseMarkChoice\(mark\), random\);/,
  );
});

// ════════════════════════════════════════════════════════════════════════
// 1. Authorization / participation
// ════════════════════════════════════════════════════════════════════════

test("unauthorized: a signed-out or age-blocked caller is refused before any work", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const practiceCalls = [
    () => getMatch({ as: ALICE }),
    () => move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE }),
    () => forfeit({ as: ALICE }),
    () => cancel({ as: ALICE }),
    () => invoke(R.createAi, { as: ALICE }),
  ];
  const accountCalls = [
    () => invoke(R.createOrJoin, { as: ALICE }),
    () => invoke(R.available, { method: "GET", as: ALICE }),
  ];

  // 1. Age-blocked (a signed-in minor): refused EVERYWHERE, practice included.
  session.gate = "blocked";
  for (const call of [...practiceCalls, ...accountCalls]) {
    assert.equal((await call()).status, 403, "an age-blocked caller is refused");
  }

  // 2. Signed out with no guest cookie at all: refused everywhere too.
  session.gate = "no-guest";
  for (const call of [...practiceCalls, ...accountCalls]) {
    assert.equal((await call()).status, 401, "a cookie-less visitor is refused");
  }

  // Both refusal paths above bail at the gate: no transaction was ever opened.
  assert.equal(fake.state.transactions, 0, "the gate runs before any transaction");
  assert.equal(fake.state.writes.length, 0, "nothing was written");

  // 3. Signed out WITH a guest cookie: the account-only routes still refuse...
  session.gate = "signed-out";
  for (const call of accountCalls) {
    assert.equal((await call()).status, 401, "online play still needs an account");
  }
  // ...and the practice routes accept the guest, which is a STRANGER to this
  // seeded user-vs-user match and is therefore refused by SEAT, not by the
  // gate. Matchmaking is not what a guest gets: only a match it owns.
  assert.equal((await getMatch({ as: ALICE })).status, 403, "guest read is seat-gated");
  assert.equal(
    (await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE })).status,
    403,
    "guest move is seat-gated",
  );
  assert.equal((await forfeit({ as: ALICE })).status, 403, "guest forfeit is seat-gated");
  assert.equal((await cancel({ as: ALICE })).status, 403, "guest cancel is seat-gated");

  // A guest reaching the store still changes nothing it does not own.
  assert.equal(fake.state.writes.length, 0, "nothing was written");
  assert.equal(writers.rating.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
});

test("guest: a signed-out visitor can start, read and play a PRACTICE match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  // No Clerk session at all — but the visitor holds a guest cookie, so the
  // practice gate hands the route the guest identity.
  session.gate = "signed-out";

  // An explicit mark: which seat the guest takes is now a choice (or a roll), and
  // this test is about the guest's access, not the roll. X keeps the guest in
  // seat 1 so the move below addresses the human's own turn.
  const created = await invoke(R.createAi, { body: { difficulty: "easy", mark: "X" } });
  assert.equal(created.status, 200, "a guest starts a practice match from the lobby");
  assert.equal(created.json?.data?.practice, true);

  const row = fake.rowsOf(ticTacToeMatches)[0];
  assert.ok(row, "the practice match was created");
  assert.equal(row.player1Id, GUEST, "the guest holds seat 1 — it never borrows a real account");
  assert.equal(row.player2Id, TIC_TAC_TOE_AI_PLAYER_ID, "the opponent is the bot");
  assert.equal(row.isAi, true, "the match is flagged as practice, so nothing settles");

  // The guest can read and play ITS OWN match, through the real routes.
  const read = await getMatch({ matchId: row.id });
  assert.equal(read.status, 200, "the guest reads its own practice match");

  const played = await move(
    { boardIndex: 0, cellIndex: 4, expectedVersion: row.gameState.version },
    { matchId: row.id },
  );
  assert.equal(played.status, 200, "the guest plays a move");
  assert.equal(row.gameState.boards[0].cells[4], "X", "the guest's mark landed");

  // Unrated by construction: no rating or trophy writer was ever called, even
  // if the practice match runs to a finish.
  assert.equal(writers.rating.length, 0, "practice never touches the rating ledger");
  assert.equal(writers.trophy.length, 0, "practice never touches the trophy ledger");
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
      stage: 3,
      nextBoard: 8,
      ply: 9,
      mark: "O",
      board: ["O", "O", "O", null, null, null, null, null, null],
      boards: ["O", "O", "O", null, null, null, null, null, null],
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
  // its own state, the destination from the cell, the turn from the ply.
  assert.equal(row.gameState.boards[0].cells[3], "X", "the mark is the mover's, not the body's");
  assert.equal(row.gameState.boards[0].cells.filter(Boolean).length, 1, "the client's board is gone");
  assert.deepEqual(row.gameState.boards[0].cells.slice(0, 3), [null, null, null]);
  assert.equal(row.gameState.nextBoard, 3, "derived from the cell, not accepted");
  assert.equal("stage" in row.gameState, false, "no expansion-era field survives");
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
  assert.equal(res.json.data.nextBoard, 3);
  assert.equal(res.json.data.match.status, MATCH_STATUS.PLAYING);
  assert.equal(res.json.data.match.viewerCanMove, false, "it is now the opponent's turn");
});

test("authority: turn, occupancy, a valid index and the FORCED destination are enforced through the route", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // Out of turn: O cannot open the match.
  const wrongTurn = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: BOB });
  assert.equal(wrongTurn.status, 409);
  assert.match(wrongTurn.json.error, /not your turn/i);
  assert.equal(rowOf(fake).gameState.ply, 0);

  // A valid move by X, which sends O to board 0.
  const opened = await move({ boardIndex: 0, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.data.move.mark, "X");
  assert.equal(opened.json.data.move.boardIndex, 0);
  assert.equal(opened.json.data.move.cellIndex, 0);
  assert.equal(opened.json.data.nextBoard, 0);

  // Any OTHER board is refused while the destination is active — the client
  // cannot sidestep the forced board by sending a different index.
  const skipped = await move({ boardIndex: 4, cellIndex: 4, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(skipped.status, 409);
  assert.match(skipped.json.error, /board 0/i);
  assert.equal(rowOf(fake).gameState.ply, 1, "the bypass wrote nothing");

  // Occupied cell, on the required board: X took cell 0.
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

  for (const badBoard of [undefined, null, "0", true, [], -1, 9, 1.5, NaN]) {
    fake.reset();
    seedMatch(fake);
    const res = await move({ boardIndex: badBoard, cellIndex: 0, expectedVersion: 1 }, { as: ALICE });
    assert.equal(res.status, 400, JSON.stringify(badBoard));
    assert.match(res.json.error, /board index/i);
    assert.equal(rowOf(fake).gameState.ply, 0, JSON.stringify(badBoard));
  }

  // A RESOLVED board is refused even when the choice is free.
  fake.reset();
  seedMatch(fake, {
    gameState: craftState({
      boards: { 5: fixtureBoard(X_BOARD) },
      currentTurn: "player1",
      ply: 2,
      nextBoard: null,
    }),
  });
  const decided = await move({ boardIndex: 5, cellIndex: 0, expectedVersion: 100 }, { as: ALICE });
  assert.equal(decided.status, 409);
  assert.match(decided.json.error, /decided/i);

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
  assert.equal(rowOf(fake).gameState.ply, 1);
});

test("authority: a move after the match is decided is refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, { gameState: xOneMoveFromWinning(), ply: 20 });
  const winning = await move({ boardIndex: 2, cellIndex: 2, expectedVersion: 100 }, { as: ALICE });
  assert.equal(winning.status, 200);
  assert.equal(rowOf(fake).status, MATCH_STATUS.FINISHED);

  const movesAfter = fake.rowsOf(ticTacToeMoves).length;
  for (const who of [ALICE, BOB]) {
    const res = await move({ boardIndex: 6, cellIndex: 6, expectedVersion: liveVersion(fake) }, { as: who });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /no longer active/i);
  }
  assert.equal(fake.rowsOf(ticTacToeMoves).length, movesAfter);
  assert.equal(writers.rating.length, 1, "and never re-settled");
});

// ════════════════════════════════════════════════════════════════════════
// 3. Game logic end-to-end (through the real route)
// ════════════════════════════════════════════════════════════════════════

test("logic: a REAL 21-ply match wins X the lattice and settles exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const results = await playRoute(fake, MATCH_WIN);
  assert.equal(results.length, MATCH_WIN.length, "every move was accepted");
  assert.equal(results.filter((r) => r.status !== 200).length, 0);

  const last = results.at(-1).json.data;
  assert.equal(last.matchCompleted, true);
  assert.deepEqual(last.winningBoards, [0, 3, 6]);
  assert.equal(last.winnerId, ALICE);
  assert.equal(last.result, RESULT.PLAYER1);
  // A finished match has no destination to report.
  assert.equal(last.nextBoard, null);

  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER1);
  assert.equal(row.winnerId, ALICE);
  assert.ok(row.endedAt);
  assert.deepEqual(row.gameState.winningBoards, [0, 3, 6]);
  assert.equal(row.gameState.nextBoard, null);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
  assert.equal(writers.rating[0].gameKey, "tic-tac-toe");
  assert.equal(writers.rating[0].matchId, MATCH_ID);
  assert.equal(writers.rating[0].winnerClerkId, ALICE);
  assert.equal(writers.rating[0].loserClerkId, BOB);
  // Every one of the 21 moves is in the append-only log.
  assert.equal(fake.rowsOf(ticTacToeMoves).length, MATCH_WIN.length);
});

test("logic: O completes the lattice line and nothing is lost to the turn order", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, { gameState: oOneMoveFromWinning(), ply: 21 });

  const res = await move({ boardIndex: 2, cellIndex: 2, expectedVersion: 100 }, { as: BOB });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.matchCompleted, true);
  assert.deepEqual(res.json.data.winningBoards, [0, 1, 2]);

  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER2);
  assert.equal(row.winnerId, BOB);
  assert.equal(writers.rating[0].winnerClerkId, BOB);
  assert.equal(writers.rating[0].loserClerkId, ALICE);
});

test("logic: claiming a mini-board resolves it but does NOT settle the match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, {
    ply: 6,
    gameState: craftState({
      boards: {
        0: fixtureBoard(["O", null, null, null, null, null, null, null, null]),
        1: fixtureBoard(X_TWO),
      },
      currentTurn: "player1",
      ply: 6,
      nextBoard: 1,
    }),
  });

  const res = await move({ boardIndex: 1, cellIndex: 2, expectedVersion: 100 }, { as: ALICE });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.matchCompleted, false);
  assert.deepEqual(res.json.data.winningLine, [0, 1, 2]);
  assert.equal(res.json.data.winningBoards, null);
  // The next seat is sent to the mini-board named by the cell.
  assert.equal(res.json.data.nextBoard, 2);

  const row = rowOf(fake);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.deepEqual(row.gameState.boards[1].winningLine, [0, 1, 2]);
  assert.equal(row.result, null);
  assert.equal(row.endedAt, null);
  // One board is not a result: nothing settles.
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
  assert.equal(writers.queue.filter((q) => q.status === "completed").length, 0);
});

test("logic: a drawn mini-board locks and play continues on the required board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, {
    ply: 8,
    gameState: craftState({
      boards: { 7: fixtureBoard(NEAR_DRAW) },
      currentTurn: "player1",
      ply: 8,
      nextBoard: 7,
    }),
  });

  const drawn = await move({ boardIndex: 7, cellIndex: 1, expectedVersion: 100 }, { as: ALICE });
  assert.equal(drawn.status, 200);
  assert.equal(drawn.json.data.matchCompleted, false);
  const row = rowOf(fake);
  assert.equal(row.gameState.boards[7].control, "draw");
  assert.equal(row.gameState.boards[7].winningLine, null);
  assert.equal(row.gameState.nextBoard, 1, "cell 1 sends O to board 1");

  // Play continues: the drawn board is locked, board 1 accepts.
  const locked = await move({ boardIndex: 7, cellIndex: 0, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(locked.status, 409);
  const opened = await move({ boardIndex: 1, cellIndex: 4, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(opened.status, 200);
  assert.equal(rowOf(fake).gameState.boards[1].cells[4], "O");
  assert.equal(rowOf(fake).gameState.boards[7].control, "draw");
  assert.equal(writers.rating.length, 0, "a board draw is not a result");
});

test("logic: a resolved destination frees the next move, and the claimed board still refuses", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, {
    ply: 4,
    gameState: craftState({
      boards: {
        0: fixtureBoard(["X", "O", null, null, null, null, null, null, null]),
        5: fixtureBoard(X_BOARD),
      },
      currentTurn: "player1",
      ply: 4,
      nextBoard: 0,
    }),
  });

  // X plays cell 5, whose destination (board 5) is already claimed → free choice.
  const opened = await move({ boardIndex: 0, cellIndex: 5, expectedVersion: 100 }, { as: ALICE });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.data.nextBoard, null);
  assert.ok(opened.json.data.match.playableBoards.includes(3));

  const claimed = await move({ boardIndex: 5, cellIndex: 0, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(claimed.status, 409);
  assert.match(claimed.json.error, /decided/i);

  const free = await move({ boardIndex: 3, cellIndex: 0, expectedVersion: liveVersion(fake) }, { as: BOB });
  assert.equal(free.status, 200);
  assert.equal(rowOf(fake).gameState.boards[3].cells[0], "O");
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
    move({ boardIndex: 4, cellIndex: 4, expectedVersion: 1 }),
  ]);

  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialised the two writes");
  const accepted = [a, b].filter((r) => r.status === 200);
  const rejected = [a, b].filter((r) => r.status !== 200);
  assert.equal(accepted.length, 1, "exactly one move wins");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].status, 409, "the loser is a clean conflict");
  assert.equal(fake.rowsOf(ticTacToeMoves).length, 1, "one mark was persisted");
  assert.equal(rowOf(fake).gameState.boards.flatMap((b2) => b2.cells).filter(Boolean).length, 1);
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
  assert.equal(row.gameState.boards[0].cells[2], "X");
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
  seedMatch(fake, { gameState: xOneMoveFromWinning(), ply: 20 });
  assert.equal((await move({ boardIndex: 2, cellIndex: 2, expectedVersion: 100 }, { as: ALICE })).status, 200);

  assert.equal(writers.rating.length, 1, "settled once");
  assert.equal(writers.trophy.length, 1);
  const movesAfter = fake.rowsOf(ticTacToeMoves).length;
  const writesAfter = fake.state.writes.length;

  // Hammer the board from both seats, and the forfeit path too.
  for (let i = 0; i < 20; i += 1) {
    const who = i % 2 === 0 ? BOB : ALICE;
    const res = await move({ boardIndex: 6, cellIndex: 6, expectedVersion: liveVersion(fake) }, { as: who });
    assert.equal(res.status, 409, `retry ${i}`);
  }
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
  // X(0,0) → O must answer board 0 at cell 4 → X must answer board 4 at cell 8.
  await playRoute(fake, [
    { boardIndex: 0, cellIndex: 0 },
    { boardIndex: 0, cellIndex: 4 },
    { boardIndex: 4, cellIndex: 8 },
  ]);

  const asAlice = (await getMatch({ as: ALICE })).json.data;
  const asBob = (await getMatch({ as: BOB })).json.data;

  // The game state is IDENTICAL for both viewers.
  assert.deepEqual(asAlice.boards, asBob.boards);
  assert.equal(asAlice.version, asBob.version);
  assert.equal(asAlice.ply, asBob.ply);
  assert.equal(asAlice.status, asBob.status);
  assert.equal(asAlice.currentTurn, asBob.currentTurn);
  assert.equal(asAlice.nextBoard, asBob.nextBoard);
  assert.deepEqual(asAlice.playableBoards, asBob.playableBoards);
  assert.equal(asAlice.winningBoards, asBob.winningBoards);
  assert.equal(asAlice.result, asBob.result);
  assert.equal(asAlice.player1Id, asBob.player1Id);
  assert.equal(asAlice.player2Id, asBob.player2Id);
  assert.equal(asAlice.legacyState, false);

  // Only the per-viewer projection is mirrored.
  assert.equal(asAlice.viewerSeat, "player1");
  assert.equal(asBob.viewerSeat, "player2");
  assert.equal(asAlice.viewerMark, "X");
  assert.equal(asBob.viewerMark, "O");
  assert.equal(asAlice.isViewerTurn, false);
  assert.equal(asBob.isViewerTurn, true);
  assert.equal(asAlice.viewerCanMove, false);
  assert.equal(asBob.viewerCanMove, true);
  // The destination the next seat must play is explicit.
  assert.equal(asBob.nextBoard, 8);

  // The move log is the server's, in ply order, for both viewers.
  assert.equal(asAlice.moves.length, 3);
  assert.deepEqual(asBob.moves.map((m) => m.cellIndex), [0, 4, 8]);
  assert.deepEqual(asBob.moves.map((m) => m.boardIndex), [0, 0, 4]);
  assert.equal(asAlice.players.player1.name, "Alice");
  assert.equal(asBob.players.player2.name, "Bob");
});

test("multiplayer: a reconnect (or a missed realtime event) recovers the CURRENT state", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  // X(0,0) → O(0,4) → X(4,1) → O(1,5): a real forced-destination chain.
  await playRoute(fake, [
    { boardIndex: 0, cellIndex: 0 },
    { boardIndex: 0, cellIndex: 4 },
    { boardIndex: 4, cellIndex: 1 },
    { boardIndex: 1, cellIndex: 5 },
  ]);

  // No socket push is ever delivered in this test — a fresh GET is the whole
  // recovery path, and it must reflect the latest committed state.
  const snap = (await getMatch({ as: ALICE })).json.data;
  assert.equal(snap.ply, 4);
  assert.equal(snap.version, 5);
  assert.equal(snap.boards[0].cells[0], "X");
  assert.equal(snap.boards[0].cells[4], "O");
  assert.equal(snap.boards[4].cells[1], "X");
  assert.equal(snap.boards[1].cells[5], "O");
  assert.equal(snap.boards[0].cells[2], null);
  assert.equal(snap.nextBoard, 5, "cell 5 sends X to board 5");
  assert.deepEqual(snap.playableBoards, [5]);
  assert.equal(snap.moves.length, 4, "the move log is server-derived");
  assert.equal(snap.isViewerTurn, true, "X to move again (ply 4)");
});

test("multiplayer: a decided match is terminal for both viewers and accepts no further move", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, { gameState: xOneMoveFromWinning(), ply: 20 });
  await move({ boardIndex: 2, cellIndex: 2, expectedVersion: 100 }, { as: ALICE });

  for (const who of [ALICE, BOB]) {
    const snap = (await getMatch({ as: who })).json.data;
    assert.equal(snap.status, MATCH_STATUS.FINISHED, `status as ${who}`);
    assert.equal(snap.phase, "finished");
    assert.equal(snap.viewerCanMove, false, `no move offered to ${who}`);
    assert.equal(snap.result, RESULT.PLAYER1);
    assert.equal(snap.winnerId, ALICE);
    assert.deepEqual(snap.winningBoards, [0, 1, 2]);
    assert.equal(snap.nextBoard, null);
    // The settled row is the same for both seats; only the viewer's reading
    // of it differs, derived from their own seat against the server's result.
    const perspective = snap.viewerSeat === snap.result ? "win" : "loss";
    assert.equal(perspective, who === ALICE ? "win" : "loss", `outcome as ${who}`);
  }

  assert.equal(
    (await move({ boardIndex: 6, cellIndex: 6, expectedVersion: liveVersion(fake) }, { as: BOB })).status,
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
  await playRoute(fake, FORCED_CHAIN);

  assert.ok(broadcasts.length > 0, "the routes did broadcast");
  for (const { room, event, payload } of broadcasts) {
    assert.equal(room, `tic-tac-toe:match:${MATCH_ID}`, "every push targets the match room");
    assert.equal(event, "lobby:updated");
    // The hint may name the turn / status / destination / result, but it must
    // NOT carry a board the client could mistake for the source of truth.
    assert.equal("board" in payload, false, "the board is never pushed");
    assert.equal("boards" in payload, false, "nor the lattice");
    assert.equal("winningLine" in payload, false, "nor the winning line");
    assert.equal("moves" in payload, false, "nor the move log");
    assert.equal("stage" in payload, false, "the stage no longer exists");
    assert.ok("nextBoard" in payload, "the destination hint is explicit");
  }
});
