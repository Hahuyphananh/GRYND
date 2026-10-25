/**
 * hillstrike-routes.test.mjs
 *
 * THE ONLINE HILLSTRIKE HTTP SURFACE — the REAL route handlers, invoked.
 *
 * Same harness shape as tests/dominoes-routes.test.mjs: the Clerk age gate, the
 * Drizzle client, the seat-identity lookup and the shared progression writers are
 * mocked, the route modules are imported for real, and each handler is called with
 * a real `Request` and a real `params` promise. That way the status codes, the
 * JSON bodies and the ORDER of the guards (auth → id → store) are what is
 * asserted, not a re-implementation of them.
 *
 * `globalThis.io` is captured so the broadcast payloads can be audited too: a push
 * is an invalidation hint, so a trajectory, an impact, a board or an HP claim
 * appearing on the wire would be a leak even though it never reaches a response
 * body.
 *
 * The one thing this suite adds over the store suite is the TRANSPORT contract:
 * what the client is allowed to send (one engine action and a version, nothing
 * else) and what the server is allowed to believe (only those fields).
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/hillstrike-routes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { hillstrikeMatches, hillstrikeShots } from "../src/db/schema.ts";
import {
  END_REASONS,
  IMPACT_KINDS,
  MATCH_STATUS,
  MAX_HP,
} from "../src/lib/hillstrike/constants.ts";
import { simulateShot } from "../src/lib/hillstrike/physics.ts";
import { applyAction, createInitialState } from "../src/lib/hillstrike/rules.ts";

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
/** The request shape the routes accept: an ACTION, never bare input fields. */
const shoot = (shot) => ({ type: "shoot", ...shot });

/** Routes, by the name these tests use. */
const R = {
  createOrJoin: "src/app/api/hillstrike/create-or-join/route.ts",
  available: "src/app/api/hillstrike/available/route.ts",
  match: "src/app/api/hillstrike/match/[matchId]/route.ts",
  shot: "src/app/api/hillstrike/match/[matchId]/shot/route.ts",
  forfeit: "src/app/api/hillstrike/match/[matchId]/forfeit/route.ts",
  cancel: "src/app/api/hillstrike/match/[matchId]/cancel/route.ts",
  disconnect: "src/app/api/hillstrike/disconnect-forfeit/route.ts",
};

/* -------------------------------------------------------------------------- *
 * Engine helpers
 * -------------------------------------------------------------------------- */

function simulate(state, seat, shot) {
  return simulateShot({
    battlefield: state.battlefield,
    shooterSeat: seat,
    shot,
    projectile: state.projectile,
  });
}

/**
 * A direct hit on the other tank. The cover walls are tall, so the opening hit
 * window is narrow: this is a fine sweep at the high power bands.
 */
function hitShot(state, seat) {
  for (let power = 100; power >= 55; power -= 5) {
    for (let angle = 0; angle < 180; angle += 0.5) {
      const shot = { angleDeg: angle, power };
      const simulation = simulate(state, seat, shot);
      if (
        simulation.impact.kind === IMPACT_KINDS.PLAYER &&
        simulation.impact.target === other(seat)
      ) {
        return shot;
      }
    }
  }
  throw new Error(`no direct hit for ${seat} on seed ${state.seed} (ply ${state.turnIndex})`);
}

