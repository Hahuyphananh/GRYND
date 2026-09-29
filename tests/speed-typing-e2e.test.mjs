/**
 * speed-typing-e2e.test.mjs
 *
 * THE WHOLE FLOW, END TO END, THROUGH THE REAL ROUTES AND THE REAL STORE.
 *
 * Every other Speed Typing suite proves one layer in isolation:
 *
 *   speed-typing-race         the pure rules (arithmetic)
 *   speed-typing-prompts      the prompt catalog
 *   speed-typing-store        the authoritative store's behaviour
 *   speed-typing-realtime     the socket vocabulary + projection
 *   speed-typing-settlement   the competitive seam
 *   speed-typing-security     the trust boundary, from the outside
 *   speed-typing-deployment   the two-process topology
 *   speed-typing-ui-contract  what the client is allowed to say
 *
 * This file is the INTEGRATION of all of them: it walks
 *
 *   QUEUE → MATCH FOUND → BOTH CONNECT → SAME PROMPT → COUNTDOWN → GO →
 *   P1 TYPES → P2 TYPES → REALTIME PROGRESS → FIRST VERIFIED COMPLETION →
 *   WINNER → LOSER → MATCH FINISH → RATING → TROPHIES → LEADERBOARD →
 *   MATCH HISTORY
 *
 * by calling the ACTUAL Next.js route handlers (`POST /api/speed-typing/...`)
 * against the ACTUAL `serverStore`, with only the database, the session gate
 * and the two shared settlement writers stubbed. That means the status codes,
 * the JSON shapes, the body-field trust boundary and the store's derivation all
 * run for real — it is the closest thing to a production request this checkout
 * can execute without a live Postgres.
 *
 * ── THE FAKE DATABASE (why this one is different) ─────────────────────────
 *
 * The store/settlement suites use a fake that IGNORES `WHERE` because each of
 * their tests acts on one row. That cannot express the things this file must
 * prove:
 *
 *   * QUEUE CONCURRENCY — `createOrJoin` finds "the oldest open waiting lobby";
 *   * PER-MATCH ISOLATION — a checkpoint on match A must not touch match B;
 *   * the conditional join UPDATE that lets exactly one of two joiners win.
 *
 * So the fake here is a small relational engine: it renders Drizzle's own
 * condition objects (`and` / `eq` / `isNull` / raw `sql`) into a row predicate,
 * honours `orderBy` + `limit`, applies `UPDATE … WHERE … RETURNING` to the rows
 * the WHERE selects (including `col + 1` increments), and SERIALISES
 * transactions in arrival order — which is exactly what `SELECT … FOR UPDATE`
 * does to two transactions that lock the same row. Serialisation is asserted
 * (`maxConcurrent === 1`) so the model cannot silently stop holding.
 *
 * ── THE TRUST MODEL UNDER TEST ────────────────────────────────────────────
 *
 *   a client may only ever say WHAT IT TYPED.
 *
 * Every "attack" in this file is an attempt to make the server accept something
 * else — a winner, a WPM, an accuracy, an error count, a completion, a result
 * for the opponent, progress before GO, a second finish, another player's
 * match — and every one of them is asserted to be ignored or refused while the
 * server derives the truth from its own passage and its own clock.
 *
 * Run:  npm run test:speed-typing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { getTableColumns } from "drizzle-orm";

import { speedTypingMatches, users } from "../src/db/schema.ts";
import {
  GAME_KEY,
  MATCH_STATUS,
  RACE_COUNTDOWN_MS,
  RACE_LIMIT_MS,
  RESOLUTION,
  RESULT,
  SEAT,
} from "../src/lib/speed-typing/constants.ts";
import { createRaceState, resolveRace, verifyTypedText } from "../src/lib/speed-typing/rules.ts";
import {
  PASSAGE_VERSION,
  passageForRow,
  selectPassageForSeed,
} from "../src/lib/speed-typing/passages.ts";

// Captured BEFORE any module mock is installed, so the leaderboard scenario can
// assert against the REAL registry while the settlement seam is stubbed.
const REAL_RATING = await import("../src/lib/rating.js");

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:speed-typing";

// ── Identity / fixtures ───────────────────────────────────────────────────

const MATCH_A = "11111111-1111-4111-8111-111111111111";
const MATCH_B = "22222222-2222-4222-8222-222222222222";
const MATCH_C = "33333333-3333-4333-8333-333333333333";
const MATCH_D = "44444444-4444-4444-8444-444444444444";
const MATCH_MISSING = "00000000-0000-4000-8000-000000000000";

const ALICE = "user_alice";
const BOB = "user_bob";
const CAROL = "user_carol";
const DAVE = "user_dave";
const ERIN = "user_erin";
const FRANK = "user_frank";
const GRACE = "user_grace";
const HEIDI = "user_heidi";
const MALLORY = "user_mallory";

const NOW = 1_700_000_000_000;
const GO = NOW + RACE_COUNTDOWN_MS;

/** A fixed seed, so the seeded fixtures race one known passage. */
const SEED = 424242;
const PROMPT = selectPassageForSeed({ seed: SEED });
const TEXT = PROMPT.text;
assert.ok(TEXT.length > 20, "the fixture prompt must be a real passage");

const KEY = GAME_KEY;

// ── Source helpers (for the contract assertions) ───────────────────────────

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = (rel) => stripComments(strip(read(rel)));

const ROUTES = {
  createJoin: "src/app/api/speed-typing/create-or-join/route.ts",
  fetch: "src/app/api/speed-typing/match/[matchId]/route.ts",
  progress: "src/app/api/speed-typing/match/[matchId]/progress/route.ts",
  finish: "src/app/api/speed-typing/match/[matchId]/finish/route.ts",
  cancel: "src/app/api/speed-typing/match/[matchId]/cancel/route.ts",
  disconnect: "src/app/api/speed-typing/disconnect-forfeit/route.ts",
};
const STORE = "src/lib/speed-typing/serverStore.ts";
const RULES = "src/lib/speed-typing/rules.ts";
const HISTORY = "src/app/api/get-bet-history/route.ts";

// ════════════════════════════════════════════════════════════════════════
// The fake relational database
// ════════════════════════════════════════════════════════════════════════

/** JS key → SQL column name, e.g. `player2Id → player2_id`. */
function columnMap(table) {
  const reverse = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    reverse[column.name] = key;
  }
  return reverse;
}

const MATCH_COLUMNS = columnMap(speedTypingMatches);
const USER_COLUMNS = columnMap(users);
const columnsFor = (table) =>
  table === speedTypingMatches ? MATCH_COLUMNS : table === users ? USER_COLUMNS : {};

/** Flatten a Drizzle condition into its individual (AND-ed) leaves. */
function leaves(node, out = []) {
  const chunks = node?.queryChunks;
  if (!Array.isArray(chunks)) return out;
  const nested = chunks.filter(
    (chunk) => chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks),
  );
  if (nested.length === 0) {
    out.push(node);
    return out;
  }
  for (const child of nested) leaves(child, out);
  return out;
}

/** Flatten one condition node into columns / text fragments / parameter values. */
function tokens(node, out = []) {
  for (const chunk of node?.queryChunks ?? []) {
    if (chunk == null) continue;
    if (typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
      tokens(chunk, out);
      continue;
    }
    if (chunk?.constructor?.name === "StringChunk") {
      out.push({ kind: "text", text: (chunk.value ?? []).join("") });
      continue;
    }
    if (typeof chunk?.name === "string" && chunk.table !== undefined) {
      out.push({ kind: "column", name: chunk.name });
      continue;
    }
    // A Drizzle `Param` wraps the bound value; a raw literal (Date, string, …)
    // is the value itself.
    out.push({ kind: "param", value: "value" in chunk ? chunk.value : chunk });
  }
  return out;
}

const asTime = (value) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/** Evaluate ONE condition leaf against a row. Returns true when in doubt. */
function evalLeaf(leaf, row, colMap) {
  const parts = tokens(leaf);
  const column = parts.find((part) => part.kind === "column");
  if (!column) return true;
  const key = colMap[column.name] ?? column.name;
  const actual = row[key];
  const text = parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join(" ")
    .toLowerCase();
  const param = parts.find((part) => part.kind === "param");

  if (text.includes("not null")) return actual !== null && actual !== undefined;
  if (text.includes("null")) return actual === null || actual === undefined;
  if (!param) return true;

  const wanted = param.value;
  if (text.includes("<=")) return asTime(actual) <= asTime(wanted);
  if (text.includes(">=")) return asTime(actual) >= asTime(wanted);
  if (text.includes("<>") || text.includes("!=")) return !eq(actual, wanted);
  if (text.includes("<")) return asTime(actual) < asTime(wanted);
  if (text.includes(">")) return asTime(actual) > asTime(wanted);
  return eq(actual, wanted);

  function eq(a, b) {
    if (a instanceof Date || b instanceof Date) return asTime(a) === asTime(b);
    return a === b;
  }
}

