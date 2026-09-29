/**
 * speed-typing-security.test.mjs
 *
 * COMPETITIVE-INTEGRITY / SECURITY pass. Every client → server path, attacked.
 *
 * ── WHY THIS FILE IS DIFFERENT ──────────────────────────────────────────
 *
 * The other Speed Typing suites assert the store (behaviourally) and the
 * wiring (statically). This one attacks the ACTUAL HTTP HANDLERS with hostile
 * payloads and asserts what the server does with them. Only three things are
 * faked:
 *
 *   * the age/auth gate  — so a request can be issued AS a chosen identity,
 *   * the database       — an in-memory fake, as in the other suites,
 *   * the shared progression writers — spied on, never implemented here.
 *
 * The ROUTES and the STORE are the real production modules. So an assertion
 * like "forging `wpm` changes nothing" is a statement about the shipped code
 * path, not about a regex.
 *
 * ── THE TRUST MODEL UNDER ATTACK ────────────────────────────────────────
 *
 *   A CLIENT MAY ONLY EVER SAY WHAT IT TYPED.
 *
 * Everything else — the passage, the cursor position, the error count, the
 * elapsed time, WPM, accuracy, completion, the winner, the rating, the
 * trophies — is derived by the server from the row it locked and its own clock.
 * A request body is a HINT about typed text and nothing more: any other field
 * is not "validated", it is IGNORED, because no code path reads it.
 *
 * ── THE COMPLETE SURFACE (asserted, so a new path cannot appear silently) ─
 *
 *   POST /api/speed-typing/create-or-join                 (no body)
 *   GET  /api/speed-typing/match/[matchId]
 *   POST /api/speed-typing/match/[matchId]/progress       { typedText }
 *   POST /api/speed-typing/match/[matchId]/finish         { typedText }
 *   POST /api/speed-typing/match/[matchId]/cancel         (no body)
 *   POST /api/speed-typing/disconnect-forfeit             { matchId, token }
 *   socket: join_room / leave_room / speed-typing:ready   { matchId }
 *
 * Run:  npm run test:speed-typing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { speedTypingMatches, users } from "../src/db/schema.ts";
import {
  MATCH_STATUS,
  RACE_COUNTDOWN_MS,
  RACE_LIMIT_MS,
  RESOLUTION,
  RESULT,
  SEAT,
} from "../src/lib/speed-typing/constants.ts";
import { createRaceState, normalizeTypedText } from "../src/lib/speed-typing/rules.ts";
import {
  ENABLED_PASSAGES,
  PASSAGE_VERSION,
  selectPassageForSeed,
} from "../src/lib/speed-typing/passages.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:speed-typing";

const MATCH_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_MATCH_ID = "88888888-8888-4888-8888-888888888888";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const GO = 1_700_000_000_000;

const SEED = 20240929;
const PROMPT = selectPassageForSeed({ seed: SEED });
const TEXT = PROMPT.text;
assert.ok(TEXT.length > 20, "the seeded prompt must be a real passage");

const R = {
  createOrJoin: "src/app/api/speed-typing/create-or-join/route.ts",
  match: "src/app/api/speed-typing/match/[matchId]/route.ts",
  progress: "src/app/api/speed-typing/match/[matchId]/progress/route.ts",
  finish: "src/app/api/speed-typing/match/[matchId]/finish/route.ts",
  cancel: "src/app/api/speed-typing/match/[matchId]/cancel/route.ts",
  disconnect: "src/app/api/speed-typing/disconnect-forfeit/route.ts",
};

// ── The fake database (WHERE-narrowed, serialised transactions) ────────────

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    writes: [],
    inFlight: 0,
    maxConcurrent: 0,
    locks: [],
  };

  const rowsOf = (table) => {
    if (!state.tables.has(table)) state.tables.set(table, []);
    return state.tables.get(table);
  };

  const INCREMENT_KEYS = new Set(["revision", "gamesWon", "gamesLost"]);

  /** Literal params inside a Drizzle condition, so a WHERE can be honoured. */
  function conditionValues(clause, depth = 0) {
    if (!clause || depth > 6) return [];
    if (Array.isArray(clause)) return clause.flatMap((c) => conditionValues(c, depth + 1));
    if (typeof clause !== "object") return [];
    if (Array.isArray(clause.queryChunks)) {
      return clause.queryChunks.flatMap((c) => conditionValues(c, depth + 1));
    }
    const value = clause.value;
    if (typeof value === "string" || typeof value === "number") return [value];
    return [];
  }

  /**
   * The rows visible to one statement.
   *
   * This suite must be able to prove the ID ORACLES — that a well-formed but
   * unknown match id is a 404, that a non-participant is a 403 — which a
   * WHERE-ignoring fake cannot express (every read would return "the row").
   * Narrowing by the condition's own literal params makes "the row this query
   * names" real. A condition whose params cannot be extracted (e.g. `isNull`)
   * yields no narrowing, which is exactly the harness's documented behaviour.
   */
  function visibleRows(table, clause) {
    const rows = rowsOf(table);
    const wanted = clause ? conditionValues(clause) : [];
    if (wanted.length === 0) return rows;
    return rows.filter((row) => Object.values(row).some((v) => wanted.includes(v)));
  }

  const select = () => {
    let table = null;
    let clause = null;
    const q = {
      from(t) {
        table = t;
        return q;
      },
      where(c) {
        clause = c;
        return q;
      },
      for: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve, reject) =>
        Promise.resolve(visibleRows(table, clause).map((row) => ({ ...row }))).then(
          resolve,
          reject,
        ),
    };
    return q;
  };

  const update = (table) => {
    let values = null;
    let targets = null;
    const b = {
      set(v) {
        values = v;
        return b;
      },
      where(clause) {
        targets = visibleRows(table, clause);
        return b;
      },
      returning: () => {
        state.writes.push({ table, op: "update", values });
        for (const row of targets ?? rowsOf(table)) {
          for (const [key, value] of Object.entries(values)) {
            const isIncrement =
              INCREMENT_KEYS.has(key) &&
              value &&
              typeof value === "object" &&
              !(value instanceof Date);
            row[key] = isIncrement ? (Number(row[key]) || 0) + 1 : value;
          }
        }
        return Promise.resolve(rowsOf(table).map((row) => ({ ...row })));
      },
      then: (resolve, reject) => b.returning().then(resolve, reject),
    };
    return b;
  };

  const insert = (table) => ({
    values: (v) => ({
      returning: () => {
        const row = {
          id: "11111111-1111-4111-8111-111111111111",
          revision: 0,
          createdAt: new Date(GO - 10_000),
          ...v,
        };
        state.writes.push({ table, op: "insert", values: v });
        rowsOf(table).push(row);
        return Promise.resolve([{ ...row }]);
      },
    }),
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
    state.inFlight = 0;
    state.maxConcurrent = 0;
    state.locks = [];
    chain = Promise.resolve();
  };

  return { state, reset, rowsOf, tx, db: { transaction, select, update, insert } };
}