function outOfBoundsShot(state, seat) {
  const arc = seat === "player1" ? [20, 80] : [100, 160];
  for (let angle = arc[0]; angle <= arc[1]; angle += 1) {
    const shot = { angleDeg: angle, power: 100 };
    if (simulate(state, seat, shot).impact.kind === IMPACT_KINDS.OUT_OF_BOUNDS) {
      return shot;
    }
  }
  throw new Error(`no out-of-bounds line for ${seat}`);
}

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
    [hillstrikeShots, { action: "shoot", targetSeat: null, damage: 0, livesLost: 0 }],
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
        id: table === hillstrikeMatches ? crypto.randomUUID() : `row-${state.nextId++}`,
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
  process.env.CLERK_SECRET_KEY = "test_secret";

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
        player2: player2Id ? { name: "Bob", iconKey: null, profileFrame: null } : null,
        player1Id,
        player2Id: player2Id ?? null,
      }),
    },
  });
  t.mock.module("../src/lib/logError.ts", {
    namedExports: {
      logError: async () => {},
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

function matchRow(overrides = {}) {
  const state =
    overrides.gameState ?? createInitialState({ seed: SEED, openingSeat: "player1" });
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

async function invoke(routeRelPath, { method = "POST", matchId = MATCH_ID, body, as, gate } = {}) {
  if (as) session.userId = as;
  if (gate) session.gate = gate;
  const mod = await import(`../${routeRelPath}`);
  const path = routeRelPath.replace(/\[matchId\]/g, matchId);
  const req = new Request(`http://hillstrike.test/${path}`, {
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
const fire = (body, opts = {}) => invoke(R.shot, { body, ...opts });
const forfeit = (opts = {}) => invoke(R.forfeit, opts);
const cancel = (opts = {}) => invoke(R.cancel, opts);
const createOrJoin = (opts = {}) => invoke(R.createOrJoin, opts);
const available = (opts = {}) => invoke(R.available, { method: "GET", ...opts });
const disconnect = (body, opts = {}) => invoke(R.disconnect, { body, ...opts });

/* -------------------------------------------------------------------------- *
 * 0. The surface itself
 * -------------------------------------------------------------------------- */

test("surface: the route list is exactly the audited one, and every route is gated", { skip: SKIP_REASON }, () => {
  const root = "src/app/api/hillstrike";
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
    assert.match(src, /requireAgeVerifiedUser\(\)/, `${name} must be session-gated`);
    // Online Hillstrike is account-only: practice is a separate browser page.
    assert.doesNotMatch(src, /requirePracticePlayer/, `${name} must not accept a guest`);
  }

  // No route may read a decision-shaped field off a body, and no route has any
  // concept of a stake: Hillstrike PvP is unstaked.
  for (const path of Object.values(R)) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(
      src,
      /body\??\.(winner|winnerId|loserId|result|draw|tie|lives|life|damage|terrain|battlefield|blocks|towers|impact|path|trajectory|turn|ply|version|status|elo|rating|trophies|trophy|matchCompleted|completed|seed|openingSeat)\b/,
      `${path} must not read a client-supplied decision`,
    );
    assert.doesNotMatch(
      src,
      /body\??\.(stake|wager|bet|amount|coins|currency)\b|\b(stakeId|stakeAmount|wagerId|wagerAmount|escrowId)\b/,
      `${path} must not read or forward a stake — Hillstrike is unstaked`,
    );
  }

  // The store is the only place the engine runs: no route imports it.
  for (const path of Object.values(R)) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /from "[^"]*hillstrike\/(rules|physics|generation|ai)"/,
      `${path} must delegate the engine to the store`,
    );
  }
  const store = readFileSync("src/lib/hillstrike/serverStore.ts", "utf8");
  assert.match(store, /validateAction\(/, "the store validates with the engine");
  assert.match(store, /applyAction\(/, "the store resolves with the engine");
  assert.doesNotMatch(
    store,
    /simulateShot\(|createBattlefield\(/,
    "the store must not re-implement physics or the generator",
  );
});

test("surface: migrations 0229/0230 are the newest, idempotent, unique and money-free", { skip: SKIP_REASON }, () => {
  const migrations = readdirSync("src/db/migrations").filter((name) => name.endsWith(".sql"));
  const numbers = migrations.map((name) => Number(name.slice(0, 4))).sort((a, b) => a - b);
  const mine = migrations.find((name) => name.startsWith("0229_"));
  assert.ok(mine, "0229 must be the Hillstrike migration");
  const hpMigration = migrations.find((name) => name.startsWith("0230_"));
  assert.ok(hpMigration, "0230 must be the HP / three-action migration");
  assert.equal(Math.max(...numbers), 230, "0230 is the newest migration");

  const sql = readFileSync(`src/db/migrations/${mine}`, "utf8");
  const body = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  assert.match(body, /CREATE TABLE IF NOT EXISTS "hillstrike_matches"/);
  assert.match(body, /CREATE TABLE IF NOT EXISTS "hillstrike_shots"/);
  assert.match(
    body,
    /CREATE UNIQUE INDEX IF NOT EXISTS "hillstrike_shots_action_unique"\s+ON "hillstrike_shots" \("match_id", "action_index"\);/,
    "one persisted shot per action index per match",
  );
  assert.match(body, /"seed" bigint NOT NULL/);
  assert.match(body, /"initial_battlefield" jsonb NOT NULL/);
  assert.match(body, /"game_state" jsonb NOT NULL/);
  for (const banned of ["stake", "wager", "pot", "payout", "prize", "token", "coins"]) {
    assert.equal(
      new RegExp(`"\\w*${banned}\\w*"`, "i").test(body),
      false,
      `the migration must not carry a ${banned} column`,
    );
  }

  // The Drizzle declarations must describe the same columns the SQL creates.
  const schema = readFileSync("src/db/schema.ts", "utf8");
  const block = schema.slice(
    schema.indexOf("export const hillstrikeMatches"),
    schema.indexOf("// SOLITAIRE DUEL"),
  );
  for (const column of [
    "action:",
    "damage:",
  ]) {
    assert.match(block, new RegExp(`\\b${column}`), `the shots table must declare ${column}`);
  }
  for (const column of [
    "player1Id",
    "player2Id",
    "winnerId",
    "currentTurnUserId",
    "ply",
    "status",
    "seed",
    "fieldVersion",
    "openingSeat",
    "initialBattlefield",
    "gameState",
    "result",
    "resultReason",
    "startedAt",
    "endedAt",
  ]) {
    assert.match(block, new RegExp(`\\b${column}:`), `schema must declare ${column}`);
  }
  assert.match(block, /unique\("hillstrike_shots_action_unique"\)/);

  // 0230 teaches the log the three actions and makes an aim optional, because a
  // drive and a build have none.
  const alter = readFileSync(`src/db/migrations/${hpMigration}`, "utf8");
  assert.match(
    alter,
    /ADD COLUMN IF NOT EXISTS "action" varchar\(8\) DEFAULT 'shoot' NOT NULL/,
  );
  assert.match(alter, /ADD COLUMN IF NOT EXISTS "damage" integer DEFAULT 0 NOT NULL/);
  for (const column of ["angle_deg", "power", "impact_kind", "impact_x", "impact_y"]) {
    assert.match(
      alter,
      new RegExp(`ALTER COLUMN "${column}" DROP NOT NULL`),
      `${column} must be nullable so a drive or a build is not recorded as a shot`,
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
    () => fire({ action: shoot({ angleDeg: 45, power: 60 }), expectedVersion: 0 }, { gate: "signed-out" }),
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
    () => fire({ action: shoot({ angleDeg: 45, power: 60 }), expectedVersion: 0 }, { matchId: bad }),
    () => forfeit({ matchId: bad }),
    () => cancel({ matchId: bad }),
    () => disconnect({ matchId: bad, token: "good_token" }),
  ]) {
    const result = await call();
    assert.equal(result.status, 400);
    assert.equal(result.json.success, false);
  }
});

/* -------------------------------------------------------------------------- *
 * 1. Reads: the viewer projection
 * -------------------------------------------------------------------------- */

test("GET match: each seat gets the same public position and its own projection", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);

  const asAlice = await getMatch({ as: ALICE });
  assert.equal(asAlice.status, 200);
  const a = asAlice.json.data;
  assert.equal(a.viewerSeat, "player1");
  assert.equal(a.opponentSeat, "player2");
  assert.equal(a.isViewerTurn, true);
  assert.equal(a.version, 0);
  assert.equal(a.actionsRemaining, 1, "the opening turn is a single action");
  assert.equal(a.openingShotPending, true);
  assert.equal(a.seed, SEED);
  assert.equal(a.openingSeat, "player1");
  assert.equal(a.turn, "player1");
  assert.deepEqual(a.hp, { player1: MAX_HP, player2: MAX_HP });
  // Perfect information: the whole battlefield is public to both seats.
  assert.ok(a.gameState.battlefield.terrain.length > 0);
  assert.ok(a.gameState.battlefield.blocks.length > 0);
  assert.equal(a.players.player1.name, "Alice");
  assert.deepEqual(a.shots, []);

  const asBob = await getMatch({ as: BOB });
  assert.equal(asBob.status, 200);
  assert.equal(asBob.json.data.viewerSeat, "player2");
  assert.equal(asBob.json.data.isViewerTurn, false);
  assert.deepEqual(asBob.json.data.gameState, a.gameState, "one shared battlefield");

  const stranger = await getMatch({ as: MALLORY });
  assert.equal(stranger.status, 403);
  assert.equal(fake.state.writes.length, 0);
});

test("GET match: the action log is the server's own resolved record", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const shot = hitShot(row.gameState, "player1");

  const fired = await fire({ action: shoot(shot), expectedVersion: 0 }, { as: ALICE });
  assert.equal(fired.status, 200);

  const read = await getMatch({ as: BOB });
  assert.equal(read.status, 200);
  const [logged] = read.json.data.shots;
  assert.equal(logged.actionIndex, 0);
  assert.equal(logged.seat, "player1");
  assert.equal(logged.action, "shoot");
  assert.equal(logged.angleDeg, shot.angleDeg);
  assert.equal(logged.power, shot.power);
  assert.equal(logged.impactKind, IMPACT_KINDS.PLAYER);
  assert.ok(logged.damage > 0, "a direct hit records the HP it took off");
  assert.equal(logged.targetSeat, "player2");
  // The log's rows never carry the trajectory — it lives on `gameState.lastAction`.
  assert.equal(Object.hasOwn(logged, "path"), false);
  assert.ok(read.json.data.gameState.lastAction.path.length > 0);
  assert.equal(read.json.data.hp.player2, MAX_HP - logged.damage);
});

/* -------------------------------------------------------------------------- *
 * 2. The shot route
 * -------------------------------------------------------------------------- */

test("POST shot: the body carries an action and a version, and the server decides the rest", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const state = row.gameState;
  const shot = hitShot(state, "player1");
  const expected = applyAction(state, "player1", shoot(shot)).state;

  const result = await fire({ action: shoot(shot), expectedVersion: 0 }, { as: ALICE });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);

  const data = result.json.data;
  assert.equal(data.matchCompleted, false);
  assert.equal(data.actionIndex, 0);
  assert.deepEqual(data.match.gameState, expected, "the engine's resolution is returned");
  assert.equal(data.match.version, 1);
  assert.equal(data.match.hp.player1, MAX_HP, "the shooter's HP is untouched");
  assert.equal(data.match.hp.player2, MAX_HP - data.action.damage);
  assert.ok(data.action.damage > 0);
  // The action the client animates is the SERVER's, including its trajectory.
  assert.equal(data.action.type, "shoot");
  assert.deepEqual(data.action.impact, expected.lastAction.impact);
  assert.deepEqual(data.action.path, expected.lastAction.path);

  // The push is an invalidation hint: no board, no trajectory, no impact.
  assert.equal(broadcasts.length, 1);
  const push = broadcasts[0];
  assert.equal(push.room, `hillstrike:match:${MATCH_ID}`);
  assert.equal(push.event, "lobby:updated");
  const wire = JSON.stringify(push.payload);
  for (const field of ["gameState", "battlefield", "lastShot", "path", "impact", "shots", "shot"]) {
    assert.equal(wire.includes(`"${field}"`), false, `the broadcast must not carry ${field}`);
  }
  assert.equal(push.payload.version, 1);
  assert.equal(push.payload.matchCompleted, false);
});

test("POST shot: forged outcome fields are ignored, not honoured", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);

  // The fake ignores WHERE clauses, so each variant is driven on a freshly reset
  // match with the SAME seed and the SAME aim — the only difference is what the
  // client claims alongside it.
  const first = seedMatch(fake);
  const clean = outOfBoundsShot(first.gameState, "player1");
  const plain = await fire({ action: shoot(clean), expectedVersion: 0 }, { as: ALICE });
  assert.equal(plain.status, 200);

  fake.reset();
  seedMatch(fake);
  const forged = await fire(
    {
      action: {
        ...shoot(clean),
        damage: 99,
        hp: { player1: MAX_HP, player2: 0 },
        lives: { player1: 3, player2: 0 },
        targetSeat: "player2",
        winner: "player1",
        winnerId: ALICE,
        terrain: [],
        blocks: [],
        blockId: "forged-block",
        matchCompleted: true,
      },
      expectedVersion: 0,
    },
    { as: ALICE },
  );
  assert.equal(forged.status, 200);

  assert.deepEqual(forged.json.data.action.impact, plain.json.data.action.impact);
  assert.deepEqual(forged.json.data.match.gameState, plain.json.data.match.gameState);
  assert.equal(forged.json.data.matchCompleted, false);
  assert.deepEqual(forged.json.data.match.hp, { player1: MAX_HP, player2: MAX_HP });
  assert.equal(forged.json.data.match.gameState.winner, null);
  assert.equal(forged.json.data.match.gameState.hp.player2, MAX_HP);
});

