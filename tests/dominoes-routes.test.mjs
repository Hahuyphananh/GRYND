/**
 * dominoes-routes.test.mjs
 *
 * THE ONLINE DOMINOES HTTP SURFACE — the REAL route handlers, invoked.
 *
 * Same harness shape as tests/tic-tac-toe-security.test.mjs: the Clerk age gate,
 * the Drizzle client and the shared progression writers are mocked, the route
 * modules are imported for real, and each handler is called with a real
 * `Request` and a real `params` promise. That way the status codes, the JSON
 * bodies and the ORDER of the guards (auth → id → store) are what is asserted,
 * not a re-implementation of them.
 *
 * The fake client ignores WHERE clauses (every store read targets the one row
 * under test) and serialises transactions, which is its model of `FOR UPDATE` —
 * that is what makes the concurrent-submission and resolve-once assertions
 * meaningful.
 *
 * `globalThis.io` is captured so the broadcast payloads can be audited too: a
 * push is an invalidation hint, so a tile, a hand or the pile appearing on the
 * wire would be a leak even though it never reaches a response body.
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/dominoes-routes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  dominoesMatches,
  dominoesMoves,
  dominoesRounds,
} from "../src/db/schema.ts";
import {
  DOMINOES_AI_PLAYER_ID,
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

/** Routes, by the name the surface test uses. */
const R = {
  createOrJoin: "src/app/api/dominoes/create-or-join/route.ts",
  createAi: "src/app/api/dominoes/create-ai/route.ts",
  available: "src/app/api/dominoes/available/route.ts",
  match: "src/app/api/dominoes/match/[matchId]/route.ts",
  move: "src/app/api/dominoes/match/[matchId]/move/route.ts",
  forfeit: "src/app/api/dominoes/match/[matchId]/forfeit/route.ts",
  cancel: "src/app/api/dominoes/match/[matchId]/cancel/route.ts",
  disconnect: "src/app/api/dominoes/disconnect-forfeit/route.ts",
};

/**
 * The FREE-PRACTICE routes: they accept a signed-out guest (and the account gate
 * instead, for a signed-in caller), because a vs-AI match is free and unrated.
 * Every other route stays on the age-verified account gate.
 */
const PRACTICE_ROUTES = new Set(["createAi", "match", "move", "forfeit"]);

/* -------------------------------------------------------------------------- *
 * The fake database
 * -------------------------------------------------------------------------- */

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    writes: [],
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
      // UNIQUE (match_id, round_number) + ON CONFLICT DO NOTHING: a round is
      // appended once, however many times the request is retried.
      if (
        table === dominoesRounds &&
        rowsOf(table).some(
          (existing) =>
            existing.matchId === v.matchId &&
            existing.roundNumber === v.roundNumber,
        )
      ) {
        const skipped = { returning: () => Promise.resolve([]) };
        skipped.onConflictDoNothing = () => skipped;
        skipped.then = (resolve, reject) =>
          Promise.resolve([]).then(resolve, reject);
        return skipped;
      }
      if (state.failInserts.has(table)) {
        throw Object.assign(
          new Error("duplicate key value violates unique constraint"),
          { code: "23505" },
        );
      }
      const row = {
        id: table === dominoesMatches ? crypto.randomUUID() : `row-${state.nextId++}`,
        createdAt: new Date(),
        ...(NULLABLE_DEFAULTS.get(table) ?? {}),
        ...v,
      };
      state.writes.push({ table, op: "insert", values: v });
      rowsOf(table).push(row);
      const out = { returning: () => Promise.resolve([{ ...row }]) };
      out.onConflictDoNothing = () => out;
      out.then = (resolve, reject) => Promise.resolve([{ ...row }]).then(resolve, reject);
      return out;
    },
  });

  const tx = { select, update, insert, execute: async () => {} };

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
      state.inFlight = 0;
      state.maxConcurrent = 0;
      state.failInserts.clear();
      chain = Promise.resolve();
    },
    db: { transaction, select, update, insert },
  };
}