// ── Mutable attack surface, shared across tests ────────────────────────────

/** WHO the request is issued as. The routes must never read an id from a body. */
const session = { userId: ALICE, gate: "ok" };
/** Whether CLERK_SECRET_KEY is set, for the socket endpoint's own gate. */
const clerk = { configured: true };
/** Every shared progression writer call. */
const writers = { rating: [], trophy: [], queue: [] };
/** Every broadcast the routes attempted. */
const broadcasts = [];
/** Frozen wall clock for the routes that stamp their own now. */
const clock = { now: GO + 20_000 };

let sharedFake = null;

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  session.userId = ALICE;
  session.gate = "ok";
  clerk.configured = true;
  writers.rating.length = 0;
  writers.trophy.length = 0;
  writers.queue.length = 0;
  broadcasts.length = 0;
  clock.now = GO + 20_000;

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });

  // The socket-authenticated endpoint needs a configured secret before it will
  // even attempt token verification (it fails closed without one).
  const previousSecret = process.env.CLERK_SECRET_KEY;
  if (clerk.configured) process.env.CLERK_SECRET_KEY = "sk_test_security_suite";
  else delete process.env.CLERK_SECRET_KEY;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = previousSecret;
  });

  // The gate is the ONE thing a request cannot choose for itself — it is
  // mocked to a known identity so the attacker's choices are visible.
  t.mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: {
      requireAgeVerifiedUser: async () => {
        if (session.gate === "signed-out") return { response: null, userId: null };
        if (session.gate === "blocked") {
          return {
            response: Response.json(
              { success: false, error: "Age verification required" },
              { status: 403 },
            ),
            userId: null,
          };
        }
        return { response: null, userId: session.userId };
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
  // NOTE: `@clerk/backend` is deliberately NOT mocked. Node's module-mocking
  // registry does not intercept how tsx loads that package, and inventing a
  // second (fake) token verifier would test the test rather than the product.
  // The disconnect endpoint's authorized branch therefore ends at Clerk's real
  // verification — which is the point of the endpoint — and everything this
  // suite asserts about it is either a refusal it performs itself or a property
  // of the shared store, which IS driven for real.

  // Capture every broadcast, so a leak can be asserted on the wire too.
  const previousIo = globalThis.io;
  globalThis.io = {
    to: (room) => ({
      emit: (event, payload) => {
        broadcasts.push({ room, event, payload });
      },
    }),
  };
  t.after(() => {
    globalThis.io = previousIo;
  });

  // Freeze the wall clock for the routes that stamp their own instants.
  const realNow = Date.now;
  Date.now = () => clock.now;
  t.after(() => {
    Date.now = realNow;
  });

  return fake;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function armedRow(overrides = {}) {
  return {
    id: MATCH_ID,
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
    startedAt: new Date(GO - RACE_COUNTDOWN_MS),
    endedAt: null,
    createdAt: new Date(GO - 10_000),
    updatedAt: new Date(GO - 10_000),
    ...overrides,
  };
}

function seed(fake, row) {
  fake.state.tables.set(speedTypingMatches, [row]);
  fake.state.tables.set(users, [
    { id: 1, clerkId: ALICE, gamesWon: 3, gamesLost: 2 },
    { id: 2, clerkId: BOB, gamesWon: 3, gamesLost: 2 },
    { id: 3, clerkId: MALLORY, gamesWon: 0, gamesLost: 0 },
  ]);
  return row;
}

const rowOf = (fake) => fake.state.tables.get(speedTypingMatches)[0];

// ── Request helpers: the REAL route handlers ──────────────────────────────

async function post(path, body, { matchId = MATCH_ID, raw = false } = {}) {
  const mod = await import(`../${path}`);
  const url = `http://speedtyping.test/${path.replace(/\[matchId\]/g, matchId)}`;
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }),
  });
  const res = await mod.POST(req, { params: Promise.resolve({ matchId }) });
  return { status: res.status, json: await res.json() };
}

async function get(path, { matchId = MATCH_ID } = {}) {
  const mod = await import(`../${path}`);
  const url = `http://speedtyping.test/${path.replace(/\[matchId\]/g, matchId)}`;
  const res = await mod.GET(new Request(url), { params: Promise.resolve({ matchId }) });
  return { status: res.status, json: await res.json() };
}

const progress = (body, opts) => post(R.progress, body, opts);
const finish = (body, opts) => post(R.finish, body, opts);

/** A verified finish for `seat` at a chosen server instant. */
async function completeAs(who, atMs) {
  clock.now = atMs;
  session.userId = who;
  return await finish({ typedText: TEXT });
}

// ════════════════════════════════════════════════════════════════════════
// 0. The surface itself
// ════════════════════════════════════════════════════════════════════════