test("POST shot: a drive and a build are the same route, and both reach the board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const tankBefore = row.gameState.battlefield.players.player1;
  const blocksBefore = row.gameState.battlefield.blocks.length;

  const drove = await fire(
    { action: { type: "move", direction: "forward" }, expectedVersion: 0 },
    { as: ALICE },
  );
  assert.equal(drove.status, 200);
  assert.equal(drove.json.data.action.type, "move");
  assert.equal(
    drove.json.data.match.gameState.battlefield.players.player1.x,
    tankBefore.x + 60,
    "the server moved the tank, not the client",
  );
  assert.equal(drove.json.data.match.hp.player1, MAX_HP, "a drive costs no HP");

  // Alice's single opening action is spent, so the build is Bob's to make.
  const built = await fire({ action: { type: "build" }, expectedVersion: 1 }, { as: BOB });
  assert.equal(built.status, 200);
  assert.equal(built.json.data.action.type, "build");
  const blocks = built.json.data.match.gameState.battlefield.blocks;
  assert.equal(blocks.length, blocksBefore + 1);
  assert.ok(blocks.some((block) => block.id === built.json.data.action.blockId));

  // The log has one row per action, each named for what it was.
  assert.deepEqual(
    shotLog(fake).map((entry) => entry.action),
    ["move", "build"],
  );
  for (const entry of shotLog(fake)) {
    assert.equal(entry.damage, 0);
    assert.equal(entry.angleDeg, null, "only a shot has an aim");
    assert.equal(entry.impactKind, null);
  }
  assert.equal(liveMatch(fake).ply, 2);
});