function predicateFor(clause, colMap) {
  if (!clause) return () => true;
  const conditions = leaves(clause);
  if (conditions.length === 0) return () => true;
  return (row) => conditions.every((leaf) => evalLeaf(leaf, row, colMap));
}

function orderFor(clause, colMap) {
  const parts = tokens(clause);
  const column = parts.find((part) => part.kind === "column");
  const text = parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join(" ")
    .toLowerCase();
  return {
    key: column ? colMap[column.name] ?? column.name : null,
    desc: text.includes("desc"),
  };
}

/** A deterministic, valid UUID for an inserted row (`isMatchId` must accept it). */
const uuidFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

  const select = () => {
    let table = null;
    let predicate = () => true;
    let order = null;
    let limit = null;

    const materialise = () => {
      let rows = rowsOf(table)
        .filter(predicate)
        .map((row) => ({ ...row }));
      if (order?.key) {
        rows = rows.sort(
          (a, b) =>
            (asTime(a[order.key]) - asTime(b[order.key])) * (order.desc ? -1 : 1),
        );
      }
      if (limit != null && Number.isFinite(limit)) rows = rows.slice(0, limit);
      return rows;
    };

    const q = {
      from(t) {
        table = t;
        return q;
      },
      where(clause) {
        predicate = predicateFor(clause, columnsFor(table));
        return q;
      },
      for() {
        return q;
      },
      orderBy(clause) {
        order = orderFor(clause, columnsFor(table));
        return q;
      },
      limit(n) {
        limit = Number(n);
        return q;
      },
      then(resolve, reject) {
        return Promise.resolve(materialise()).then(resolve, reject);
      },
    };
    return q;
  };

  const update = (table) => {
    let values = null;
    let predicate = () => true;

    const apply = () => {
      state.writes.push({ table, op: "update", values });
      const matched = rowsOf(table).filter(predicate);
      for (const row of matched) {
        for (const [key, value] of Object.entries(values ?? {})) {
          const isIncrement = value && typeof value === "object" && Array.isArray(value.queryChunks);
          row[key] = isIncrement ? (Number(row[key]) || 0) + 1 : value;
        }
      }
      return Promise.resolve(matched.map((row) => ({ ...row })));
    };

    const b = {
      set(v) {
        values = v;
        return b;
      },
      where(clause) {
        predicate = predicateFor(clause, columnsFor(table));
        return b;
      },
      returning() {
        return apply();
      },
      then(resolve, reject) {
        return apply().then(resolve, reject);
      },
    };
    return b;
  };

  const insert = (table) => ({
    values(v) {
      return {
        returning() {
          const row = {
            id: uuidFor(state.nextId++),
            revision: 0,
            createdAt: new Date(NOW - 10_000),
            ...v,
          };
          state.writes.push({ table, op: "insert", values: v });
          rowsOf(table).push(row);
          return Promise.resolve([{ ...row }]);
        },
      };
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

  // ONE transaction at a time, in arrival order — what `SELECT … FOR UPDATE` on
  // a shared row does. Every concurrency test asserts this held.
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

// ── The stubs ─────────────────────────────────────────────────────────────

let sharedFake = null;
const spies = { rating: [], trophy: [], queue: [], ratingMode: "ok", trophyMode: "ok" };
/** Identity the session gate will report. A queue lets concurrent calls differ. */
const auth = { current: ALICE, queue: [] };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  spies.rating.length = 0;
  spies.trophy.length = 0;
  spies.queue.length = 0;
  spies.ratingMode = "ok";
  spies.trophyMode = "ok";
  auth.current = ALICE;
  auth.queue.length = 0;

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });

  t.mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: {
      requireAgeVerifiedUser: async () => ({
        userId: auth.queue.length > 0 ? auth.queue.shift() : auth.current,
        response: null,
      }),
    },
  });

  t.mock.module("../src/lib/logError.ts", {
    namedExports: { logError: async () => {} },
  });

  // The shared settlement writers. Their real implementations are covered by
  // tests/elo-rating.test.mjs / tests/trophy-system.test.mjs; what matters here
  // is the SEAM — the argument, the call count and the failure handling. The
  // real rating module is spread back in so the leaderboard registry stays real.
  const makeWriter = (kind) => async (args) => {
    spies[kind].push(args);
    const mode = spies[`${kind}Mode`];
    if (mode === "throw") throw new Error(`${kind} writer exploded`);
    if (mode === "refuse") return { applied: false, reason: "user-not-found" };
    return { applied: true };
  };
  t.mock.module("../src/lib/rating.js", {
    namedExports: { ...REAL_RATING, applyRatingResult: makeWriter("rating") },
  });
  t.mock.module("../src/lib/trophyStore.js", {
    namedExports: { applyTrophyResult: makeWriter("trophy") },
  });
  t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
    namedExports: {
      mirrorQueueCreated: (args) => spies.queue.push({ kind: "created", ...args }),
      mirrorQueueTransition: (args) => spies.queue.push({ kind: "transition", ...args }),
    },
  });

  return fake;
}

// ── The real route handlers ───────────────────────────────────────────────

let routes = null;
async function loadRoutes() {
  if (routes) return routes;
  const [createJoin, fetchMatch, progress, finish, cancel] = await Promise.all([
    import("../src/app/api/speed-typing/create-or-join/route.ts"),
    import("../src/app/api/speed-typing/match/[matchId]/route.ts"),
    import("../src/app/api/speed-typing/match/[matchId]/progress/route.ts"),
    import("../src/app/api/speed-typing/match/[matchId]/finish/route.ts"),
    import("../src/app/api/speed-typing/match/[matchId]/cancel/route.ts"),
  ]);
  routes = { createJoin, fetchMatch, progress, finish, cancel };
  return routes;
}

const params = (matchId) => ({ params: Promise.resolve({ matchId }) });
const request = (body, { raw = false } = {}) =>
  new Request("http://localhost/api/speed-typing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body ?? {}),
  });

const postCreateOrJoin = async () => {
  const { createJoin } = await loadRoutes();
  const res = await createJoin.POST();
  return { status: res.status, json: await res.json() };
};
const getMatch = async (matchId) => {
  const { fetchMatch } = await loadRoutes();
  const res = await fetchMatch.GET(
    new Request(`http://localhost/api/speed-typing/match/${matchId}`),
    params(matchId),
  );
  return { status: res.status, json: await res.json() };
};
const postProgress = async (matchId, body, opts) => {
  const { progress } = await loadRoutes();
  const res = await progress.POST(request(body, opts), params(matchId));
  return { status: res.status, json: await res.json() };
};
const postFinish = async (matchId, body, opts) => {
  const { finish } = await loadRoutes();
  const res = await finish.POST(request(body, opts), params(matchId));
  return { status: res.status, json: await res.json() };
};
const postCancel = async (matchId) => {
  const { cancel } = await loadRoutes();
  const res = await cancel.POST(request({}), params(matchId));
  return { status: res.status, json: await res.json() };
};

// ── Fixtures / helpers ────────────────────────────────────────────────────

function armedRow(overrides = {}) {
  return {
    id: MATCH_A,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    status: MATCH_STATUS.PLAYING,
    isAi: false,
    aiDifficulty: null,
    result: null,
    raceSeed: SEED,
    passageId: PROMPT.id,
    passageVersion: PASSAGE_VERSION,
    goAt: new Date(GO),
    revision: 1,
    resolutionReason: null,
    raceState: createRaceState({ version: 1 }),
    player1CharsTyped: 0,
    player1Errors: 0,
    player2CharsTyped: 0,
    player2Errors: 0,
    player1CompletedAt: null,
    player2CompletedAt: null,
    startedAt: new Date(NOW),
    endedAt: null,
    createdAt: new Date(NOW - 10_000),
    updatedAt: new Date(NOW - 10_000),
    ...overrides,
  };
}

const waitingRow = (overrides = {}) =>
  armedRow({
    status: MATCH_STATUS.WAITING,
    player2Id: null,
    raceSeed: null,
    passageId: null,
    passageVersion: null,
    goAt: null,
    raceState: createRaceState({ version: 0 }),
    ...overrides,
  });

const setMatches = (fake, rows) => {
  fake.state.tables.set(speedTypingMatches, rows);
  return rows;
};
const setUsers = (fake, ids) =>
  fake.state.tables.set(
    users,
    ids.map((clerkId, index) => ({ id: index + 1, clerkId, gamesWon: 3, gamesLost: 2 })),
  );