test("surface: the client→server path list is exactly the audited one", () => {
  const root = "src/app/api/speed-typing";
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "route.ts") found.push(join(dir, entry.name).replace(/\\/g, "/"));
    }
  };
  walk(root);
  assert.deepEqual(found.sort(), Object.values(R).sort());

  // Every one of them is session-gated before any database work, except the
  // internal socket endpoint, which verifies its own Clerk token instead.
  for (const [name, path] of Object.entries(R)) {
    const src = readFileSync(path, "utf8");
    if (name === "disconnect") {
      assert.match(src, /verifyToken\(/, `${name} must verify its own token`);
      continue;
    }
    assert.match(src, /requireAgeVerifiedUser\(\)/, `${name} must be session-gated`);
  }

  // No route anywhere accepts a decision-shaped field off a body.
  for (const path of Object.values(R)) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(
      src,
      /body\??\.(wpm|accuracy|winner|winnerId|result|rating|trophies|elo|delta|elapsedMs|finishedAtMs|charsTyped|progress|score|settle)\b/,
      `${path} must not read a client-supplied result field`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// 1. "I am 100% done" (progress ≠ completion)
// ════════════════════════════════════════════════════════════════════════

test("attack: submitting 100% progress immediately never completes the race", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  clock.now = GO + 1_000;
  const res = await progress({
    typedText: TEXT,
    progress: 100,
    progressPercent: 100,
    charsTyped: TEXT.length,
    completed: true,
    finished: true,
    done: true,
  });

  assert.equal(res.status, 200);
  // The progress route records a CURSOR POSITION. It can never set the
  // completion bit — that requires a verified /finish, which is a different
  // endpoint with a different decision.
  assert.equal(rowOf(fake).player1CompletedAt, null, "no completion was recorded");
  assert.equal(rowOf(fake).raceState.seats.player1.finished, false, "the seat is still racing");
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING, "the race is still live");
  assert.equal(writers.rating.length, 0, "nothing settled");
  assert.equal(writers.trophy.length, 0);
  assert.equal(rowOf(fake).player1CharsTyped, TEXT.length, "progress IS recorded — capped at the text");
});

// ════════════════════════════════════════════════════════════════════════
// 2-4, 14. Forged numbers and impossible values
// ════════════════════════════════════════════════════════════════════════

test("attack: forged timestamps, WPM and accuracy are all derived server-side", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  // Bank one real mistake first, so a forged 100% accuracy is falsifiable.
  clock.now = GO + 1_000;
  await progress({ typedText: `${TEXT.slice(0, 5)}Z${TEXT.slice(6, 30)}` });

  clock.now = GO + 30_000;
  const forged = await finish({
    typedText: TEXT,
    finishedAtMs: GO - 999_999,
    completedAt: GO - 999_999,
    timestamp: GO - 999_999,
    elapsedMs: 1,
    durationMs: 1,
    wpm: 9_999,
    accuracy: 100,
    correctChars: TEXT.length,
    errors: 0,
    score: 9_999,
    rating: 5_000,
    trophies: 9_999,
    result: "player1",
    winner: "player1",
    winnerId: ALICE,
    settle: true,
    version: 999,
    revision: 999,
    expectedVersion: 999,
  });

  assert.equal(forged.status, 200);
  const seat = rowOf(fake).raceState.seats.player1;
  // The instant is the SERVER's clock, not the one the body asked for.
  assert.equal(seat.finishedAtMs, GO + 30_000);
  assert.equal(seat.elapsedMs, 30_000, "elapsed is measured from the server's GO");
  assert.notEqual(seat.elapsedMs, 1);
  // Accuracy reflects the whole attempt: the earlier mistake is still on record.
  assert.ok(seat.accuracy < 100, "a forged 100% cannot launder an error");
  assert.equal(seat.errors, 1);
  // WPM is the server's derivation, never the body's.
  assert.equal(seat.wpm, Math.round((TEXT.length - 1) / 5 / 0.5));
  assert.notEqual(seat.wpm, 9_999);
  // A single finish settles NOTHING, whatever the body claimed.
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
  assert.equal(rowOf(fake).winnerId, null);
  // The race state's version is the STORE's monotonic counter — a forged
  // `version`/`expectedVersion` is not a version gate and cannot rewind it.
  assert.equal(rowOf(fake).raceState.version, 3, "1 (arm) + checkpoint + finish");
  assert.notEqual(rowOf(fake).raceState.version, 999);
});