test("POST shot: the v1 bare-aim body still means exactly one shoot action", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const shot = outOfBoundsShot(row.gameState, "player1");

  const legacy = await fire({ shot, expectedVersion: 0 }, { as: ALICE });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.data.action.type, "shoot", "an old tab fires a shot, nothing else");
  assert.equal(shotLog(fake)[0].action, "shoot");
  assert.equal(shotLog(fake)[0].angleDeg, shot.angleDeg);
});

test("POST shot: refusals are specific and write nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const legal = shoot({ angleDeg: 45, power: 60 });

  const outOfTurn = await fire({ action: legal, expectedVersion: 0 }, { as: BOB });
  assert.equal(outOfTurn.status, 409);
  assert.match(outOfTurn.json.error, /not your turn/i);

  for (const action of [
    undefined,
    {},
    { type: "shoot" },
    { type: "jump" },
    { type: "shoot", angleDeg: 400, power: 60 },
    { type: "shoot", angleDeg: 45, power: 70.5 },
    { type: "shoot", angleDeg: 45, power: "70" },
    { type: "move" },
    { type: "move", direction: "up" },
  ]) {
    const result = await fire({ action, expectedVersion: 0 }, { as: ALICE });
    assert.equal(result.status, 400, `${JSON.stringify(action)} must be a 400`);
  }

  const missingVersion = await fire({ action: legal }, { as: ALICE });
  assert.equal(missingVersion.status, 400);

  const stale = await fire({ action: legal, expectedVersion: 4 }, { as: ALICE });
  assert.equal(stale.status, 409);

  const garbage = await fire("{not json", { as: ALICE });
  assert.equal(garbage.status, 400);

  assert.equal(row.ply, 0);
  assert.equal(shotLog(fake).length, 0);
  assert.equal(broadcasts.length, 0);
});