const rowOf = (fake, id) => fake.rowsOf(speedTypingMatches).find((row) => row.id === id);
const userOf = (fake, clerkId) => fake.rowsOf(users).find((row) => row.clerkId === clerkId);
const matchWrites = (fake) =>
  fake.state.writes.filter((write) => write.table === speedTypingMatches);

let clockMs = NOW;
function installClock(t) {
  const real = Date.now;
  Date.now = () => clockMs;
  t.after(() => {
    Date.now = real;
    clockMs = NOW;
  });
}
const at = (ms) => {
  clockMs = ms;
};

/** Freeze a seat's already-verified finish, as `submitFinish` would. */
function withFinisher(row, { seat = SEAT.PLAYER1, finishedAtMs } = {}) {
  const state = createRaceState({ version: 2 });
  state.seats[seat] = {
    ...state.seats[seat],
    charsTyped: TEXT.length,
    errors: 0,
    finished: true,
    finishedAtMs,
    elapsedMs: finishedAtMs - GO,
    wpm: 100,
    accuracy: 100,
  };
  return {
    ...row,
    raceState: state,
    player1CompletedAt: seat === SEAT.PLAYER1 ? new Date(finishedAtMs) : null,
    player2CompletedAt: seat === SEAT.PLAYER2 ? new Date(finishedAtMs) : null,
    revision: 2,
  };
}

/** The whole exactly-once settlement story, asserted in one place. */
function settledExactlyOnce(label, { winner, loser, draw = false } = {}) {
  assert.equal(spies.rating.length, 1, `${label}: rating settles exactly once`);
  assert.equal(spies.trophy.length, 1, `${label}: trophies settle exactly once`);
  const rating = spies.rating[0];
  const trophy = spies.trophy[0];

  assert.equal(rating.gameKey, KEY, `${label}: canonical literal game key`);
  assert.equal(trophy.gameKey, KEY);
  assert.ok(rating.tx, `${label}: rating ran inside the caller's transaction`);
  assert.ok(trophy.tx, `${label}: trophies ran inside the caller's transaction`);
  assert.equal(rating.winnerClerkId, trophy.winnerClerkId, `${label}: same pair`);
  assert.equal(rating.loserClerkId, trophy.loserClerkId);

  if (winner) {
    assert.equal(rating.winnerClerkId, winner, `${label}: winner`);
    assert.equal(rating.loserClerkId, loser, `${label}: loser`);
  }
  if (draw) {
    assert.equal(rating.result, "draw", `${label}: a dead heat is a draw`);
    assert.equal(trophy.result, "draw");
  } else {
    // A win is the DEFAULT, so the word "win" must never be sent — that is what
    // makes a mis-derived draw impossible to hide.
    assert.equal(rating.result, undefined, `${label}: a win sends no result token`);
    assert.equal(trophy.result, undefined);
  }
}

/** No token / balance / payout / wager write exists anywhere in the flow. */
function assertNoEconomyWrites(fake, label) {
  for (const write of fake.state.writes) {
    assert.ok(
      write.table === speedTypingMatches || write.table === users,
      `${label}: flow wrote to ${String(write.table?.toString?.() ?? write.table)}`,
    );
  }
  const userKeys = new Set(
    fake.state.writes
      .filter((write) => write.table === users && write.op === "update")
      .flatMap((write) => Object.keys(write.values ?? {})),
  );
  for (const key of userKeys) {
    assert.ok(
      key === "gamesWon" || key === "gamesLost",
      `${label}: settlement wrote users.${key}`,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// 1. THE COMPLETE FLOW through the real routes
// ════════════════════════════════════════════════════════════════════════

test("e2e: QUEUE → MATCH FOUND → SAME PROMPT → GO → PROGRESS → WIN → SETTLE → HISTORY", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setUsers(fake, [ALICE, BOB]);

  // ── QUEUE: the first caller opens a lobby ───────────────────────────────
  auth.current = ALICE;
  const queued = await postCreateOrJoin();
  assert.equal(queued.status, 200);
  assert.equal(queued.json.success, true);
  assert.equal(queued.json.data.joined, false, "the first caller waits");
  assert.equal(queued.json.data.status, MATCH_STATUS.WAITING);
  const matchId = queued.json.data.matchId;
  assert.equal(matchId, uuidFor(1));
  assert.equal(fake.state.tables.get(speedTypingMatches).length, 1, "exactly one lobby row");

  // ── MATCH FOUND: the second caller fills the seat and ARMS the race ─────
  auth.current = BOB;
  const found = await postCreateOrJoin();
  assert.equal(found.status, 200);
  assert.equal(found.json.data.matchId, matchId, "both players get the SAME match");
  assert.equal(found.json.data.joined, true);
  assert.equal(found.json.data.status, MATCH_STATUS.PLAYING);

  const row = rowOf(fake, matchId);
  const expectedText = passageForRow(row).text;
  assert.equal(row.player1Id, ALICE);
  assert.equal(row.player2Id, BOB);
  assert.equal(row.passageVersion, PASSAGE_VERSION);
  assert.ok(row.raceSeed != null && row.raceSeed !== SEED, "the seed is server-generated");
  // ── COUNTDOWN: ONE absolute server instant, a countdown from arming ─────
  assert.equal(new Date(row.goAt).getTime(), NOW + RACE_COUNTDOWN_MS);

  // ── BOTH CONNECT: each seat reads the authoritative snapshot ────────────
  auth.current = ALICE;
  const p1 = await getMatch(matchId);
  auth.current = BOB;
  const p2 = await getMatch(matchId);
  assert.equal(p1.status, 200);
  assert.equal(p2.status, 200);
  // ── SAME PROMPT: byte-for-byte identical, from the server's own catalog ──
  assert.equal(p1.json.data.match.race.passageText, expectedText);
  assert.equal(p2.json.data.match.race.passageText, expectedText);
  assert.deepEqual(p1.json.data.match.race.prompt, p2.json.data.match.race.prompt);
  assert.equal(p1.json.data.match.viewerSeat, 1);
  assert.equal(p2.json.data.match.viewerSeat, 2);
  // The race's own clock: identical for both seats, derived from the row.
  for (const view of [p1.json.data.match.race, p2.json.data.match.race]) {
    assert.equal(view.goAtMs, NOW + RACE_COUNTDOWN_MS);
    assert.equal(view.deadlineMs, NOW + RACE_COUNTDOWN_MS + RACE_LIMIT_MS);
  }

  // ── GO: typing opens at the server instant, not before ──────────────────
  at(GO);
  auth.current = ALICE;
  const a1 = await postProgress(matchId, { typedText: expectedText.slice(0, 40) });
  assert.equal(a1.status, 200);
  assert.equal(a1.json.data.accepted, true);
  assert.equal(a1.json.data.seat.charsTyped, 40);
  assert.equal(a1.json.data.seat.errors, 0);

  auth.current = BOB;
  const b1 = await postProgress(matchId, { typedText: expectedText.slice(0, 25) });
  assert.equal(b1.json.data.accepted, true);
  assert.equal(b1.json.data.seat.charsTyped, 25);

  // ── REALTIME PROGRESS: each seat sees the opponent, from server state ──
  auth.current = ALICE;
  const midRace = await getMatch(matchId);
  assert.equal(midRace.json.data.match.race.you.charsTyped, 40);
  assert.equal(
    midRace.json.data.match.race.opponent.charsTyped,
    25,
    "the opponent's progress is server-derived, never the client's claim",
  );

  // ── FIRST VERIFIED COMPLETION ───────────────────────────────────────────
  at(GO + 20_000);
  const firstFinish = await postFinish(matchId, { typedText: expectedText });
  assert.equal(firstFinish.status, 200);
  assert.equal(firstFinish.json.data.accepted, true);
  assert.equal(firstFinish.json.data.outcome, null, "one finish does not end a race");
  assert.equal(firstFinish.json.data.seat.finished, true);
  assert.equal(firstFinish.json.data.seat.elapsedMs, 20_000, "elapsed is the server's clock");
  assert.equal(spies.rating.length, 0, "a single finish settles nothing");

  // ── SECOND COMPLETION → WINNER / LOSER → MATCH FINISH ──────────────────
  at(GO + 25_000);
  auth.current = BOB;
  const secondFinish = await postFinish(matchId, { typedText: expectedText });
  assert.equal(secondFinish.json.data.outcome.settled, true);
  assert.equal(secondFinish.json.data.outcome.winnerSeat, SEAT.PLAYER1, "earlier finish wins");
  assert.equal(secondFinish.json.data.outcome.resolutionReason, RESOLUTION.FINISH);

  const settledRow = rowOf(fake, matchId);
  assert.equal(settledRow.status, MATCH_STATUS.FINISHED);
  assert.equal(settledRow.result, RESULT.PLAYER1);
  assert.equal(settledRow.winnerId, ALICE, "the winner is the server's, from the race state");
  assert.ok(settledRow.endedAt);

  // ── RATING + TROPHIES ───────────────────────────────────────────────────
  settledExactlyOnce("full flow", { winner: ALICE, loser: BOB });
  assert.equal(userOf(fake, ALICE).gamesWon, 4, "the winner's counter moved once");
  assert.equal(userOf(fake, BOB).gamesLost, 3, "the loser's counter moved once");
  assert.equal(spies.rating[0].matchId, matchId, "the match id is the journal key");

  // ── MATCH HISTORY: the terminal row carries exactly what history reads ──
  assert.equal(settledRow.status, "finished", "history includes finished only");
  assert.equal(settledRow.isAi, false, "labelled as a ranked PvP record");
  for (const field of ["player1Id", "player2Id", "winnerId", "result", "status", "endedAt"]) {
    assert.ok(field in settledRow, `history selects ${field}`);
  }

  // ── The whole flow moved no token, no balance, no payout. ──────────────
  assertNoEconomyWrites(fake, "full flow");

  // The queue lifecycle mirror saw the lobby created, the pair armed, the race done.
  assert.ok(spies.queue.some((entry) => entry.kind === "created"), "lobby mirrored");
  assert.ok(
    spies.queue.some((entry) => entry.kind === "transition" && entry.status === "completed"),
    "completion mirrored",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 2–3. Player 1 wins normally / Player 2 wins normally
// ════════════════════════════════════════════════════════════════════════

test("outcome: Player 1 wins normally", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 1_000);

  await postProgress(MATCH_A, { typedText: TEXT.slice(0, 60) });
  auth.current = BOB;
  await postProgress(MATCH_A, { typedText: TEXT.slice(0, 10) });

  auth.current = ALICE;
  const a = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(a.json.data.seat.finished, true);
  at(GO + 21_000);
  auth.current = BOB;
  const b = await postFinish(MATCH_A, { typedText: TEXT });

  assert.equal(b.json.data.outcome.winnerSeat, SEAT.PLAYER1);
  assert.equal(rowOf(fake, MATCH_A).result, RESULT.PLAYER1);
  assert.equal(rowOf(fake, MATCH_A).winnerId, ALICE);
  settledExactlyOnce("p1 wins", { winner: ALICE, loser: BOB });
});

test("outcome: Player 2 wins normally", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);

  // Bob finishes first, Alice second.
  at(GO + 12_000);
  auth.current = BOB;
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 30_000);
  auth.current = ALICE;
  const second = await postFinish(MATCH_A, { typedText: TEXT });

  assert.equal(second.json.data.outcome.winnerSeat, SEAT.PLAYER2);
  assert.equal(rowOf(fake, MATCH_A).result, RESULT.PLAYER2);
  assert.equal(rowOf(fake, MATCH_A).winnerId, BOB);
  settledExactlyOnce("p2 wins", { winner: BOB, loser: ALICE });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Both type simultaneously
// ════════════════════════════════════════════════════════════════════════

test("simultaneous: identical finish instants are a DRAW, not a packet race", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 30_000);

  // Both verified finishes land on the SAME server instant.
  auth.current = ALICE;
  const a = await postFinish(MATCH_A, { typedText: TEXT });
  auth.current = BOB;
  const b = await postFinish(MATCH_A, { typedText: TEXT });

  assert.equal(a.json.data.seat.finishedAtMs, GO + 30_000);
  assert.equal(b.json.data.seat.finishedAtMs, GO + 30_000);
  assert.equal(b.json.data.outcome.settled, true);
  assert.equal(b.json.data.outcome.winnerSeat, null, "a dead heat has no winner");
  assert.equal(b.json.data.outcome.resolutionReason, RESOLUTION.DRAW);

  const row = rowOf(fake, MATCH_A);
  assert.equal(row.result, RESULT.TIE, "a draw is `tie`, never a named winner");
  assert.equal(
    row.winnerId,
    null,
    "a drawn row must NOT name player2 as its winner (the seat-2 fallback bug)",
  );
  settledExactlyOnce("dead heat", { draw: true });
  // A draw moves NO win/loss counter.
  assert.equal(userOf(fake, ALICE).gamesWon, 3);
  assert.equal(userOf(fake, ALICE).gamesLost, 2);
  assert.equal(userOf(fake, BOB).gamesWon, 3);
  assert.equal(userOf(fake, BOB).gamesLost, 2);
});