test("attack: impossible progress is clamped to the passage, never accepted as an assertion", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 5_000;

  // Overlong text: the cursor cannot pass the end of the prompt.
  const overlong = await progress({
    typedText: TEXT + "MORE TEXT THAT WAS NEVER IN THE PASSAGE".repeat(200),
    charsTyped: 5_000_000,
    progressPercent: 100,
  });
  assert.equal(overlong.status, 200);
  assert.equal(rowOf(fake).player1CharsTyped, TEXT.length, "capped at the passage length");

  // Absurd / non-finite numbers in the body are simply not read.
  seed(fake, armedRow());
  clock.now = GO + 5_000;
  await progress({
    typedText: TEXT.slice(0, 10),
    charsTyped: 5_000_000,
    progress: Number.POSITIVE_INFINITY,
    progressPercent: Number.NaN,
    errors: -50,
    accuracy: Number.POSITIVE_INFINITY,
  });
  assert.equal(rowOf(fake).player1CharsTyped, 10, "the verified span, not the claim");
  assert.equal(rowOf(fake).player1Errors, 0);

  // Negative and backwards claims cannot rewind a monotonic counter.
  seed(fake, armedRow());
  clock.now = GO + 5_000;
  await progress({ typedText: TEXT.slice(0, 40) });
  clock.now = GO + 6_000;
  await progress({ typedText: TEXT.slice(0, 5), charsTyped: -1, progress: -1 });
  assert.equal(rowOf(fake).player1CharsTyped, 40, "progress never moves backwards");
  assert.equal(
    rowOf(fake).raceState.seats.player1.errors,
    0,
    "and a shorter resubmission cannot launder an error",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 5. Another player's identity
// ════════════════════════════════════════════════════════════════════════

test("attack: a body cannot choose its identity or its seat", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 5_000;

  // Alice legitimately sends, but claims to BE Bob and to own his seat.
  const res = await progress({
    typedText: TEXT.slice(0, 30),
    userId: BOB,
    user_id: BOB,
    playerId: BOB,
    clerkId: BOB,
    seat: "player2",
    seatKey: "player2",
    seatNumber: 2,
    viewerId: BOB,
    player: BOB,
    opponentId: ALICE,
  });

  assert.equal(res.status, 200);
  // The write lands on ALICE's seat — the verified session — and Bob is untouched.
  assert.equal(rowOf(fake).player1CharsTyped, 30);
  assert.equal(rowOf(fake).player2CharsTyped, 0);
  assert.equal(rowOf(fake).raceState.seats.player2.charsTyped, 0);
  assert.equal(rowOf(fake).raceState.seats.player2.finished, false);
  assert.equal(rowOf(fake).player2CompletedAt, null);
  assert.equal(res.json.data.seat.seat, undefined);
  assert.equal(res.json.data.seat.finished, false);
});

test("attack: a non-participant cannot read, write, finish or forfeit a match", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 5_000;

  session.userId = MALLORY;
  assert.equal((await get(R.match)).status, 403);
  assert.equal((await progress({ typedText: TEXT })).status, 403);
  assert.equal((await finish({ typedText: TEXT })).status, 403);
  assert.equal((await post(R.cancel, {})).status, 403, "only the creator may cancel");

  // A stranger cannot name themselves as a participant: the socket endpoint
  // takes its identity from the VERIFIED token, so a cookie/session that does
  // not own a seat is simply not a participant — and a token they cannot mint
  // is refused outright rather than trusted.
  const forgedForfeit = await post(R.disconnect, { matchId: MATCH_ID, token: "tok" });
  assert.equal(forgedForfeit.status, 401, "a token for someone else cannot be forged");
  assert.equal(forgedForfeit.json.success, false);

  // The store is the authority for the identity rule, and it is asserted
  // behaviorally in speed-typing-settlement.test.mjs (403, zero writes).
  const { forfeitMatch } = await import("../src/lib/speed-typing/serverStore.ts");
  const storeRefusal = await forfeitMatch({ userId: MALLORY, matchId: MATCH_ID });
  assert.equal(storeRefusal.status, 403);

  assert.equal(fake.state.writes.length, 0, "not one row was written");
  assert.equal(writers.rating.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
  assert.equal(rowOf(fake).winnerId, null);
});

test("attack: a signed-out or age-blocked caller is refused before any work", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  session.gate = "signed-out";
  assert.equal((await get(R.match)).status, 401);
  assert.equal((await progress({ typedText: TEXT })).status, 401);
  assert.equal((await finish({ typedText: TEXT })).status, 401);

  session.gate = "blocked";
  assert.equal((await get(R.match)).status, 403);
  assert.equal((await progress({ typedText: TEXT })).status, 403);
  assert.equal((await finish({ typedText: TEXT })).status, 403);

  assert.equal(fake.state.writes.length, 0);
  assert.equal(fake.state.transactions, 0, "the gate runs before any transaction");
});

// ════════════════════════════════════════════════════════════════════════
// 6. Progress after finishing
// ════════════════════════════════════════════════════════════════════════

test("attack: progress after finishing is refused, and cannot rewind or re-settle", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  await completeAs(ALICE, GO + 10_000);
  const frozen = rowOf(fake).raceState.seats.player1;
  const writesAfterFinish = fake.state.writes.length;

  // The seat's own race is closed even though the match is still live.
  clock.now = GO + 11_000;
  const after = await progress({ typedText: TEXT, charsTyped: 0, progress: 0 });
  assert.equal(after.status, 200);
  assert.equal(after.json.data.accepted, false);
  assert.equal(after.json.data.reason, "seat_closed");

  // Shorter, longer, empty — none of it moves anything.
  assert.equal((await progress({ typedText: TEXT.slice(0, 5) })).json.data.accepted, false);
  assert.equal((await progress({ typedText: "" })).json.data.accepted, false);

  assert.equal(fake.state.writes.length, writesAfterFinish, "not one write after finishing");
  const still = rowOf(fake).raceState.seats.player1;
  assert.equal(still.finishedAtMs, frozen.finishedAtMs, "the frozen instant stands");
  assert.equal(still.charsTyped, TEXT.length);
  assert.equal(writers.rating.length, 0, "one finish still settles nothing");
});

// ════════════════════════════════════════════════════════════════════════
// 7. Another match
// ════════════════════════════════════════════════════════════════════════

test("attack: the URL's match id is the only match id, and it is validated", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 5_000;

  // A body-supplied matchId must never redirect the write.
  const bodySwap = await progress({
    typedText: TEXT.slice(0, 30),
    matchId: OTHER_MATCH_ID,
    id: OTHER_MATCH_ID,
  });
  assert.equal(bodySwap.status, 200);
  assert.equal(rowOf(fake).player1CharsTyped, 30, "the URL's match received the checkpoint");

  // Not a uuid → 400 before the driver ever sees it.
  for (const bad of ["", "not-a-uuid", "../../etc/passwd", "1 OR 1=1", "%00", "a".repeat(200)]) {
    assert.equal((await progress({ typedText: TEXT }, { matchId: bad })).status, 400, `progress ${bad}`);
    assert.equal((await finish({ typedText: TEXT }, { matchId: bad })).status, 400, `finish ${bad}`);
  }

  // A well-formed uuid nobody can see → 404 (no existence oracle beyond id
  // possession, and a non-participant gets 403 rather than 404).
  const ghost = await progress({ typedText: TEXT }, { matchId: OTHER_MATCH_ID });
  assert.equal(ghost.status, 404);
});