test("POST shot: a killed match settles once, through the route, and then refuses", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  const state = { ...base, hp: { player1: MAX_HP, player2: 1 } };
  const row = seedMatch(fake, { gameState: state });
  const shot = hitShot(state, "player1");

  const result = await fire({ action: shoot(shot), expectedVersion: 0 }, { as: ALICE });
  assert.equal(result.status, 200);
  assert.equal(result.json.data.matchCompleted, true);
  assert.equal(result.json.data.result, "player1");
  assert.equal(result.json.data.resultReason, END_REASONS.HP_DEPLETED);
  assert.equal(result.json.data.match.hp.player2, 0);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(liveMatch(fake).winnerId, ALICE);

  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
  assert.equal(writers.rating[0].gameKey, "hillstrike");
  assert.equal(writers.rating[0].matchId, MATCH_ID);

  const late = await fire({ action: shoot(shot), expectedVersion: 1 }, { as: BOB });
  assert.equal(late.status, 409);
  const lateForfeit = await forfeit({ as: BOB });
  assert.equal(lateForfeit.status, 409);
  assert.equal(writers.rating.length, 1, "settlement happens exactly once");
  assert.equal(shotLog(fake).length, 1);
  assert.equal(row.ply, 1);
});

test("POST shot: a replayed shot loses as a 409, and concurrent sends accept one", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const shot = outOfBoundsShot(row.gameState, "player1");

  const [first, second] = await Promise.all([
    fire({ action: shoot(shot), expectedVersion: 0 }, { as: ALICE }),
    fire({ action: shoot(shot), expectedVersion: 0 }, { as: ALICE }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(shotLog(fake).length, 1);
  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialises the two requests");

  // The storage-level backstop: even if the version check were bypassed, the
  // unique (match_id, action_index) index turns a replay into a 409.
  fake.reset();
  const replayRow = seedMatch(fake);
  fake.state.failInserts.add(hillstrikeShots);
  const replayed = await fire(
    {
      action: shoot(outOfBoundsShot(replayRow.gameState, "player1")),
      expectedVersion: 0,
    },
    { as: ALICE },
  );
  assert.equal(replayed.status, 409);
  assert.match(replayed.json.error, /already recorded/i);
});

/* -------------------------------------------------------------------------- *
 * 3. Matchmaking and lobby lifecycle
 * -------------------------------------------------------------------------- */

test("POST create-or-join: an empty body is enough, and the server seats both players", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);

  const created = await createOrJoin({ body: {} });
  assert.equal(created.status, 200);
  assert.equal(created.json.data.joined, false);
  assert.equal(created.json.data.status, MATCH_STATUS.WAITING);
  assert.equal(fake.rowsOf(hillstrikeMatches).length, 1);

  const resumed = await createOrJoin({ body: {} });
  assert.equal(resumed.json.data.matchId, created.json.data.matchId);
  assert.equal(resumed.json.data.joined, false);

  const joined = await createOrJoin({ as: BOB });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.data.joined, true);
  assert.equal(joined.json.data.status, MATCH_STATUS.PLAYING);
  assert.equal(liveMatch(fake).player2Id, BOB);

  // The opening seat opens: the other seat is refused before it can fire.
  const opener = liveMatch(fake).gameState.turn;
  const opened = await fire(
    {
      action: shoot(outOfBoundsShot(liveMatch(fake).gameState, opener)),
      expectedVersion: 0,
    },
    { as: opener === "player1" ? ALICE : BOB },
  );
  assert.equal(opened.status, 200);
});