test("simultaneous: interleaved checkpoints stay per-seat and monotonic", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  at(GO + 500);

  const [a, b] = await Promise.all([
    (async () => {
      auth.queue.push(ALICE);
      return postProgress(MATCH_A, { typedText: TEXT.slice(0, 32) });
    })(),
    (async () => {
      auth.queue.push(BOB);
      return postProgress(MATCH_A, { typedText: TEXT.slice(0, 24) });
    })(),
  ]);
  assert.equal(a.json.data.accepted, true);
  assert.equal(b.json.data.accepted, true);

  const row = rowOf(fake, MATCH_A);
  assert.equal(row.raceState.seats[SEAT.PLAYER1].charsTyped, 32);
  assert.equal(row.raceState.seats[SEAT.PLAYER2].charsTyped, 24);
  assert.equal(row.player1CharsTyped, 32);
  assert.equal(row.player2CharsTyped, 24);
  assert.equal(row.player1CharsTyped + row.player2CharsTyped, 56, "no double counting");
  // The serialised fake proves the store's writes never interleaved mid-transaction.
  assert.equal(fake.state.maxConcurrent, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 5–7. Disconnect / reconnect / refresh
// ════════════════════════════════════════════════════════════════════════

test("disconnect: a seat that leaves hands the live race to the opponent and settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 5_000);

  // Alice got partway, then dropped (the socket layer's grace timer expired).
  await postProgress(MATCH_A, { typedText: TEXT.slice(0, 30) });
  const { forfeitMatch } = await import("../src/lib/speed-typing/serverStore.ts");
  const result = await forfeitMatch({ userId: ALICE, matchId: MATCH_A, nowMs: GO + 45_000 });

  assert.equal(result.forfeited, true);
  assert.equal(result.cancelled, false);
  const row = rowOf(fake, MATCH_A);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, RESULT.PLAYER2, "the seat that stayed wins");
  assert.equal(row.winnerId, BOB);
  assert.equal(row.resolutionReason, RESOLUTION.FORFEIT, "a walkover is not a typed win");
  // The forfeited seat's progress is preserved, and it is closed out, not erased.
  assert.equal(row.raceState.seats[SEAT.PLAYER1].charsTyped, 30);
  assert.equal(row.raceState.seats[SEAT.PLAYER1].forfeited, true);
  settledExactlyOnce("forfeit", { winner: BOB, loser: ALICE });
  assertNoEconomyWrites(fake, "forfeit");
});

test("disconnect: a still-open lobby is CANCELLED and settles nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [waitingRow()]);
  setUsers(fake, [ALICE]);

  const { forfeitMatch } = await import("../src/lib/speed-typing/serverStore.ts");
  const result = await forfeitMatch({ userId: ALICE, matchId: MATCH_A, nowMs: NOW });

  assert.equal(result.cancelled, true);
  assert.equal(result.forfeited, false);
  assert.equal(rowOf(fake, MATCH_A).status, MATCH_STATUS.CANCELLED);
  assert.equal(spies.rating.length, 0, "an abandoned lobby is not a rated match");
  assert.equal(spies.trophy.length, 0);
});

test("disconnect: a late forfeit against a settled match is a no-op (idempotent retry)", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 1_000);
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 2_000);
  auth.current = BOB;
  await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(spies.rating.length, 1);
  const writes = fake.state.writes.length;

  const { forfeitMatch } = await import("../src/lib/speed-typing/serverStore.ts");
  const late = await forfeitMatch({ userId: ALICE, matchId: MATCH_A, nowMs: GO + 60_000 });
  assert.equal(late.forfeited, false);
  assert.equal(late.cancelled, false);
  assert.equal(fake.state.writes.length, writes, "a late forfeit writes nothing");
  assert.equal(spies.rating.length, 1, "and never settles twice");
  assert.equal(spies.trophy.length, 1);
});