// ════════════════════════════════════════════════════════════════════════
// 8, 10. Repeated and simultaneous completions
// ════════════════════════════════════════════════════════════════════════

test("attack: hammering completion settles exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  await completeAs(ALICE, GO + 20_000);
  await completeAs(BOB, GO + 25_000);
  const writesAfterSettle = fake.state.writes.length;

  for (let i = 0; i < 25; i += 1) {
    clock.now = GO + 30_000 + i;
    session.userId = i % 2 === 0 ? BOB : ALICE;
    const replay = await finish({ typedText: TEXT, winner: "player2", wpm: 9_999 });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.accepted, false);
    assert.equal(replay.json.data.reason, "duplicate");
  }

  assert.equal(fake.state.writes.length, writesAfterSettle, "replays write nothing");
  assert.equal(writers.rating.length, 1, "rating settled exactly once");
  assert.equal(writers.trophy.length, 1, "trophies settled exactly once");
  assert.equal(rowOf(fake).winnerId, ALICE, "the winner is the first verified finish");
  assert.equal(rowOf(fake).raceState.seats.player1.finishedAtMs, GO + 20_000);
  assert.equal(rowOf(fake).raceState.seats.player2.finishedAtMs, GO + 25_000);
});

test("attack: two completion requests in flight at once settle exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 20_000;

  // Both handlers are entered before either transaction finishes.
  const mod = await import(`../${R.finish}`);
  const call = (id) => {
    session.userId = id;
    const req = new Request("http://speedtyping.test/api/speed-typing/match/x/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typedText: TEXT }),
    });
    return mod.POST(req, { params: Promise.resolve({ matchId: MATCH_ID }) });
  };

  const [a, b] = await Promise.all([call(ALICE), call(BOB)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialised the two writes");
  assert.equal(writers.rating.length, 1, "one settlement, never two");
  assert.equal(writers.trophy.length, 1);
  assert.equal(rowOf(fake).status, MATCH_STATUS.FINISHED);

  // Both packets landed on the SAME server instant, so the honest outcome is a
  // dead heat — packet arrival order is not a skill signal. Either way the
  // settlement must be self-consistent and exactly one.
  const row = rowOf(fake);
  if (row.result === RESULT.TIE) {
    assert.equal(row.winnerId, null, "a draw names no winner");
    assert.equal(row.resolutionReason, RESOLUTION.DRAW);
    assert.equal(userWon(fake, ALICE) + userLost(fake, BOB), 0, "a draw moves no counter");
  } else {
    assert.ok(row.winnerId === ALICE || row.winnerId === BOB, "the row names one winner");
    const winner = row.winnerId;
    const winnerWon = winner === ALICE ? userWon(fake, ALICE) : userWon(fake, BOB);
    assert.equal(winnerWon, 1, "exactly one win");
  }
});

// ════════════════════════════════════════════════════════════════════════
// 9. Disconnect and reconnect
// ════════════════════════════════════════════════════════════════════════

test("attack: the disconnect endpoint is token-bound and cannot be forged", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  const routeSrc = readFileSync(R.disconnect, "utf8");

  // ── Every refusal the endpoint performs itself ────────────────────────
  assert.equal((await post(R.disconnect, { matchId: MATCH_ID })).status, 400, "no token");
  assert.equal((await post(R.disconnect, { token: "tok" })).status, 400, "no match id");
  assert.equal(
    (await post(R.disconnect, { matchId: "not-a-uuid", token: "tok" })).status,
    400,
    "malformed id never reaches the driver",
  );
  // A body cannot name its own identity — the token is the only identity.
  assert.equal(
    (await post(R.disconnect, {
      matchId: MATCH_ID,
      token: "tok",
      userId: ALICE,
      clerkId: ALICE,
      playerId: BOB,
    })).status,
    401,
    "a forged/foreign token is refused, whatever the body claims",
  );
  assert.equal(fake.state.writes.length, 0, "nothing reached the store");
  assert.equal(writers.rating.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);

  // ── The identity chain, statically: token → verified sub → store ──────
  assert.match(routeSrc, /verifyToken\(token, \{ secretKey: CLERK_SECRET_KEY \}\)/);
  assert.match(routeSrc, /clerkUserId = verified\.sub \?\? ""/);
  assert.match(routeSrc, /forfeitMatch\(\{ userId: clerkUserId, matchId \}\)/);
  assert.doesNotMatch(
    routeSrc,
    /body\??\.(userId|clerkId|playerId|player1Id|player2Id|winner)/,
    "the endpoint must never accept an identity from the body",
  );
  // A definitive rejection stops the realtime retry loop instead of hammering;
  // an unknown match is never mistaken for a transient failure.
  assert.match(routeSrc, /DEFINITIVE_STATUSES = new Set<number>\(\[403, 404\]\)/);
});

test("attack: the disconnect endpoint fails CLOSED without a verifier", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  // No secret configured: the route must refuse rather than trust the caller.
  clerk.configured = false;
  delete process.env.CLERK_SECRET_KEY;
  seed(fake, armedRow());

  const res = await post(R.disconnect, {
    matchId: MATCH_ID,
    token: "tok",
    userId: BOB,
    forfeited: true,
  });
  assert.equal(res.status, 500, "no verifier means no trust, not an open door");
  assert.equal(res.json.success, false);
  assert.equal(fake.state.writes.length, 0);
  assert.equal(writers.rating.length, 0);
  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING, "the race was not touched");
});