test("GET available: the open list and the caller's own waiting lobby", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, {
    status: MATCH_STATUS.WAITING,
    player2Id: null,
    currentTurnUserId: null,
  });

  const listed = await available({ as: ALICE });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.success, true);
  assert.equal(listed.json.data.length, 1);
  assert.equal(listed.json.data[0].matchId, MATCH_ID);
  assert.equal(listed.json.data[0].seed, SEED);
  assert.equal(listed.json.myOpenMatchId, MATCH_ID);
});

test("POST cancel: only the creator, only a waiting lobby, and it never settles", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake, {
    status: MATCH_STATUS.WAITING,
    player2Id: null,
    currentTurnUserId: null,
  });

  const hijack = await cancel({ as: BOB });
  assert.equal(hijack.status, 403);

  const cancelled = await cancel({ as: ALICE });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.data.match.status, MATCH_STATUS.CANCELLED);
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].payload.cancelled, true);
});

test("POST forfeit: the opponent wins, the position is untouched, and the push says so", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const row = seedMatch(fake);
  const before = JSON.stringify(row.gameState);

  const stranger = await forfeit({ as: MALLORY });
  assert.equal(stranger.status, 403);

  const resigned = await forfeit({ as: ALICE });
  assert.equal(resigned.status, 200);
  assert.equal(resigned.json.data.match.status, MATCH_STATUS.FINISHED);
  assert.equal(resigned.json.data.match.result, "player2");
  assert.equal(resigned.json.data.match.resultReason, END_REASONS.RESIGNED);
  assert.equal(JSON.stringify(resigned.json.data.match.gameState), before);
  assert.equal(writers.rating.length, 1);
  assert.equal(broadcasts[0].payload.forfeited, true);

  // A recursive resignation of a settled match is a 409, not a second settlement.
  const again = await forfeit({ as: BOB });
  assert.equal(again.status, 409);
  assert.equal(writers.rating.length, 1);
});