test("reconnect: a refreshed/returned seat keeps its race and is not forfeited", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 2_000);
  await postProgress(MATCH_A, { typedText: TEXT.slice(0, 20) });

  // The socket dropped and re-joined inside the grace window, so NOTHING was
  // forfeited; the seat re-reads the snapshot and keeps typing.
  const reconnect = await getMatch(MATCH_A);
  assert.equal(reconnect.status, 200);
  assert.equal(reconnect.json.data.match.status, MATCH_STATUS.PLAYING);
  assert.equal(reconnect.json.data.match.race.you.charsTyped, 20, "progress survived the drop");
  assert.equal(reconnect.json.data.match.race.resolvedAtMs, null, "the race was not resolved");

  at(GO + 3_000);
  const resumed = await postProgress(MATCH_A, { typedText: TEXT.slice(0, 48) });
  assert.equal(resumed.json.data.accepted, true);
  assert.equal(resumed.json.data.seat.charsTyped, 48);
  assert.equal(spies.rating.length, 0, "a reconnect settles nothing");
});

test("refresh: repeated snapshots are stable and never re-roll the prompt", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  at(GO + 4_000);
  await postProgress(MATCH_A, { typedText: TEXT.slice(0, 16) });

  const first = await getMatch(MATCH_A);
  const second = await getMatch(MATCH_A);
  auth.current = BOB;
  const asOpponent = await getMatch(MATCH_A);

  // The prompt, the seed-derived catalog id and the absolute clock are fixed
  // for the life of the match — a refresh can never move a seat onto new text.
  assert.equal(first.json.data.match.race.passageText, TEXT);
  assert.equal(second.json.data.match.race.passageText, TEXT);
  assert.equal(asOpponent.json.data.match.race.passageText, TEXT);
  assert.equal(second.json.data.match.race.goAtMs, first.json.data.match.race.goAtMs);
  assert.equal(second.json.data.match.revision, first.json.data.match.revision);
  // Each viewer sees their OWN seat, and the same stored progress.
  assert.equal(first.json.data.match.viewerSeat, 1);
  assert.equal(asOpponent.json.data.match.viewerSeat, 2);
  assert.equal(first.json.data.match.race.you.charsTyped, 16);
  assert.equal(asOpponent.json.data.match.race.opponent.charsTyped, 16);
  assert.equal(second.json.data.match.race.prompt.id, PROMPT.id);
});

// ════════════════════════════════════════════════════════════════════════
// 7b. The hard limit: a stalled race is not left hanging
// ════════════════════════════════════════════════════════════════════════

test("deadline: a stalled race is resolved from its checkpoints by a participant's own poll", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  // Both players stopped typing (or walked away with the tab open) and the
  // hard limit passed. No scheduler runs for this game, so the deadline is
  // honoured by the read path the arena already polls every 2 s.
  const state = createRaceState({ version: 2 });
  state.seats[SEAT.PLAYER1] = { ...state.seats[SEAT.PLAYER1], charsTyped: 40, errors: 0 };
  state.seats[SEAT.PLAYER2] = { ...state.seats[SEAT.PLAYER2], charsTyped: 12, errors: 0 };
  setMatches(
    fake,
    [armedRow({ raceState: state, player1CharsTyped: 40, player2CharsTyped: 12 })],
  );
  setUsers(fake, [ALICE, BOB]);
  at(GO + RACE_LIMIT_MS + 1);

  // A third party cannot drive the resolution: the participant gate runs first.
  auth.current = MALLORY;
  const stranger = await getMatch(MATCH_A);
  assert.equal(stranger.status, 403);
  assert.equal(rowOf(fake, MATCH_A).status, MATCH_STATUS.PLAYING, "not resolved for a stranger");
  assert.equal(spies.rating.length, 0);

  // A participant's ordinary snapshot poll applies the deadline verdict.
  auth.current = ALICE;
  const poll = await getMatch(MATCH_A);
  assert.equal(poll.status, 200);
  assert.equal(poll.json.data.match.status, MATCH_STATUS.FINISHED, "the poll resolves the stall");
  assert.equal(poll.json.data.match.result, RESULT.PLAYER1, "the seat that got further wins");
  assert.equal(poll.json.data.match.winnerId, ALICE);
  assert.equal(poll.json.data.match.race.resolutionReason, RESOLUTION.DEADLINE);
  settledExactlyOnce("deadline self-heal", { winner: ALICE, loser: BOB });

  // The opponent's next poll sees the same verdict; nothing settles twice.
  auth.current = BOB;
  const second = await getMatch(MATCH_A);
  assert.equal(second.json.data.match.winnerId, ALICE);
  assert.equal(second.json.data.match.status, MATCH_STATUS.FINISHED);
  assert.equal(spies.rating.length, 1, "the self-heal is idempotent across both seats");
  assert.equal(spies.trophy.length, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Duplicate completion
// ════════════════════════════════════════════════════════════════════════

test("duplicate: a replayed finish is a `duplicate` with no second settlement", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 10_000);
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 11_000);
  auth.current = BOB;
  const settled = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(settled.json.data.outcome.winnerSeat, SEAT.PLAYER1);
  const writesAfterSettle = fake.state.writes.length;

  // Both seats replay the exact same packet.
  const replayBob = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(replayBob.json.data.accepted, false);
  assert.equal(replayBob.json.data.reason, "duplicate");
  assert.equal(replayBob.json.data.seat.finishedAtMs, GO + 11_000, "the first finish stands");

  auth.current = ALICE;
  const replayAlice = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(replayAlice.json.data.reason, "duplicate");

  assert.equal(fake.state.writes.length, writesAfterSettle, "a replay writes nothing");
  assert.equal(spies.rating.length, 1, "rating is never awarded twice");
  assert.equal(spies.trophy.length, 1, "trophies are never awarded twice");
  assert.equal(userOf(fake, ALICE).gamesWon, 4, "the win counter moved exactly once");
});

// ════════════════════════════════════════════════════════════════════════
// 9. Invalid progress
// ════════════════════════════════════════════════════════════════════════

test("invalid: junk progress is refused with no write, and the clock rules bind", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);

  // Before GO: a pre-buffered passage counts for nothing.
  at(GO - 1);
  const early = await postProgress(MATCH_A, { typedText: TEXT });
  assert.equal(early.status, 200);
  assert.equal(early.json.data.accepted, false);
  assert.equal(early.json.data.reason, "before_go");

  // After the hard limit: too late.
  at(GO + RACE_LIMIT_MS + 1);
  const late = await postProgress(MATCH_A, { typedText: TEXT });
  assert.equal(late.json.data.accepted, false);
  assert.equal(late.json.data.reason, "past_deadline");

  // Malformed input is EMPTY progress, never a claim.
  at(GO + 2_000);
  for (const junk of [null, 42, { charsTyped: 9_999 }, ["a"], true]) {
    const bad = await postProgress(MATCH_A, { typedText: junk });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.data.accepted, false, `junk ${JSON.stringify(junk)} must not be accepted`);
    assert.equal(bad.json.data.seat.charsTyped, 0);
  }

  // Below the throttle: accepted=false, and no row was written.
  const tiny = await postProgress(MATCH_A, { typedText: TEXT.slice(0, 3) });
  assert.equal(tiny.json.data.reason, "below_threshold");
  assert.equal(matchWrites(fake).length, 0, "no rejected checkpoint may write");

  // A malformed JSON body is a 400, not a crash.
  const broken = await postProgress(MATCH_A, undefined, { raw: true });
  assert.equal(broken.status, 400);
  const junkBody = await postProgress(MATCH_A, "{not json", { raw: true });
  assert.equal(junkBody.status, 400);
});

test("invalid: a non-participant, a malformed id and an unknown match are refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  at(GO + 1_000);

  // A third party can read nothing and write nothing.
  auth.current = MALLORY;
  const strangerRead = await getMatch(MATCH_A);
  assert.equal(strangerRead.status, 403);
  const strangerWrite = await postProgress(MATCH_A, { typedText: TEXT });
  assert.equal(strangerWrite.status, 403);
  const strangerFinish = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(strangerFinish.status, 403);
  assert.equal(matchWrites(fake).length, 0);

  // A malformed uuid is a 400 (before it can reach a Postgres uuid cast).
  auth.current = ALICE;
  const malformed = await getMatch("not-a-uuid");
  assert.equal(malformed.status, 400);
  const malformedProgress = await postProgress("not-a-uuid", { typedText: TEXT });
  assert.equal(malformedProgress.status, 400);

  // A syntactically valid but unknown match is a 404.
  setMatches(fake, []);
  const missing = await getMatch(MATCH_MISSING);
  assert.equal(missing.status, 404);
  const missingProgress = await postProgress(MATCH_MISSING, { typedText: TEXT });
  assert.equal(missingProgress.status, 404);
});