test("attack: a disconnect replay is inert once the race is decided", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  // Drive the SAME store call the endpoint makes (this is the authority the
  // endpoint delegates to). The HTTP wrapper's only additions are the token
  // verification — asserted above — and the broadcast.
  const { forfeitMatch } = await import("../src/lib/speed-typing/serverStore.ts");
  const first = await forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: GO + 40_000 });
  assert.equal(first.forfeited, true);
  assert.equal(rowOf(fake).winnerId, ALICE);
  assert.equal(rowOf(fake).resolutionReason, RESOLUTION.FORFEIT);
  assert.equal(writers.rating.length, 1);

  // The realtime server's retry loop replays the same message.
  const writesAfter = fake.state.writes.length;
  for (let i = 0; i < 5; i += 1) {
    const retry = await forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: GO + 45_000 + i });
    assert.equal(retry.forfeited, false, "a finished race is not forfeited again");
    assert.equal(retry.cancelled, false);
  }
  assert.equal(fake.state.writes.length, writesAfter, "a retried disconnect writes nothing");
  assert.equal(writers.rating.length, 1, "and never re-settles");

  // A reconnect that then completes the passage changes nothing: the win was
  // already awarded and a late packet cannot move it. The seat that TOOK the
  // walkover never typed the text, so its late finish is `resolved` (the race
  // is over) rather than `duplicate` (this seat already finished) — either way
  // it is refused and nothing is written.
  const writesBeforeLate = fake.state.writes.length;
  clock.now = GO + 50_000;
  session.userId = ALICE;
  const late = await finish({ typedText: TEXT });
  assert.equal(late.json.data.accepted, false);
  assert.equal(late.json.data.reason, "resolved");
  assert.equal(late.json.data.seat.finished, false, "the walkover is not rewritten as a typed win");
  assert.equal(fake.state.writes.length, writesBeforeLate);
  assert.equal(rowOf(fake).winnerId, ALICE);
  assert.equal(rowOf(fake).resolutionReason, RESOLUTION.FORFEIT);
  assert.equal(writers.rating.length, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 11, 12. Tampered, foreign and forged prompts
// ════════════════════════════════════════════════════════════════════════

test("attack: a client cannot pick, modify or invent the passage", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 20_000;

  // (a) One character changed anywhere → refused, at the right index.
  const typo = `${TEXT.slice(0, 17)}Q${TEXT.slice(18)}`;
  const mutated = await finish({ typedText: typo, passageText: typo, passageId: "anything" });
  assert.equal(mutated.status, 200);
  assert.equal(mutated.json.data.accepted, false);
  assert.equal(mutated.json.data.reason, "incomplete");
  assert.equal(mutated.json.data.seat.finished, false);

  // (b) Another prompt from the catalog — all of them — is not this race's text.
  for (const passage of ENABLED_PASSAGES) {
    if (passage.id === PROMPT.id) continue;
    const foreign = await finish({
      typedText: passage.text,
      passageId: passage.id,
      passageVersion: PASSAGE_VERSION,
      seed: SEED,
      raceSeed: SEED,
      prompt: passage.text,
    });
    assert.equal(foreign.json.data.accepted, false, `passage ${passage.id} must not complete`);
    assert.equal(foreign.json.data.reason, "incomplete");
  }

  // (c) A retired prompt is not accepted either, even from an attacker who
  //     knows its exact text and id.
  const retired = await finish({ typedText: "x".repeat(20), passageId: "pt-11" });
  assert.equal(retired.json.data.accepted, false);

  // (d) A different SEED's prompt (a real passage, wrong race) is refused.
  const otherSeed = selectPassageForSeed({ seed: SEED + 1 });
  const wrongSeed = await finish({ typedText: otherSeed.text, seed: SEED + 1, raceSeed: SEED + 1 });
  assert.equal(wrongSeed.json.data.accepted, false);

  // (e) None of that moved the row's prompt pair or the race.
  const row = rowOf(fake);
  assert.equal(row.passageId, PROMPT.id, "the stored prompt is the one armed");
  assert.equal(row.passageVersion, PASSAGE_VERSION);
  assert.equal(row.raceSeed, SEED, "the seed was never re-chosen");
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(row.player1CompletedAt, null);
  assert.equal(writers.rating.length, 0);
  assert.equal(fake.state.writes.length, 0, "a refused finish writes nothing at all");

  // (f) The GENUINE text still completes — proof the refusals above are about
  //     the text, not about a broken endpoint.
  const real = await finish({ typedText: TEXT });
  assert.equal(real.json.data.accepted, true);
});

test("attack: the endpoint is never re-armed by a forged passage claim", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 20_000;

  // A client that claims a DIFFERENT prompt for a DIFFERENT seed must still be
  // graded against the row's own pair.
  const claim = await finish({
    typedText: TEXT,
    passageId: "not-this-one",
    passageVersion: 999,
    raceSeed: 1,
    seed: 1,
    reassign: true,
    rearm: true,
    goAt: new Date(GO + 999_999),
  });
  assert.equal(claim.json.data.accepted, true, "the row's own passage is what is graded");
  // The GO instant the race is measured against is the row's, so a forged
  // future `goAt` cannot buy time: elapsed is still server-derived.
  assert.equal(rowOf(fake).raceState.seats.player1.elapsedMs, 20_000);
  assert.equal(rowOf(fake).goAt.getTime(), GO, "the armed instant is untouched");
  assert.equal(rowOf(fake).passageId, PROMPT.id);
});

// ════════════════════════════════════════════════════════════════════════
// 13. Malformed Unicode and hostile text
// ════════════════════════════════════════════════════════════════════════