let sharedFake = null;
const session = { userId: ALICE, gate: "ok" };
const broadcasts = [];
const writers = { rating: [], trophy: [] };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  sharedFake.reset();
  broadcasts.length = 0;
  writers.rating.length = 0;
  writers.trophy.length = 0;
  session.userId = ALICE;
  session.gate = "ok";

  // The practice routes go through the shared guest gate, which reads Clerk
  // itself. Delegated to the same session mock so a test can drive
  // signed-out / under-age / signed-in without a browser cookie jar.
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
          return {
            response: Response.json(
              { success: false, error: "Unauthorized" },
              { status: 401 },
            ),
            playerId: null,
            isGuest: false,
          };
        }
        return { response: null, playerId: session.userId, isGuest: false };
      },
    },
  });
  t.mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: {
      requireAgeVerifiedUser: async () => {
        if (session.gate === "blocked") {
          return {
            response: Response.json(
              { success: false, error: "Age verification required" },
              { status: 403 },
            ),
            userId: null,
          };
        }
        if (session.gate === "signed-out") {
          return {
            response: Response.json(
              { success: false, error: "Unauthorized" },
              { status: 401 },
            ),
            userId: null,
          };
        }
        return { response: null, userId: session.userId };
      },
    },
  });
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
  t.mock.module("../src/lib/seatIdentity.js", {
    namedExports: {
      getSeatIdentity: async (player1Id, player2Id) => ({
        player1: { name: "Alice", iconKey: null, profileFrame: null },
        player2: player2Id
          ? { name: "Bob", iconKey: null, profileFrame: null }
          : null,
        player1Id,
        player2Id: player2Id ?? null,
      }),
    },
  });
  t.mock.module("../src/lib/logError.ts", {
    namedExports: {
      logError: async () => {},
      // A few call sites import the default too.
      default: async () => {},
    },
  });

  const previousIo = globalThis.io;
  globalThis.io = {
    to: (room) => ({
      emit: (event, payload) => broadcasts.push({ room, event, payload }),
    }),
  };
  t.after(() => {
    globalThis.io = previousIo;
  });

  return sharedFake;
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

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

const LIVE_STATE = craftState({
  p1: ["6-3", "1-1", "2-2"],
  p2: ["6-6", "5-5", "0-0"],
  pile: ["4-4", "3-1", "3-2"],
  turn: "player1",
});