/* -------------------------------------------------------------------------- *
 * 4. Disconnect resolution
 * -------------------------------------------------------------------------- */

test("disconnect: it is token-gated, id-checked and closed without a key", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seedMatch(fake);
  const previousKey = process.env.CLERK_SECRET_KEY;

  const noToken = await disconnect({ matchId: MATCH_ID });
  assert.equal(noToken.status, 400);

  const noMatch = await disconnect({ token: "tok" });
  assert.equal(noMatch.status, 400);

  const badId = await disconnect({ matchId: "nope", token: "tok" });
  assert.equal(badId.status, 400);

  // A token that Clerk will not verify is a 401 — the route never trusts a
  // caller's id claim, which is what makes this only ever resolve the token
  // owner's OWN match.
  const badToken = await disconnect({ matchId: MATCH_ID, token: "not-a-real-token" });
  assert.equal(badToken.status, 401);
  assert.equal(liveMatch(fake).status, MATCH_STATUS.PLAYING);
  assert.equal(writers.rating.length, 0);

  // Without a configured Clerk key the route refuses rather than resolving.
  delete process.env.CLERK_SECRET_KEY;
  const unconfigured = await disconnect({ matchId: MATCH_ID, token: "tok" });
  assert.equal(unconfigured.status, 500);
  assert.match(unconfigured.json.error, /not configured/i);

  if (previousKey === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = previousKey;
});

/* -------------------------------------------------------------------------- *
 * 5. Channels
 * -------------------------------------------------------------------------- */

test("realtime: the room vocabulary matches the realtime server exactly", { skip: SKIP_REASON }, async () => {
  const rooms = await import("../src/lib/hillstrike/rooms.ts");
  const realtime = readFileSync("realtime-server/server.js", "utf8");

  assert.equal(rooms.HILLSTRIKE_MATCH_ROOM_PREFIX, "hillstrike:match:");
  assert.equal(rooms.hillstrikeMatchRoom("abc"), "hillstrike:match:abc");
  assert.equal(rooms.HILLSTRIKE_MATCH_UPDATED, "lobby:updated");
  assert.equal(rooms.HILLSTRIKE_READY, "hillstrike:ready");
  assert.equal(rooms.HILLSTRIKE_LOBBY_ROOM, "lobby:hillstrike");

  // The CommonJS server restates the literal (it cannot import TypeScript).
  assert.match(
    realtime,
    /HILLSTRIKE_MATCH_ROOM_PREFIX = "hillstrike:match:";/,
    "the realtime server must use the same room prefix",
  );
  assert.match(realtime, /socket\.on\("hillstrike:ready"/);
  assert.match(realtime, /trackHillstrikeJoin\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(realtime, /trackHillstrikeLeave\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(realtime, /\/api\/hillstrike\/disconnect-forfeit/);
  assert.match(
    realtime,
    /cancelDisconnectGraceTimer\(`hillstrike:\$\{matchId\}:\$\{userId\}`\)/,
    "a rejoin must cancel the grace timer",
  );

  // The broadcast helper no-ops safely when no io instance exists.
  const previousIo = globalThis.io;
  globalThis.io = undefined;
  assert.equal(rooms.broadcastMatchUpdate("abc", { status: "playing" }), false);
  globalThis.io = previousIo;
});