test("attack: malformed Unicode and hostile text never crash and never complete", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 20_000;

  const hostile = [
    ["lone high surrogate", "\uD800"],
    ["lone low surrogate", "\uDC00"],
    ["astral emoji", "\u{1F600}".repeat(40)],
    ["NUL bytes", "\u0000".repeat(50)],
    ["right-to-left override", `\u202E${TEXT.slice(0, 20)}`],
    ["zero-width joiners", "\u200D".repeat(50)],
    ["combining marks", "e\u0301".repeat(50)],
    ["empty string", ""],
    ["whitespace only", " \t \n ".repeat(30)],
    ["newlines where spaces belong", TEXT.replace(/ /g, "\n")],
    ["one char short", TEXT.slice(0, TEXT.length - 1)],
    ["reversed", [...TEXT].reverse().join("")],
    ["null", null],
    ["undefined", undefined],
    ["number", 12345],
    ["boolean", true],
    ["array", [TEXT]],
    ["object", { text: TEXT }],
    ["nested object", { typedText: TEXT }],
    ["200k characters", "x".repeat(200_000)],
  ];

  for (const [label, value] of hostile) {
    const res = await finish({ typedText: value });
    assert.equal(res.status, 200, `${label}: must be a clean refusal, not a crash`);
    assert.equal(res.json.success, true, `${label}: answered`);
    assert.equal(res.json.data.accepted, false, `${label}: must not complete`);
    assert.equal(res.json.data.seat.finished, false, `${label}: must not finish the seat`);
  }

  assert.equal(rowOf(fake).status, MATCH_STATUS.PLAYING);
  assert.equal(writers.rating.length, 0);
  assert.equal(fake.state.writes.length, 0, "hostile text writes nothing");

  // A body that is not even JSON is a 400, not a 500.
  const garbage = await post(R.finish, "{not json", { raw: true });
  assert.equal(garbage.status, 400);
});

test("attack: the one normalisation the server DOES apply is CRLF, nothing else", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 20_000;

  // Documented and deliberate: a client's line-ending convention must not cost
  // a rated race. The passage is ASCII, so this is the ONLY transformation.
  assert.equal(normalizeTypedText(TEXT), TEXT, "the passage itself is unchanged");
  assert.equal(normalizeTypedText(1234), "", "a non-string is empty, never coerced");

  const crlf = await finish({ typedText: TEXT.replace(/ /g, "\r\n") });
  assert.equal(crlf.json.data.accepted, false, "CRLF is normalised, not collapsed to spaces");

  // CRLF appended PAST the end is capped away — text past the prompt can
  // neither help nor hurt, which is the documented rule.
  seed(fake, armedRow());
  clock.now = GO + 20_000;
  const trailing = await finish({ typedText: `${TEXT}\r\n\r\n` });
  assert.equal(trailing.json.data.accepted, true);
  assert.equal(rowOf(fake).raceState.seats.player1.charsTyped, TEXT.length, "capped at the prompt");

  // Case folding, whitespace collapsing and Unicode normalisation are NOT
  // applied — the race is "type this text", not "type something like it".
  seed(fake, armedRow());
  clock.now = GO + 20_000;
  assert.equal((await finish({ typedText: TEXT.toUpperCase() })).json.data.accepted, false);
  // The shipped catalog is ASCII-only, so Unicode normalisation is a no-op on
  // it: NFC and NFD are literally the same string. The rule itself — no
  // normalisation — is therefore asserted against the pure comparison with a
  // synthetic non-ASCII passage, where it is observable.
  assert.equal(TEXT.normalize("NFD"), TEXT, "the catalog is ASCII: NFD is identity");
  const { verifyTypedText } = await import("../src/lib/speed-typing/rules.ts");
  const composed = "caf\u00e9 latte";
  const decomposed = composed.normalize("NFD");
  assert.notEqual(decomposed, composed, "the probe must actually differ");
  assert.equal(verifyTypedText({ passageText: composed, typedText: decomposed }).ok, false,
    "NFC/NFD must NOT be normalised: the race is 'type this text'");
  assert.equal(verifyTypedText({ passageText: composed, typedText: composed }).ok, true);
});

// ════════════════════════════════════════════════════════════════════════
// 15. Manual settlement
// ════════════════════════════════════════════════════════════════════════