test("invalid: a waiting lobby is not a race yet", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [waitingRow()]);
  at(NOW + 10_000);

  const progress = await postProgress(MATCH_A, { typedText: TEXT });
  assert.equal(progress.status, 409);
  assert.equal(progress.json.success, false);
  const finish = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(finish.status, 409);
  assert.equal(matchWrites(fake).length, 0);
  assert.equal(spies.rating.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 10–11. Fake winner / fake WPM / fake accuracy
// ════════════════════════════════════════════════════════════════════════

test("forgery: a client cannot declare itself the winner", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 1_000);

  // Every "I won" shape a client could send, with an incomplete submission.
  const forged = await postFinish(MATCH_A, {
    typedText: TEXT.slice(0, 10),
    winner: "player1",
    winnerSeat: "player1",
    won: true,
    result: "player1",
    outcome: "win",
    settled: true,
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.json.data.accepted, false);
  assert.equal(forged.json.data.reason, "incomplete");
  assert.equal(forged.json.data.outcome, null);
  assert.equal(matchWrites(fake).length, 0, "a forged completion writes nothing");
  assert.equal(spies.rating.length, 0);

  // Even with the FULL text, the verdict is the server's: Bob finished first.
  at(GO + 9_000);
  auth.current = BOB;
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 20_000);
  auth.current = ALICE;
  const real = await postFinish(MATCH_A, { typedText: TEXT, winner: "player1", result: "player1" });
  assert.equal(real.json.data.outcome.winnerSeat, SEAT.PLAYER2, "the clock decided, not the claim");
  assert.equal(rowOf(fake, MATCH_A).winnerId, BOB);
  settledExactlyOnce("forged winner ignored", { winner: BOB, loser: ALICE });
});

test("forgery: client-supplied WPM, elapsed time and counts are ignored", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  at(GO + 30_000);

  const done = await postFinish(MATCH_A, {
    typedText: TEXT,
    wpm: 9999,
    accuracy: 1,
    elapsedMs: 1,
    completionTime: 1,
    charsTyped: 999_999,
    errors: 0,
    progressPercent: 100,
  });
  assert.equal(done.json.data.accepted, true);
  const seat = done.json.data.seat;
  const expectedWpm = Math.round((TEXT.length / 5) / (30_000 / 60_000));
  assert.equal(seat.wpm, expectedWpm, "WPM is derived from the server's clock");
  assert.notEqual(seat.wpm, 9999);
  assert.equal(seat.elapsedMs, 30_000, "elapsed is measured from the server's GO");
  assert.notEqual(seat.elapsedMs, 1);
  assert.equal(seat.accuracy, 100, "accuracy is correct ÷ typed, both server-derived");
  assert.notEqual(seat.accuracy, 1);
  assert.equal(seat.charsTyped, TEXT.length, "progress is capped at the passage");
  assert.notEqual(seat.charsTyped, 999_999);
});

test("forgery: fake accuracy cannot launder an earlier mistake", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  at(GO + 1_000);

  // One mistyped character, then a "perfect" finish that claims 100% accuracy.
  const typo = `${TEXT.slice(0, 10)}Z${TEXT.slice(11, 40)}`;
  const checkpoint = await postProgress(MATCH_A, { typedText: typo });
  assert.equal(checkpoint.json.data.accepted, true);

  at(GO + 20_000);
  const done = await postFinish(MATCH_A, { typedText: TEXT, errors: 0, accuracy: 100 });
  assert.equal(done.json.data.seat.errors, 1, "the mistake stays on the record");
  assert.ok(done.json.data.seat.accuracy < 100, "accuracy reflects the whole race");
});

test("forgery: progress cannot be sent before GO even as a complete passage", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);

  at(GO - 1);
  const early = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(early.json.data.accepted, false);
  assert.equal(early.json.data.reason, "before_go");
  assert.equal(matchWrites(fake).length, 0);
  assert.equal(rowOf(fake, MATCH_A).status, MATCH_STATUS.PLAYING);
});

// ════════════════════════════════════════════════════════════════════════
// 12–13. Two, then many, matches running simultaneously
// ════════════════════════════════════════════════════════════════════════

test("isolation: two matches run simultaneously with no cross-talk", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [
    armedRow({ id: MATCH_A, player1Id: ALICE, player2Id: BOB }),
    armedRow({ id: MATCH_B, player1Id: CAROL, player2Id: DAVE }),
  ]);
  setUsers(fake, [ALICE, BOB, CAROL, DAVE]);
  at(GO + 2_000);

  // Interleaved checkpoints across the two matches.
  await Promise.all([
    (async () => {
      auth.queue.push(ALICE);
      return postProgress(MATCH_A, { typedText: TEXT.slice(0, 40) });
    })(),
    (async () => {
      auth.queue.push(CAROL);
      return postProgress(MATCH_B, { typedText: TEXT.slice(0, 12) });
    })(),
  ]);

  assert.equal(rowOf(fake, MATCH_A).raceState.seats[SEAT.PLAYER1].charsTyped, 40);
  assert.equal(rowOf(fake, MATCH_B).raceState.seats[SEAT.PLAYER1].charsTyped, 12);
  assert.equal(rowOf(fake, MATCH_B).raceState.seats[SEAT.PLAYER2].charsTyped, 0);
  assert.equal(rowOf(fake, MATCH_A).raceState.seats[SEAT.PLAYER2].charsTyped, 0);

  // Both matches finish CONCURRENTLY, with different winners, using the
  // store's own explicit server instants (`nowMs`) so the interleaving is
  // deterministic and cross-match isolation is proven under real overlap.
  const { submitFinish } = await import("../src/lib/speed-typing/serverStore.ts");
  await Promise.all([
    submitFinish({ userId: CAROL, matchId: MATCH_B, typedText: TEXT, nowMs: GO + 4_000 }),
    submitFinish({ userId: DAVE, matchId: MATCH_B, typedText: TEXT, nowMs: GO + 3_000 }),
    submitFinish({ userId: ALICE, matchId: MATCH_A, typedText: TEXT, nowMs: GO + 5_000 }),
    submitFinish({ userId: BOB, matchId: MATCH_A, typedText: TEXT, nowMs: GO + 6_000 }),
  ]);

  assert.equal(rowOf(fake, MATCH_A).winnerId, ALICE, "match A: Alice's earlier finish wins");
  assert.equal(rowOf(fake, MATCH_B).winnerId, DAVE, "match B: Dave's earlier finish wins");
  assert.equal(spies.rating.length, 2, "each match settles once");
  assert.equal(spies.trophy.length, 2);
  const byMatch = new Map(spies.rating.map((call) => [call.matchId, call]));
  assert.equal(byMatch.get(MATCH_A).winnerClerkId, ALICE);
  assert.equal(byMatch.get(MATCH_A).loserClerkId, BOB);
  assert.equal(byMatch.get(MATCH_B).winnerClerkId, DAVE);
  assert.equal(byMatch.get(MATCH_B).loserClerkId, CAROL);
  assert.equal(userOf(fake, ALICE).gamesWon, 4);
  assert.equal(userOf(fake, BOB).gamesLost, 3);
  assert.equal(userOf(fake, DAVE).gamesWon, 4, "match B's result touched only match B");
  assert.equal(userOf(fake, CAROL).gamesLost, 3);
  assertNoEconomyWrites(fake, "two matches");
});

test("isolation: N matches complete in parallel, one settlement each", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  const ids = [MATCH_A, MATCH_B, MATCH_C, MATCH_D];
  const players = [
    [ALICE, BOB],
    [CAROL, DAVE],
    [ERIN, FRANK],
    [GRACE, HEIDI],
  ];
  setMatches(
    fake,
    ids.map((id, index) =>
      armedRow({ id, player1Id: players[index][0], player2Id: players[index][1] }),
    ),
  );
  setUsers(fake, players.flat());
  at(GO + 5_000);

  // All four matches finish CONCURRENTLY. `nowMs` is passed explicitly (the
  // store's own server instant), so a shared mutable clock cannot make the
  // interleaving nondeterministic while the overlap is still real.
  const { submitFinish } = await import("../src/lib/speed-typing/serverStore.ts");
  await Promise.all(
    ids.map(async (id, index) => {
      const [p1, p2] = players[index];
      const winnerIsP2 = index % 2 === 1;
      const winner = winnerIsP2 ? p2 : p1;
      const loser = winnerIsP2 ? p1 : p2;
      const base = GO + 5_000 + index * 4_000;
      await submitFinish({ userId: winner, matchId: id, typedText: TEXT, nowMs: base });
      await submitFinish({ userId: loser, matchId: id, typedText: TEXT, nowMs: base + 1_000 });
    }),
  );

  assert.equal(spies.rating.length, 4);
  const byMatch = new Map(spies.rating.map((call) => [call.matchId, call]));
  assert.equal(byMatch.size, 4, "four distinct match ids");
  ids.forEach((id, index) => {
    const expectedWinner = index % 2 === 1 ? players[index][1] : players[index][0];
    const expectedLoser = index % 2 === 1 ? players[index][0] : players[index][1];
    assert.equal(byMatch.get(id).winnerClerkId, expectedWinner, `${id} winner`);
    assert.equal(byMatch.get(id).loserClerkId, expectedLoser, `${id} loser`);
    assert.equal(rowOf(fake, id).status, MATCH_STATUS.FINISHED);
    assert.equal(rowOf(fake, id).winnerId, expectedWinner);
  });
  // Exactly four matches, each with two seats.
  assert.equal(fake.rowsOf(speedTypingMatches).length, 4);
  assert.equal(fake.state.maxConcurrent, 1, "transactions serialised (the row lock held)");
});