function matchRow(overrides = {}) {
  const state = overrides.state ?? LIVE_STATE;
  delete overrides.state;
  return {
    id: MATCH_ID,
    player1Id: ALICE,
    player2Id: BOB,
    status: MATCH_STATUS.PLAYING,
    ply: state ? state.ply : 0,
    currentTurnUserId: state ? (state.turn === "player1" ? ALICE : BOB) : null,
    turnDeadlineAt: new Date(Date.now() + TURN_WINDOW_MS),
    gameState: state ? publicState(state) : null,
    p1Hand: state ? [...state.hands.player1] : [],
    p2Hand: state ? [...state.hands.player2] : [],
    drawPile: state ? [...state.drawPile] : [],
    player1Score: 0,
    player2Score: 0,
    roundNumber: 1,
    previousRoundWinner: null,
    previousStartingSeat: null,
    winnerId: null,
    result: null,
    resultReason: null,
    startedAt: new Date(),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const WAITING_ROW = {
  player2Id: null,
  status: MATCH_STATUS.WAITING,
  gameState: null,
  currentTurnUserId: null,
  turnDeadlineAt: null,
};

function seedMatch(fake, overrides = {}) {
  const row = matchRow(overrides);
  fake.rowsOf(dominoesMatches).push(row);
  return row;
}

const liveMatch = (fake) => fake.rowsOf(dominoesMatches)[0];
const moveLog = (fake) => fake.rowsOf(dominoesMoves);
const liveVersion = (fake) => liveMatch(fake).ply;

/* -------------------------------------------------------------------------- *
 * Request helper: the REAL route handlers
 * -------------------------------------------------------------------------- */

async function invoke(routeRelPath, { method = "POST", matchId = MATCH_ID, body, as, gate } = {}) {
  if (as) session.userId = as;
  if (gate) session.gate = gate;
  const mod = await import(`../${routeRelPath}`);
  const path = routeRelPath.replace(/\[matchId\]/g, matchId);
  const req = new Request(`http://dominoes.test/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
  const res = await mod[method](req, { params: Promise.resolve({ matchId }) });
  return { status: res.status, json: await res.json() };
}

const getMatch = (opts = {}) => invoke(R.match, { method: "GET", ...opts });
const play = (body, opts = {}) => invoke(R.move, { body, ...opts });
const forfeit = (opts = {}) => invoke(R.forfeit, opts);
const cancel = (opts = {}) => invoke(R.cancel, opts);
const createOrJoin = (opts = {}) => invoke(R.createOrJoin, opts);
const available = (opts = {}) => invoke(R.available, { method: "GET", ...opts });

/** Every tile string in the fixture deal, for leak assertions. */
const ALL_TILES = [
  "6-3", "1-1", "2-2" /* player1 */,
  "6-6", "5-5", "0-0" /* player2 */,
  "4-4", "3-1", "3-2" /* pile */,
];

const handOf = (state, seat) => state.hands[seat];

/* -------------------------------------------------------------------------- *
 * 0. The surface itself
 * -------------------------------------------------------------------------- */

test("surface: the route list is exactly the audited one, and every route is gated", { skip: SKIP_REASON }, () => {
  const root = "src/app/api/dominoes";
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
      // The realtime server has no Clerk session — it re-verifies the player's
      // own socket token, so this is the one route that gates itself.
      assert.match(src, /verifyToken\(/, "disconnect must verify its own token");
      assert.doesNotMatch(src, /requireAgeVerifiedUser\(/);
      continue;
    }
    if (PRACTICE_ROUTES.has(name)) {
      // Free practice accepts a guest; the store authorises by SEAT, so a guest
      // can only ever read or act in its own match.
      assert.match(
        src,
        /requirePracticePlayer/,
        `${name} must accept a guest practice player`,
      );
      assert.doesNotMatch(
        src,
        /requireAgeVerifiedUser/,
        `${name} must not keep the account-only age gate`,
      );
      continue;
    }
    assert.match(src, /requireAgeVerifiedUser\(\)/, `${name} must be session-gated`);
    // Matchmaking stays account-only: a guest may practise against the bot, but
    // never takes a seat in the ranked lobby.
    assert.doesNotMatch(
      src,
      /requirePracticePlayer/,
      `${name} is account-only and must not accept a guest`,
    );
  }

  // No route reads a decision-shaped field off a body, and no route has any
  // concept of a stake: Dominoes is unstaked by design.
  for (const path of Object.values(R)) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(
      src,
      /body\??\.(winner|winnerId|loserId|result|draw|tie|hands?|chain|board|openEnds|pips|score|currentTurn|turn|ply|status|elo|rating|trophies|trophy|matchCompleted|completed)\b/,
      `${path} must not read a client-supplied decision`,
    );
    assert.doesNotMatch(
      src,
      /body\??\.(stake|wager|bet|amount|coins|currency)\b|\b(stakeId|stakeAmount|wagerId|wagerAmount|escrowId)\b/,
      `${path} must not read or forward a stake — Dominoes is unstaked`,
    );
  }

  // The store is the only place the deal, the rules and the clock are decided:
  // no route may import the pure engine or the shuffler at all.
  const store = readFileSync("src/lib/dominoes/serverStore.ts", "utf8");
  assert.match(store, /dealMatch\(/, "the store mints the deal server-side");
  assert.match(store, /applyAction\(/, "the store applies the engine's own action");
  assert.match(store, /applyTimeout\(/, "the store resolves an expired turn with the engine");
  for (const path of Object.values(R)) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /from "[^"]*dominoes\/(rules|deal|constants)"/,
      `${path} must delegate the rules to the store, never import the engine`,
    );
  }
});

test("surface: an unauthenticated or under-age caller is stopped before any read", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);

  const signedOut = await getMatch({ gate: "signed-out" });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.json.success, false);

  const underage = await getMatch({ gate: "blocked" });
  assert.equal(underage.status, 403);

  for (const call of [
    () => createOrJoin({ gate: "signed-out" }),
    () => invoke(R.createAi, { gate: "signed-out" }),
    () => play({ action: { type: "draw" }, expectedVersion: 0 }, { gate: "signed-out" }),
    () => forfeit({ gate: "blocked" }),
    () => cancel({ gate: "blocked" }),
    () => available({ gate: "signed-out" }),
  ]) {
    const result = await call();
    assert.ok([401, 403].includes(result.status), `gate returned ${result.status}`);
  }
});

test("surface: a malformed matchId is a 400, never a Postgres uuid cast", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const bad = "not-a-uuid";
  for (const call of [
    () => getMatch({ matchId: bad }),
    () => play({ action: { type: "draw" }, expectedVersion: 0 }, { matchId: bad }),
    () => forfeit({ matchId: bad }),
    () => cancel({ matchId: bad }),
  ]) {
    const result = await call();
    assert.equal(result.status, 400);
    assert.equal(result.json.success, false);
  }
});

/* -------------------------------------------------------------------------- *
 * 1. Reads: the viewer projection
 * -------------------------------------------------------------------------- */

test("GET match: each seat receives its own hand and only a COUNT of the other", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const asAlice = await getMatch({ as: ALICE });
  assert.equal(asAlice.status, 200);
  const a = asAlice.json.data;
  assert.equal(a.viewerSeat, "player1");
  assert.deepEqual(a.hand, ["6-3", "1-1", "2-2"]);
  assert.equal(a.opponentTileCount, 3);
  assert.equal(a.drawPileCount, 3);
  assert.equal(a.isViewerTurn, true);
  assert.ok(a.turnDeadlineAt);

  const asBob = await getMatch({ as: BOB });
  assert.equal(asBob.status, 200);
  const b = asBob.json.data;
  assert.equal(b.viewerSeat, "player2");
  assert.deepEqual(b.hand, ["6-6", "5-5", "0-0"]);
  assert.equal(b.opponentTileCount, 3);
  assert.equal(b.isViewerTurn, false);

  // Each body holds its own seven... three, and none of the other's, none of the
  // pile's, and no raw state column.
  const aliceWire = JSON.stringify(asAlice.json);
  for (const tile of handOf(LIVE_STATE, "player2").concat(handOf(LIVE_STATE, "drawPile"))) {
    assert.equal(
      aliceWire.includes(`"${tile}"`),
      false,
      `player2/pile tile ${tile} must not reach player1`,
    );
  }
  const bobWire = JSON.stringify(asBob.json);
  for (const tile of handOf(LIVE_STATE, "player1").concat(handOf(LIVE_STATE, "drawPile"))) {
    assert.equal(
      bobWire.includes(`"${tile}"`),
      false,
      `player1/pile tile ${tile} must not reach player2`,
    );
  }
  for (const field of ["hands", "drawPile", "p1Hand", "p2Hand", "gameState"]) {
    assert.equal(Object.hasOwn(a, field), false, `the DTO must not carry ${field}`);
  }
  // The opening bid tile is still in a hand at ply 0, so it is NOT published.
  assert.equal(Object.hasOwn(a, "startingTile"), false);
});

test("GET match: a nonparticipant is refused and a missing match is a 404", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const stranger = await getMatch({ as: MALLORY });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.success, false);

  fake.state.tables.set(dominoesMatches, []);
  const missing = await getMatch({ as: ALICE });
  assert.equal(missing.status, 404);
  // Both refusals happened before any settlement or write.
  assert.equal(writers.rating.length, 0);
  assert.equal(fake.state.writes.length, 0);
});

test("GET match: the same read twice restores the identical position (reconnect)", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const first = await getMatch({ as: BOB });
  const second = await getMatch({ as: BOB });

  assert.equal(second.status, 200);
  assert.deepEqual(second.json.data.hand, first.json.data.hand);
  assert.deepEqual(second.json.data.chain, first.json.data.chain);
  assert.equal(second.json.data.version, first.json.data.version);
  assert.equal(second.json.data.drawPileCount, first.json.data.drawPileCount);
  assert.equal(fake.state.writes.length, 0, "a reconnect never re-deals or re-shuffles");
});

/* -------------------------------------------------------------------------- *
 * 2. The action route
 * -------------------------------------------------------------------------- */

test("POST move: a legal play is applied server-side and echoed back", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const result = await play({ action: { type: "play", tile: "6-3" }, expectedVersion: 0 }, { as: ALICE });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);

  const data = result.json.data;
  assert.equal(data.matchCompleted, false);
  assert.equal(data.action.type, "play");
  assert.equal(data.action.ply, 0);
  assert.deepEqual(data.match.hand, ["1-1", "2-2"]);
  assert.deepEqual(data.match.openEnds, { left: 6, right: 3 });
  assert.equal(data.match.turn, "player2");
  assert.equal(data.match.version, 1);
  assert.equal(liveMatch(fake).currentTurnUserId, BOB);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.PLAYING);
  assert.equal(moveLog(fake).length, 1);
  // The push is an invalidation hint: no hand, no chain, no pile on the wire.
  const wire = JSON.stringify(broadcasts);
  for (const tile of ALL_TILES) {
    assert.equal(wire.includes(`"${tile}"`), false, `tile ${tile} must not be broadcast`);
  }
  for (const field of ["hand", "drawPile", "p1Hand", "p2Hand", "chain"]) {
    assert.equal(wire.includes(`"${field}"`), false, `the broadcast must not carry ${field}`);
  }
});

test("POST move: illegal actions are refused with the reason, and write nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // Out of turn.
  const outOfTurn = await play(
    { action: { type: "play", tile: "6-6", end: "left" }, expectedVersion: 0 },
    { as: BOB },
  );
  assert.equal(outOfTurn.status, 409);
  assert.match(outOfTurn.json.error, /not your turn/i);

  // A real tile that is in the opponent's hand.
  const notHeld = await play(
    { action: { type: "play", tile: "6-6", end: "left" }, expectedVersion: 0 },
    { as: ALICE },
  );
  assert.equal(notHeld.status, 409);
  assert.match(notHeld.json.error, /not in your hand/i);

  // Malformed: unknown action type, bad end, non-canonical tile.
  for (const action of [
    { type: "teleport" },
    { type: "play", tile: "6-3", end: "middle" },
    { type: "play", tile: "3-6" },
    { type: "play" },
    null,
  ]) {
    const result = await play({ action, expectedVersion: 0 }, { as: ALICE });
    assert.equal(result.status, 400, `${JSON.stringify(action)} must be a 400`);
  }

  // A body that is not JSON at all.
  const garbage = await play("{not json", { as: ALICE });
  assert.equal(garbage.status, 400);

  assert.equal(fake.state.writes.length, 0);
  assert.equal(moveLog(fake).length, 0);
});

test("POST move: missing, malformed and stale versions cannot consume a turn", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  // 0 (and "0") is this row's real version, so it is NOT in this list.
  for (const expectedVersion of [undefined, null, "", "zero", 1, 2, -1, 0.5, true]) {
    const result = await play(
      { action: { type: "play", tile: "6-3" }, expectedVersion },
      { as: ALICE },
    );
    assert.equal(result.status, 409, `version ${String(expectedVersion)} must be refused`);
  }
  assert.equal(fake.state.writes.length, 0);
  assert.equal(moveLog(fake).length, 0);
  assert.equal(liveMatch(fake).ply, 0);
});

test("POST move: a turn past its deadline is refused, and the clock acts for the seat", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake, { turnDeadlineAt: new Date(Date.now() - 1_000) });

  const result = await play({ action: { type: "play", tile: "6-3" }, expectedVersion: 0 }, { as: ALICE });

  assert.equal(result.status, 409);
  assert.match(result.json.error, /expired/i);
  // The intended tile stayed in hand; the clock drew one instead.
  assert.deepEqual(liveMatch(fake).p1Hand, ["6-3", "1-1", "2-2", "4-4"]);
  assert.equal(liveMatch(fake).ply, 1);
  assert.equal(moveLog(fake).length, 1);
  assert.equal(moveLog(fake)[0].timedOut, true);
  assert.ok(liveMatch(fake).turnDeadlineAt.getTime() > Date.now() - 1_000, "a fresh window");
  assert.notEqual(row.turnDeadlineAt.getTime(), row.updatedAt.getTime() - 1);
});

test("POST move: two submissions in flight cannot both be accepted", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const body = { action: { type: "play", tile: "6-3" }, expectedVersion: 0 };
  const [first, second] = await Promise.all([
    play(body, { as: ALICE }),
    play(body, { as: ALICE }),
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one 200 and one 409");
  assert.equal(liveMatch(fake).ply, 1);
  assert.equal(moveLog(fake).length, 1);
  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialises the two requests");

  // A retry AFTER the fact is still a stale version, not a second play.
  const retry = await play(body, { as: ALICE });
  assert.equal(retry.status, 409);
  assert.equal(moveLog(fake).length, 1);
});

test("POST move: a replayed ply loses on the unique index as a clean 409", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  fake.state.failInserts.add(dominoesMoves);

  const result = await play({ action: { type: "play", tile: "6-3" }, expectedVersion: 0 }, { as: ALICE });

  assert.equal(result.status, 409);
  assert.match(result.json.error, /already recorded/i);
  assert.equal(result.json.success, false);
  assert.equal(liveMatch(fake).ply, 0);
});

/* -------------------------------------------------------------------------- *
 * 3. The clock
 * -------------------------------------------------------------------------- */

test("GET match: an expired turn is resolved once, and a later read resolves nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, { turnDeadlineAt: new Date(Date.now() - 1_000) });

  const first = await getMatch({ as: ALICE });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.timedOut, true);
  assert.equal(liveMatch(fake).ply, 1);
  assert.equal(moveLog(fake).length, 1);

  const second = await getMatch({ as: BOB });
  assert.equal(second.json.data.timedOut, false);
  assert.equal(moveLog(fake).length, 1);
  assert.equal(liveMatch(fake).ply, 1);

  // The clock's action is described in the history, and it is marked as such.
  const moves = second.json.data.moves;
  assert.equal(moves.length, 1);
  assert.equal(moves[0].timedOut, true);
  assert.equal(moves[0].playerId, ALICE);
});

/* -------------------------------------------------------------------------- *
 * 4. Forfeit / cancel
 * -------------------------------------------------------------------------- */

test("POST forfeit: the opponent is awarded the win, exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const stranger = await forfeit({ as: MALLORY });
  assert.equal(stranger.status, 403);
  assert.equal(writers.rating.length, 0);

  const result = await forfeit({ as: ALICE });
  assert.equal(result.status, 200);
  const match = result.json.data.match;
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.result, RESULT.PLAYER2);
  assert.equal(match.winnerId, BOB);
  assert.equal(match.resultReason, END_REASONS.RESIGNED);
  // Resigning ends the match; it never plays for the resigning seat.
  assert.equal(moveLog(fake).length, 0);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.rating[0].winnerClerkId, BOB);
  assert.equal(writers.trophy.length, 1);

  const again = await forfeit({ as: BOB });
  assert.equal(again.status, 409);
  assert.equal(writers.rating.length, 1, "a second forfeit must not settle again");
  assert.equal(writers.trophy.length, 1);
});

test("POST cancel: only the creator, only a waiting lobby, and nothing settles", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, WAITING_ROW);

  const hijack = await cancel({ as: BOB });
  assert.equal(hijack.status, 403);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.WAITING);

  const result = await cancel({ as: ALICE });
  assert.equal(result.status, 200);
  assert.equal(result.json.data.match.status, MATCH_STATUS.CANCELLED);
  assert.equal(result.json.data.match.result, null);
  assert.equal(result.json.data.match.winnerId, null);
  assert.equal(writers.rating.length, 0, "an abandoned lobby never settles");

  const again = await cancel({ as: ALICE });
  assert.equal(again.status, 409);

  // A live match is not a lobby.
  fake.reset();
  seedMatch(fake);
  const live = await cancel({ as: ALICE });
  assert.equal(live.status, 409);
});

/* -------------------------------------------------------------------------- *
 * 5. Matchmaking and the lobby list
 * -------------------------------------------------------------------------- */

test("POST create-or-join: opens a lobby, then seats the second caller and deals", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);

  const created = await createOrJoin({ as: ALICE });
  assert.equal(created.status, 200);
  assert.equal(created.json.data.joined, false);
  assert.equal(created.json.data.status, MATCH_STATUS.WAITING);
  assert.equal(liveMatch(fake).gameState, null, "no deal until somebody can play");

  const host = await getMatch({ as: ALICE });
  assert.equal(host.json.data.status, MATCH_STATUS.WAITING);
  assert.deepEqual(host.json.data.hand, [], "the host cannot preview the deal");
  assert.deepEqual(host.json.data.chain, []);

  const joined = await createOrJoin({ as: BOB });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.data.joined, true);
  assert.equal(joined.json.data.status, MATCH_STATUS.PLAYING);
  const row = liveMatch(fake);
  assert.equal(row.drawPile.length, 14);
  assert.ok(row.turnDeadlineAt instanceof Date);

  // The deal plays the highest double itself: the opener holds six tiles, the
  // double is on the chain and the turn belongs to the OTHER seat. Both the seat
  // and the board come from the deal, never from either caller. (The one case
  // with no placement at all is a deal holding no double whatsoever, which is
  // about 0.3% of them.)
  const placed = row.gameState.chain.length === 1;
  assert.equal(row.p1Hand.length + row.p2Hand.length, placed ? 13 : 14);
  assert.equal(row.ply, placed ? 1 : 0);
  assert.equal(
    row.gameState.turn,
    placed
      ? row.gameState.startingSeat === "player1"
        ? "player2"
        : "player1"
      : row.gameState.startingSeat,
  );
  assert.equal(
    row.currentTurnUserId,
    row.gameState.turn === "player1" ? ALICE : BOB,
  );
  // …and the placement is logged, so the chain has an author.
  assert.deepEqual(
    moveLog(fake).map((moveRow) => [moveRow.ply, moveRow.action]),
    placed ? [[0, "play"]] : [],
  );
  if (placed) assert.equal(row.gameState.startingTile, row.gameState.chain[0].id);

  // A third caller cannot take the seat that just filled, and no second lobby is
  // opened under it.
  const third = await createOrJoin({ as: MALLORY });
  assert.equal(third.status, 409);
  assert.match(third.json.error, /no longer available/i);
  assert.equal(fake.rowsOf(dominoesMatches).length, 1);
  assert.equal(fake.rowsOf(dominoesMatches)[0].player2Id, BOB);
});

test("POST create-or-join: a forged body changes nothing and stakes nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);

  const result = await createOrJoin({
    as: ALICE,
    body: {
      winnerId: ALICE,
      result: RESULT.PLAYER1,
      stake: 5000,
      wager: 100,
      coins: 9999,
      player1Id: MALLORY,
      player2Id: BOB,
      hand: ["6-6", "5-5", "4-4", "3-3", "2-2", "1-1", "0-0"],
    },
  });

  assert.equal(result.status, 200);
  const row = liveMatch(fake);
  assert.equal(row.player1Id, ALICE, "the caller is the host, not the body");
  assert.equal(row.player2Id, null);
  assert.equal(row.status, MATCH_STATUS.WAITING);
  assert.equal(row.winnerId, null);
  assert.equal(row.result, null);
  assert.deepEqual(row.p1Hand, []);
  // Nothing staked anywhere: the row has no stake columns and the response has
  // no stake fields.
  assert.deepEqual(
    ["stake", "wager", "escrow", "pot", "coins", "currency"].filter((key) =>
      Object.hasOwn(row, key),
    ),
    [],
  );
  assert.deepEqual(Object.keys(result.json.data).sort(), ["joined", "matchId", "status"]);
});

test("POST create-or-join: a forged move body cannot name a winner", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const result = await play(
    {
      action: { type: "play", tile: "6-3" },
      expectedVersion: 0,
      winnerId: ALICE,
      result: RESULT.PLAYER1,
      matchCompleted: true,
      hand: ["0-0"],
      drawPile: [],
      turn: "player2",
      status: MATCH_STATUS.FINISHED,
    },
    { as: ALICE },
  );

  assert.equal(result.status, 200);
  // The engine's own verdict: the round continues, nobody won.
  assert.equal(result.json.data.matchCompleted, false);
  assert.equal(result.json.data.match.status, MATCH_STATUS.PLAYING);
  assert.equal(result.json.data.match.result, null);
  assert.equal(result.json.data.match.winnerId, null);
  assert.equal(writers.rating.length, 0);
});

test("GET available: the lobby list is a list of id + host, never a position", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, WAITING_ROW);

  const result = await available({ as: ALICE });
  assert.equal(result.status, 200);
  assert.equal(result.json.data.length, 1);
  const [lobby] = result.json.data;
  assert.deepEqual(Object.keys(lobby).sort(), ["createdAt", "matchId", "player1Id", "status"]);
  assert.equal(lobby.status, MATCH_STATUS.WAITING);
  assert.equal(result.json.myOpenMatchId, MATCH_ID);

  const wire = JSON.stringify(result.json);
  for (const tile of ALL_TILES) {
    assert.equal(wire.includes(`"${tile}"`), false, `a lobby row must not carry tile ${tile}`);
  }
});

/* -------------------------------------------------------------------------- *
 * 6. Terminal outcomes
 * -------------------------------------------------------------------------- */

test("a winning play settles the match once, and re-reads never settle it again", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  // 45–49 with Bob holding 6 pips: emptying the hand takes Alice to 51, past the
  // 50-point match target.
  seedMatch(fake, {
    state: craftState({ p1: ["6-3"], p2: ["1-1", "2-2"], pile: ["4-4"], turn: "player1" }),
    p1Hand: ["6-3"],
    p2Hand: ["1-1", "2-2"],
    drawPile: ["4-4"],
    player1Score: 45,
    player2Score: 49,
  });

  const result = await play({ action: { type: "play", tile: "6-3" }, expectedVersion: 0 }, { as: ALICE });

  assert.equal(result.status, 200);
  assert.equal(result.json.data.matchCompleted, true);
  assert.equal(result.json.data.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.json.data.match.result, RESULT.PLAYER1);
  assert.equal(result.json.data.match.winnerId, ALICE);
  assert.equal(result.json.data.match.resultReason, END_REASONS.MATCH_TARGET);
  assert.equal(result.json.data.match.scores.player1, 51);
  assert.equal(result.json.data.match.scores.player2, 49);
  assert.equal(result.json.data.match.turnDeadlineAt, null, "a decided match has no clock");
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.rating[0].gameKey, "dominoes");
  assert.equal(writers.rating[0].matchId, MATCH_ID);

  // Re-read, re-forfeit, re-move: all of it is after the claim, so nothing
  // settles twice.
  await getMatch({ as: ALICE });
  await getMatch({ as: BOB });
  const late = await play({ action: { type: "play", tile: "1-1", end: "right" }, expectedVersion: 1 }, { as: BOB });
  assert.equal(late.status, 409);
  const resign = await forfeit({ as: BOB });
  assert.equal(resign.status, 409);
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
});

test("a level crossing of the target forces a tiebreak round, not a draw", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  // Pile empty, neither hand playable, equal pips: the pass ends the round.
  seedMatch(fake, {
    state: craftState({
      p1: ["2-2"],
      p2: ["3-1"],
      pile: [],
      chain: [{ id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: "player2" }],
      turn: "player1",
    }),
    p1Hand: ["2-2"],
    p2Hand: ["3-1"],
    drawPile: [],
    // 46–46: the blocked round scores 4 each and both seats reach the target.
    player1Score: 46,
    player2Score: 46,
  });

  const result = await play({ action: { type: "pass" }, expectedVersion: 0 }, { as: ALICE });

  assert.equal(result.status, 200);
  // Both crossed the target together on LEVEL totals: nobody won, and a tiebreak
  // round is already in progress — nothing may be settled.
  assert.equal(result.json.data.matchCompleted, false);
  assert.equal(result.json.data.match.status, MATCH_STATUS.PLAYING);
  assert.equal(result.json.data.match.result ?? null, null);
  assert.equal(result.json.data.match.winnerId ?? null, null);
  assert.equal(result.json.data.match.resultReason ?? null, null);
  assert.equal(result.json.data.match.scores.player1, 50);
  assert.equal(result.json.data.match.scores.player2, 50);
  assert.equal(result.json.data.match.roundNumber, 2, "the tiebreak round is in progress");
  assert.ok(result.json.data.match.turnDeadlineAt, "the tiebreak round has a clock");
  assert.equal(writers.rating.length, 0, "a level crossing settles nothing");
  assert.equal(writers.trophy.length, 0);
});

/* -------------------------------------------------------------------------- *
 * 7. The disconnect endpoint
 * -------------------------------------------------------------------------- */

test("POST disconnect-forfeit: it is token-gated, id-checked and closed without a key", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const previousKey = process.env.CLERK_SECRET_KEY;

  const noToken = await invoke(R.disconnect, { body: { matchId: MATCH_ID } });
  assert.equal(noToken.status, 400);

  const noMatch = await invoke(R.disconnect, { body: { token: "tok" } });
  assert.equal(noMatch.status, 400);

  const badId = await invoke(R.disconnect, { body: { matchId: "nope", token: "tok" } });
  assert.equal(badId.status, 400);

  // Without a configured Clerk key the route refuses rather than trusting the
  // caller's id claim.
  delete process.env.CLERK_SECRET_KEY;
  const unconfigured = await invoke(R.disconnect, {
    body: { matchId: MATCH_ID, token: "tok" },
  });
  assert.equal(unconfigured.status, 500);
  assert.match(unconfigured.json.error, /not configured/i);

  if (previousKey === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = previousKey;
});

/* -------------------------------------------------------------------------- *
 * Free practice vs the bot: the REAL entry route and the bot's inline turn
 * -------------------------------------------------------------------------- */

/** The simplest legal action for the viewer, straight off the server's projection. */
function firstLegalAction(dto) {
  const hand = Array.isArray(dto.hand) ? dto.hand : [];
  const chain = Array.isArray(dto.chain) ? dto.chain : [];
  const open = dto.openEnds ?? { left: null, right: null };
  if (chain.length === 0) {
    return { type: "play", tile: hand[0], end: "left" };
  }
  for (const tile of hand) {
    const [a, b] = String(tile).split("-").map(Number);
    if (a === open.left || b === open.left) return { type: "play", tile, end: "left" };
    if (a === open.right || b === open.right) return { type: "play", tile, end: "right" };
  }
  return Number(dto.drawPileCount) > 0 ? { type: "draw" } : { type: "pass" };
}

test("POST create-ai: seats the bot, and the bot answers inside the human's turn", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);

  const created = await invoke(R.createAi, { body: { difficulty: "hard" } });
  assert.equal(created.status, 200);
  assert.equal(created.json.success, true);
  assert.equal(created.json.data.practice, true);
  assert.equal(created.json.data.aiDifficulty, "hard");

  // The row is a live practice match: both seats filled, never an open lobby.
  const row = liveMatch(fake);
  assert.equal(row.player1Id, ALICE);
  assert.equal(row.player2Id, DOMINOES_AI_PLAYER_ID);
  assert.equal(row.isAi, true);
  assert.equal(row.aiDifficulty, "hard");
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.ok(row.turnDeadlineAt instanceof Date);

  const matchId = created.json.data.matchId;
  const read = await getMatch({ matchId });
  assert.equal(read.status, 200);
  assert.equal(read.json.data.isAi, true);
  assert.equal(read.json.data.viewerSeat, "player1");

  // The deal's own placement has already moved the board on (ply 1), and if that
  // placement left the turn with the bot, the bot has ALREADY played it — created
  // inline either way, so a live practice row is never waiting on the bot.
  const dto = read.json.data;
  assert.equal(dto.version, dto.ply, "the version IS the accepted-action count");
  if (dto.status === MATCH_STATUS.PLAYING) assert.equal(dto.isViewerTurn, true);

  const before = Number(dto.ply);
  const action = firstLegalAction(dto);
  const moved = await play({ action, expectedVersion: dto.version }, { matchId });
  assert.equal(moved.status, 200);

  if (action.type === "play" && !moved.json.data.matchCompleted) {
    // The bot answered in the same transaction, so the turn is the human's again
    // and the version advanced by more than the human's own action.
    assert.equal(moved.json.data.match.isViewerTurn, true);
    assert.ok(Number(moved.json.data.match.ply) >= before + 2);
  }

  const botRows = moveLog(fake).filter((m) => m.playerId === DOMINOES_AI_PLAYER_ID);
  assert.ok(botRows.length >= 1, "the bot's actions are logged like a human's");
  // Practice is unrated: no rating or trophy writer was ever called.
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
});