test("attack: no request can settle rating or trophies except a verified second finish", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());
  clock.now = GO + 1_000;

  const settlementPayload = {
    rating: 5_000,
    elo: 5_000,
    delta: 500,
    trophies: 9_999,
    trophy: 9_999,
    settled: true,
    settle: true,
    applyRating: true,
    applyTrophies: true,
    result: "player1",
    winner: "player1",
    winnerId: ALICE,
    loserId: BOB,
    outcome: "win",
    score: "1-0",
    gameKey: "speed-typing",
    matchId: MATCH_ID,
    eventId: MATCH_ID,
  };

  // Progress, finish, cancel and the snapshot: none of them touch a writer.
  await progress({ typedText: TEXT.slice(0, 20), ...settlementPayload });
  await finish({ typedText: TEXT.slice(0, 10), ...settlementPayload });
  await post(R.cancel, settlementPayload);
  await get(R.match);
  assert.equal(writers.rating.length, 0, "no writer may be reached without a settled race");
  assert.equal(writers.trophy.length, 0);
  assert.equal(writers.queue.filter((q) => q.status === "completed").length, 0);

  // The FIRST verified finish still settles nothing, even with every field.
  clock.now = GO + 20_000;
  await finish({ typedText: TEXT, ...settlementPayload });
  assert.equal(writers.rating.length, 0, "one finish is not a settlement");
  assert.equal(writers.trophy.length, 0);

  // Only the second verified finish settles — once, through the shared
  // writers, with ids the STORE derived.
  clock.now = GO + 25_000;
  session.userId = BOB;
  await finish({ typedText: TEXT, ...settlementPayload });
  assert.equal(writers.rating.length, 1);
  assert.equal(writers.trophy.length, 1);
  assert.equal(writers.rating[0].gameKey, "speed-typing");
  assert.equal(writers.rating[0].matchId, MATCH_ID, "the journal key is the row's id");
  assert.equal(writers.rating[0].winnerClerkId, ALICE, "the winner is the store's, not the body's");
  assert.equal(writers.rating[0].loserClerkId, BOB);
  for (const args of [...writers.rating, ...writers.trophy]) {
    for (const key of ["rating", "elo", "delta", "trophies", "trophy", "score", "outcome"]) {
      assert.equal(key in args, false, `the writer must not receive ${key}`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════
// The wire: nothing broadcast may leak the text or a decision
// ════════════════════════════════════════════════════════════════════════

test("wire: broadcasts carry projections only — never the passage or the typed text", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  seed(fake, armedRow());

  await completeAs(ALICE, GO + 20_000);
  await completeAs(BOB, GO + 25_000);
  assert.ok(broadcasts.length > 0, "the routes did broadcast");

  const payloads = JSON.stringify(broadcasts.map((b) => b.payload));
  assert.equal(payloads.includes(TEXT), false, "the passage must never reach a socket");
  assert.equal(payloads.includes(TEXT.slice(0, 20)), false, "nor any fragment of the typed text");

  for (const { room, event, payload } of broadcasts) {
    assert.equal(room, `speed-typing:match:${MATCH_ID}`, "every push targets the match room");
    assert.ok(
      event === "lobby:updated" ||
        event === "speed-typing:opponent-progress" ||
        event === "speed-typing:player-completed" ||
        event === "speed-typing:match-finished",
      `unexpected event on the wire: ${event}`,
    );
    // No broadcast carries a client-authored field.
    for (const forbidden of ["typedText", "passageText", "charsTyped", "errors", "text"]) {
      assert.equal(forbidden in (payload ?? {}), false, `${event} must not carry ${forbidden}`);
    }
  }

  // The opponent-progress projection is the CLOSED five-key shape, and the
  // numbers in it come from the stored seat, not from the request that moved it.
  const progressEvents = broadcasts.filter((b) => b.event === "speed-typing:opponent-progress");
  assert.ok(progressEvents.length >= 2);
  for (const { payload } of progressEvents) {
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["accuracy", "completed", "matchId", "progressPercent", "sentAt", "seatKey", "wpm"].sort(),
      "the projection shape is closed",
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// The socket's own client→server event
// ════════════════════════════════════════════════════════════════════════

test("socket: the ready poke is participant-gated, charset-guarded and carries no state", () => {
  const src = readFileSync("realtime-server/server.js", "utf8");
  const handler = src.slice(src.indexOf('socket.on("speed-typing:ready"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));

  // The id is a uuid-shaped token — a malformed one can never build a room name.
  assert.match(body, /\/\^\[0-9a-fA-F-\]\{1,64\}\$\//);
  // A non-participant is rejected before the relay.
  assert.match(body, /speedTypingRoomParticipants\.get\(matchIdStr\)/);
  assert.match(body, /participants\.has\(socket\.data\.userId\)/);
  assert.match(body, /logThrottled\(\s*"speed-typing:rejectReady"/);
  // The relayed payload is a bare invalidation hint — no progress, no text.
  assert.doesNotMatch(body, /typedText|passageText|charsTyped|progressPercent|wpm|accuracy/);
  assert.match(body, /socket\.to\(roomId\)\.emit\("lobby:updated"/);

  // The upstream direction is not a progress channel at all: the client never
  // emits progress, and no client event reaches a store mutator.
  const clientEvents = [...src.matchAll(/socket\.on\("(speed-typing:[a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(clientEvents)], ["speed-typing:ready"]);
  for (const forbidden of [
    "recordProgress",
    "submitFinish",
    "settleSpeedTypingMatch",
    "applyRatingResult",
    "applyTrophyResult",
  ]) {
    assert.equal(
      handler.includes(forbidden),
      false,
      `the socket layer must never call ${forbidden}`,
    );
  }
});

test("socket: joining a match room is not a path to any state change", () => {
  // `join_room` is the platform's shared, generic room join — every PvP game
  // uses it, and the room id is an unguessable uuid. It is NOT a mutation path:
  // it only affects which projections this socket receives, and the projections
  // are the closed server-derived shapes asserted above. The one client event
  // that could ever relay anything is participant-gated (asserted above), and
  // the passage — the only real secret — is delivered by the authoritative
  // snapshot, never by the socket.
  const src = readFileSync("realtime-server/server.js", "utf8");
  const join = src.slice(src.indexOf('socket.on("join_room"'));
  const body = join.slice(0, join.indexOf("\n  });"));
  assert.match(body, /socket\.join\(String\(roomId\)\)/);
  assert.match(body, /trackSpeedTypingJoin\(String\(roomId\), socket\.data\.userId\)/);
  // The join handler performs no domain work and reads no client state.
  assert.doesNotMatch(body, /fetch\(|await |applyRatingResult|submitFinish|recordProgress/);
  // The admin room stays unreachable through it.
  assert.match(body, /if \(String\(roomId\) === ADMIN_NOTIFICATIONS_ROOM\) return;/);
});

// ── Small helpers used by the assertions above ───────────────────────────

function userWon(fake, clerkId) {
  const u = fake.state.tables.get(users).find((x) => x.clerkId === clerkId);
  return u.gamesWon - 3;
}
function userLost(fake, clerkId) {
  const u = fake.state.tables.get(users).find((x) => x.clerkId === clerkId);
  return u.gamesLost - 2;
}

// A guard against the suite silently degrading: the fixture must really be the
// prompt the store resolves from the row, or every "genuine text" assertion
// above would be meaningless.
test("fixture: the row's seed resolves to the text these attacks use", { skip: SKIP_REASON }, async (t) => {
  const { passageForRow } = await import("../src/lib/speed-typing/passages.ts");
  installMocks(t);
  const row = armedRow();
  assert.equal(passageForRow(row)?.text, TEXT);
  assert.equal(passageForRow(row)?.id, PROMPT.id);
  // RACE_LIMIT_MS is far enough out that no attack above is accidentally a
  // deadline case, and the deadline reasons are asserted explicitly elsewhere.
  assert.ok(clock.now < GO + RACE_LIMIT_MS);
  assert.ok(GO + 30_000 < GO + RACE_LIMIT_MS);
});