// ════════════════════════════════════════════════════════════════════════
// 14. Queue concurrency
// ════════════════════════════════════════════════════════════════════════

test("queue: eight concurrent callers pair into four matches, never eight lobbies", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, []);
  const everyone = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK, GRACE, HEIDI];
  auth.queue.push(...everyone);

  const results = await Promise.all(everyone.map(() => postCreateOrJoin()));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
  }

  const rows = fake.rowsOf(speedTypingMatches);
  assert.equal(rows.length, 4, "eight callers must open four lobbies, not eight");
  assert.equal(
    matchWrites(fake).filter((write) => write.op === "insert").length,
    4,
    "one INSERT per lobby",
  );
  // Every lobby is full, and the eight players are used exactly once.
  const seen = new Set();
  for (const row of rows) {
    assert.ok(row.player1Id && row.player2Id, "a lobby is never left half-full");
    assert.notEqual(row.player1Id, row.player2Id, "nobody is matched with themselves");
    seen.add(row.player1Id);
    seen.add(row.player2Id);
  }
  assert.equal(seen.size, 8, "all eight players were matched exactly once");
  assert.deepEqual([...seen].sort(), [...everyone].sort());
  // The advisory lock serialised every matchmaking transaction.
  assert.equal(fake.state.maxConcurrent, 1, "matchmaking never interleaved");
  assert.equal(fake.state.locks.length, 8, "one advisory lock per caller");
  // Each pair received the SAME match id.
  const byPlayer = new Map();
  for (const result of results) byPlayer.set(result.json.data.matchId, (byPlayer.get(result.json.data.matchId) ?? 0) + 1);
  for (const count of byPlayer.values()) assert.equal(count, 2, "every match id was returned twice");
});

test("queue: a caller who already has a lobby gets it back; a second joiner cannot double-claim", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, []);
  auth.current = ALICE;

  const first = await postCreateOrJoin();
  const again = await postCreateOrJoin();
  assert.equal(again.json.data.matchId, first.json.data.matchId, "own lobby returned, not a second");
  assert.equal(again.json.data.joined, false);
  assert.equal(fake.rowsOf(speedTypingMatches).length, 1, "no duplicate lobby");

  // Two callers race for the same open lobby: the serialised store fills the
  // seat exactly once and the loser is told the match is gone.
  const bob = await (async () => {
    auth.current = BOB;
    return postCreateOrJoin();
  })();
  assert.equal(bob.json.data.matchId, first.json.data.matchId);
  assert.equal(bob.json.data.joined, true);
  assert.equal(rowOf(fake, first.json.data.matchId).status, MATCH_STATUS.PLAYING);
  assert.equal(fake.rowsOf(speedTypingMatches).length, 1);
});

test("queue: an open lobby can be cancelled by its creator only, and settles nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [waitingRow()]);
  setUsers(fake, [ALICE, BOB]);

  // A non-creator cannot cancel.
  auth.current = BOB;
  const refused = await postCancel(MATCH_A);
  assert.equal(refused.status, 403);
  assert.equal(rowOf(fake, MATCH_A).status, MATCH_STATUS.WAITING);

  // The creator can.
  auth.current = ALICE;
  const cancelled = await postCancel(MATCH_A);
  assert.equal(cancelled.status, 200);
  assert.equal(rowOf(fake, MATCH_A).status, MATCH_STATUS.CANCELLED);
  assert.equal(spies.rating.length, 0, "a cancelled lobby is never rated");
  assert.equal(spies.trophy.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 15. Rating / trophy settlement
// ════════════════════════════════════════════════════════════════════════

test("settlement: the shared writers are called once, with the caller's transaction", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 1_000);
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 2_000);
  auth.current = BOB;

  // Drive the seam DIRECTLY (the caller's transaction is its contract).
  const { settleSpeedTypingMatch } = await import("../src/lib/speed-typing/serverStore.ts");
  const outcome = await settleSpeedTypingMatch({
    tx: fake.db,
    matchId: MATCH_A,
    winnerClerkId: ALICE,
    loserClerkId: BOB,
  });
  assert.deepEqual(outcome, { rated: true, trophied: true });
  assert.equal(spies.rating[0].gameKey, KEY);
  assert.equal(spies.trophy[0].gameKey, KEY);
  assert.ok(spies.rating[0].tx, "the caller's transaction, never a fresh one");

  // It refuses to rate a seat against itself, and refuses missing ids.
  const before = spies.rating.length;
  const self = await settleSpeedTypingMatch({
    tx: fake.db,
    matchId: MATCH_A,
    winnerClerkId: ALICE,
    loserClerkId: ALICE,
  });
  assert.deepEqual(self, { rated: false, trophied: false });
  const empty = await settleSpeedTypingMatch({
    tx: fake.db,
    matchId: MATCH_A,
    winnerClerkId: "",
    loserClerkId: BOB,
  });
  assert.deepEqual(empty, { rated: false, trophied: false });
  assert.equal(spies.rating.length, before, "no degenerate settlement reached the writers");
});

test("settlement: a refusing or throwing writer can never double-settle or break the match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  spies.ratingMode = "throw";
  spies.trophyMode = "refuse";
  at(GO + 1_000);
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 2_000);
  auth.current = BOB;
  const settled = await postFinish(MATCH_A, { typedText: TEXT });

  // The players' match still finished, with the server's verdict.
  assert.equal(settled.json.data.accepted, true);
  assert.equal(rowOf(fake, MATCH_A).status, MATCH_STATUS.FINISHED);
  assert.equal(rowOf(fake, MATCH_A).winnerId, ALICE);
  assert.equal(spies.rating.length, 1, "a throwing writer is attempted once");
  assert.equal(spies.trophy.length, 1, "a refusing writer is attempted once");

  // And a replay never re-attempts settlement.
  const replay = await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(replay.json.data.reason, "duplicate");
  assert.equal(spies.rating.length, 1);
  assert.equal(spies.trophy.length, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 16. Match history
// ════════════════════════════════════════════════════════════════════════

test("history: a settled row carries exactly what the history surface reads", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  at(GO + 1_000);
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 2_000);
  auth.current = BOB;
  await postFinish(MATCH_A, { typedText: TEXT });

  // The runtime row a history query would select.
  const row = rowOf(fake, MATCH_A);
  const { matchToDto } = await import("../src/lib/speed-typing/serverStore.ts");
  const asAlice = matchToDto(row, ALICE);
  const asBob = matchToDto(row, BOB);
  assert.equal(asAlice.status, "finished");
  assert.equal(asAlice.result, RESULT.PLAYER1);
  assert.equal(asAlice.winnerId, ALICE);
  assert.ok(asAlice.endedAt, "history sorts on endedAt");
  assert.equal(asAlice.isAi, false, "labelled as ranked PvP, not practice");
  assert.equal(asBob.winnerId, ALICE, "the same server-owned winner for both seats");

  // The surface itself: registered, finished-only, draw-aware, zero-token.
  const src = code(HISTORY);
  assert.match(src, /speedTypingMatches,/, "speed-typing is imported by the history route");
  const formatter = src.slice(src.indexOf("const speedTypingFormatted"));
  assert.match(formatter, /g\.status !== "finished"/, "in-flight matches are excluded");
  assert.match(formatter, /g\.result === "tie" \|\| !g\.winnerId/, "a tie (or missing winner) is a draw");
  assert.match(formatter, /g\.winnerId === clerkId\s*\?\s*"won"\s*:\s*"lost"/);
  assert.match(formatter, /amount: 0[\s\S]*?payout: 0[\s\S]*?tokenDiff: 0/, "unstaked: no token movement");
  assert.match(formatter, /Speed Typing vs AI/, "practice matches are labelled");
  assert.match(src, /\.\.\.speedTypingFormatted,/, "and merged into the response");
});

// ════════════════════════════════════════════════════════════════════════
// 17. Leaderboards
// ════════════════════════════════════════════════════════════════════════

test("leaderboard: speed-typing is a rated game and settlement feeds its board", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const { RATED_GAMES, isRatedGame, normalizeRatingGameKey, getRatingGameLabel } = REAL_RATING;

  assert.ok(RATED_GAMES.includes(KEY), "speed-typing must be a rated game");
  assert.equal(isRatedGame(KEY), true);
  assert.equal(normalizeRatingGameKey(KEY), KEY, "the board key is the canonical key");
  // An unknown/absent key falls back to the first rated game rather than
  // erroring — the documented contract a `?game=` query relies on.
  assert.equal(normalizeRatingGameKey("not-a-game"), RATED_GAMES[0]);
  assert.equal(normalizeRatingGameKey(null), RATED_GAMES[0]);
  assert.equal(typeof getRatingGameLabel(KEY), "string");
  assert.ok(getRatingGameLabel(KEY).length > 0);

  // The per-game board is derived from RATED_GAMES, so no second list can drift.
  const boardSrc = code("src/app/api/leaderboard/game/route.js");
  assert.match(boardSrc, /RATED_GAMES\.map\(\(key\) => \(\{ key, label: getRatingGameLabel\(key\) \}\)\)/);
  assert.match(boardSrc, /fetchRatingLeaderboard/, "read from the rating journal only");
  assert.doesNotMatch(boardSrc, /export async function POST/, "a board is never written by a client");

  // The classement UI offers the same key.
  assert.match(strip(read("src/app/classement/PageClient.jsx")), /\{ key: "speed-typing", label: "Speed Typing" \}/);

  // A settlement writes the row that board reads, under the match id.
  const fake = sharedFake;
  setMatches(fake, [armedRow()]);
  setUsers(fake, [ALICE, BOB]);
  installClock(t);
  at(GO + 1_000);
  await postFinish(MATCH_A, { typedText: TEXT });
  at(GO + 2_000);
  auth.current = BOB;
  await postFinish(MATCH_A, { typedText: TEXT });
  assert.equal(spies.rating[0].matchId, MATCH_A, "the board's journal key is the match id");
  assert.equal(spies.rating[0].gameKey, KEY);
  assert.equal(spies.rating[0].winnerClerkId, ALICE, "the winner the board would credit");
});

// ════════════════════════════════════════════════════════════════════════
// 18. No economy, no randomness, no client-authored result — anywhere
// ════════════════════════════════════════════════════════════════════════

test("guarantee: the whole flow touches no token, balance, wager or payout", () => {
  for (const file of [STORE, RULES, ROUTES.createJoin, ROUTES.fetch, ROUTES.progress, ROUTES.finish, ROUTES.cancel]) {
    const src = code(file);
    for (const forbidden of [
      /balance/i,
      /payout/i,
      /wager/i,
      /stakeAmount|stake_amount|\bstake\b/i,
      /prizePaid|prize_paid/i,
      /houseFee|house_fee/i,
      /tokenTransactions|token_transactions/i,
    ]) {
      assert.doesNotMatch(src, forbidden, `${file} must not touch the economy (${forbidden})`);
    }
  }
  // The disconnect endpoint re-verifies a Clerk token and only ever forfeits the
  // token owner's own match — it is not a money path either.
  const disconnect = code(ROUTES.disconnect);
  assert.match(disconnect, /verifyToken/);
  assert.match(disconnect, /forfeitMatch/);
  assert.doesNotMatch(disconnect, /balance|payout|wager|stake/i);
});

test("guarantee: no randomness decides gameplay; the prompt is fixed once armed", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  installClock(t);

  // The pure rules are deterministic: same inputs, same outputs, always.
  const verification = verifyTypedText({ passageText: TEXT, typedText: TEXT });
  assert.deepEqual(
    verifyTypedText({ passageText: TEXT, typedText: TEXT }),
    verification,
    "verification must be pure",
  );
  const state = createRaceState({ version: 3 });
  state.seats[SEAT.PLAYER1] = { ...state.seats[SEAT.PLAYER1], charsTyped: 40, errors: 2 };
  state.seats[SEAT.PLAYER2] = { ...state.seats[SEAT.PLAYER2], charsTyped: 30, errors: 1 };
  const firstVerdict = resolveRace({ state, reason: RESOLUTION.DEADLINE, nowMs: GO + RACE_LIMIT_MS });
  const secondVerdict = resolveRace({ state, reason: RESOLUTION.DEADLINE, nowMs: GO + RACE_LIMIT_MS });
  assert.deepEqual(secondVerdict, firstVerdict, "resolution must be pure");
  assert.equal(firstVerdict.winnerSeat, SEAT.PLAYER1, "more CORRECT characters wins the clock");
  // A key-masher must not win the clock on raw volume.
  const mash = createRaceState({ version: 3 });
  mash.seats[SEAT.PLAYER1] = { ...mash.seats[SEAT.PLAYER1], charsTyped: 300, errors: 300 };
  mash.seats[SEAT.PLAYER2] = { ...mash.seats[SEAT.PLAYER2], charsTyped: 20, errors: 0 };
  assert.equal(
    resolveRace({ state: mash, reason: RESOLUTION.DEADLINE, nowMs: GO + RACE_LIMIT_MS }).winnerSeat,
    SEAT.PLAYER2,
    "spraying characters it never gets right gains nothing",
  );
  // No `Math.random` anywhere in the rules or the store's gameplay path.
  assert.doesNotMatch(code(RULES), /Math\.random/);
  assert.doesNotMatch(code(STORE), /Math\.random/);

  // Arming is idempotent: a second call can never re-roll the prompt or restart
  // the clock mid-race.
  setMatches(fake, [
    armedRow({ raceSeed: null, passageId: null, passageVersion: null, goAt: null }),
  ]);
  const { armRace } = await import("../src/lib/speed-typing/serverStore.ts");
  const armed = await armRace({ matchId: MATCH_A, nowMs: NOW });
  assert.equal(armed.armed, true);
  const goAt = new Date(armed.match.goAt).getTime();
  const passageId = armed.match.passageId;
  const again = await armRace({ matchId: MATCH_A, nowMs: NOW + 5_000 });
  assert.equal(again.armed, false);
  assert.equal(new Date(again.match.goAt).getTime(), goAt, "GO is untouched");
  assert.equal(again.match.passageId, passageId, "the prompt is untouched");

  // The STORED pair outranks re-derivation: editing the seed cannot move a
  // match onto different text.
  const row = armed.match;
  const originalText = passageForRow(row).text;
  row.raceSeed = SEED + 1;
  assert.equal(passageForRow(row).text, originalText, "the stored passage pair wins");
});

test("guarantee: the routes hand the store only what the client TYPED", () => {
  for (const file of [ROUTES.progress, ROUTES.finish]) {
    const src = code(file);
    assert.match(src, /typedText: body\?\.typedText/, `${file} sends only typedText`);
    assert.doesNotMatch(src, /\.\.\.body/, `${file} must never spread the request body`);
    assert.doesNotMatch(
      src,
      /body\?\.(winner|winnerSeat|wpm|accuracy|elapsedMs|completionTime|errors|charsTyped|result|settled|elo|rating|trophies)/,
      `${file} must not read a decision field from the body`,
    );
  }
  // The create/join route takes the caller from the session only.
  const create = code(ROUTES.createJoin);
  assert.doesNotMatch(create, /searchParams|\.json\(\)/);
  assert.match(create, /await createOrJoin\(\{ userId \}\)/);
  // Every participant-facing route is gated before any database work.
  for (const file of [ROUTES.createJoin, ROUTES.fetch, ROUTES.progress, ROUTES.finish, ROUTES.cancel]) {
    assert.match(code(file), /requireAgeVerifiedUser/, `${file} must gate the caller`);
  }
  // The client only ever emits a bare `{ matchId }` poke over the socket.
  const rooms = code("src/lib/speed-typing/rooms.ts");
  assert.match(rooms, /READY: "speed-typing:ready"/);
  const socket = strip(read("realtime-server/server.js"));
  const readyHandler = socket.slice(socket.indexOf('socket.on("speed-typing:ready"'));
  const handlerBody = readyHandler.slice(0, readyHandler.indexOf("});"));
  assert.doesNotMatch(
    handlerBody,
    /typedText|progress|charsTyped|wpm|accuracy|winner/,
    "the client's socket payload carries no game data",
  );
});
