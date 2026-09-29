/**
 * speed-typing-settlement.test.mjs
 *
 * COMPETITIVE PROGRESSION, driven for real. One file, the ten settlement
 * scenarios, each asserted against the store's own answers.
 *
 *   normal win · normal loss · duplicate completion request ·
 *   duplicate Socket.IO event · simultaneous completion attempts ·
 *   player disconnect near completion · already-finished match ·
 *   invalid participant · stale client · rating/trophy settlement failure
 *
 * ── WHAT IS BEING PROVEN ────────────────────────────────────────────────
 *
 * Speed Typing owns NO rating maths, NO trophy maths and NO settlement
 * journal. A finished race is recorded by calling the platform's two shared
 * writers (`applyRatingResult` / `applyTrophyResult`) inside the SAME
 * row-locked transaction that flips the match terminal, with
 * `gameKey: "speed-typing"`. So the assertions here are about the SEAM, not
 * about Elo:
 *
 *   * the winner is read from server state and never from a request,
 *   * the shared writers are called exactly once per match — with the right
 *     winner/loser and the canonical literal game key,
 *   * the win/loss counters move once,
 *   * every duplicate, replay, retry, late packet and concurrent burst is a
 *     no-op, and
 *   * a refusing or failing writer can never double-settle and can never
 *     break the match the players just finished.
 *
 * `tests/speed-typing-competitive.test.mjs` proves the wiring statically
 * (the literal game key at each call site, no local Elo port, the registry
 * entry). `tests/speed-typing-store.test.mjs` proves the store's general
 * behaviour. This file is the settlement matrix.
 *
 * ── THE FAKE ────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/speed-typing-store.test.mjs (a fake Drizzle
 * client that ignores WHERE, so each test seeds exactly the rows it means to
 * act on), with one addition that this file specifically needs:
 *
 *   TRANSACTIONS ARE SERIALISED.
 *
 * The real store's exactly-once guard is `SELECT … FOR UPDATE` — Postgres
 * makes two transactions that lock the same row run one after the other. The
 * fake models that by chaining transactions instead of interleaving them,
 * which is what makes the "simultaneous completion attempts" scenario a
 * faithful test rather than a race against the harness. Serialisation is
 * asserted (`maxConcurrent === 1`) so the model cannot silently stop holding.
 *
 * Run:  npm run test:speed-typing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { speedTypingMatches, users } from "../src/db/schema.ts";
import {
  MATCH_STATUS,
  RACE_LIMIT_MS,
  RESOLUTION,
  RESULT,
  SEAT,
} from "../src/lib/speed-typing/constants.ts";
import { createRaceState } from "../src/lib/speed-typing/rules.ts";
import {
  PASSAGE_VERSION,
  selectPassageForSeed,
} from "../src/lib/speed-typing/passages.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:speed-typing";

const MATCH_ID = "77777777-7777-4777-8777-777777777777";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const GO = 1_700_000_000_000;

const SEED = 424242;
const PROMPT = selectPassageForSeed({ seed: SEED });
const TEXT = PROMPT.text;
assert.ok(TEXT.length > 20, "the seeded prompt must be a real passage");

/** The literal every settlement call site must carry. */
const GAME_KEY = "speed-typing";

// ── The fake database (serialised transactions = the row lock) ─────────────

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    writes: [],
    inFlight: 0,
    maxConcurrent: 0,
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

  // Keys the store writes as a `sql` increment. Values are asserted by these
  // tests (gamesWon / gamesLost are part of "update the relevant player
  // statistics"), so the fake applies the increment instead of storing an
  // opaque SQL object.
  const INCREMENT_KEYS = new Set(["revision", "gamesWon", "gamesLost"]);

  /**
   * The literal params inside a Drizzle condition, e.g. `eq(users.clerkId, X)`.
   *
   * The store's settlement increments TWO DIFFERENT account rows (the winner's
   * `games_won` and the loser's `games_lost`), so unlike the single-row match
   * table a WHERE-ignoring fake would apply BOTH increments to BOTH players and
   * make the win/loss counters unassertable. Walking the condition's own
   * chunks gets the fake the one thing it needs — which value to match — and
   * falls back to "every row" when nothing is extractable, so it can never
   * regress the harness's documented behaviour.
   */
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

  const update = (table) => {
    let values = null;
    let targets = null;
    const b = {
      set(v) {
        values = v;
        return b;
      },
      where(clause) {
        const wanted = conditionValues(clause);
        if (wanted.length > 0) {
          targets = rowsOf(table).filter((row) =>
            Object.values(row).some((v) => wanted.includes(v)),
          );
        }
        return b;
      },
      returning: () => {
        // The write is RECORDED once — the store issued one statement — while
        // the ROWS it lands on are narrowed by the WHERE above.
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
          id: `row-${state.nextId++}`,
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
    execute: async () => {},
  };

  // One transaction at a time, in arrival order — what `SELECT … FOR UPDATE`
  // on a shared row does. This is the ONLY thing the fake models beyond the
  // store harness's, and every concurrency test asserts it held.
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
    chain = Promise.resolve();
  };

  return {
    state,
    reset,
    rowsOf,
    // The settlement seam is called directly by some tests (it takes the
    // CALLER's transaction), so the transaction handle is exposed too.
    tx,
    db: { transaction, select, update, insert },
  };
}

// The store module is cached for the file, so every test shares ONE fake and
// resets it — a per-test instance would leave the cached module bound to the
// first one.
let sharedFake = null;
const writers = { rating: [], trophy: [], queue: [], ratingMode: "ok", trophyMode: "ok" };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  writers.rating.length = 0;
  writers.trophy.length = 0;
  writers.queue.length = 0;
  writers.ratingMode = "ok";
  writers.trophyMode = "ok";

  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });

  // The SHARED writers, stubbed. Their real implementations live in
  // src/lib/rating.js / src/lib/trophyStore.js and are covered by
  // tests/elo-rating.test.mjs / tests/trophy-system.test.mjs — this file is
  // about how Speed Typing CALLS them, so what matters here is the argument,
  // the call count and the failure handling.
  const makeWriter = (kind) => async (args) => {
    writers[kind].push(args);
    const mode = writers[`${kind}Mode`];
    if (mode === "throw") throw new Error(`${kind} writer exploded`);
    if (mode === "refuse") return { applied: false, reason: "user-not-found" };
    return { applied: true };
  };

  t.mock.module("../src/lib/rating.js", {
    namedExports: { applyRatingResult: makeWriter("rating") },
  });
  t.mock.module("../src/lib/trophyStore.js", {
    namedExports: { applyTrophyResult: makeWriter("trophy") },
  });
  t.mock.module("../src/lib/canonicalQueueLifecycle.js", {
    namedExports: {
      mirrorQueueCreated: (args) => writers.queue.push({ kind: "created", ...args }),
      mirrorQueueTransition: (args) => writers.queue.push({ kind: "transition", ...args }),
    },
  });

  return fake;
}

const loadStore = () => import("../src/lib/speed-typing/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

/** An armed, playing human race — everything the store reads off the row. */
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
    startedAt: new Date(GO - 3_000),
    endedAt: null,
    createdAt: new Date(GO - 10_000),
    updatedAt: new Date(GO - 10_000),
    ...overrides,
  };
}

/** A race where ONE seat has already banked a verified finish. */
function rowWithFinisher({ finisher = SEAT.PLAYER1, finishedAtMs = GO + 20_000 } = {}) {
  const state = createRaceState({ version: 2 });
  state.seats[finisher] = {
    ...state.seats[finisher],
    charsTyped: TEXT.length,
    errors: 0,
    finished: true,
    finishedAtMs,
    elapsedMs: finishedAtMs - GO,
    wpm: 100,
    accuracy: 100,
  };
  return armedRow({
    raceState: state,
    player1CompletedAt: finisher === SEAT.PLAYER1 ? new Date(finishedAtMs) : null,
    player2CompletedAt: finisher === SEAT.PLAYER2 ? new Date(finishedAtMs) : null,
  });
}

/**
 * Point the fake at exactly ONE match row (plus the two human accounts, so a
 * settled match is never a silent no-op for a missing user).
 */
function seed(fake, row, accounts = [ALICE, BOB]) {
  fake.state.tables.set(speedTypingMatches, [row]);
  fake.state.tables.set(
    users,
    accounts.map((clerkId, index) => ({
      id: index + 1,
      clerkId,
      gamesWon: 3,
      gamesLost: 2,
    })),
  );
  return row;
}

const row = (fake) => fake.state.tables.get(speedTypingMatches)[0];
const userBy = (fake, clerkId) =>
  fake.state.tables.get(users).find((u) => u.clerkId === clerkId);
const writesTo = (fake, table) => fake.state.writes.filter((w) => w.table === table);

/** The whole exactly-once story, asserted in one place. */
function settledExactlyOnce(label, { winner, loser, result } = {}) {
  assert.equal(writers.rating.length, 1, `${label}: rating settles exactly once`);
  assert.equal(writers.trophy.length, 1, `${label}: trophies settle exactly once`);

  const rating = writers.rating[0];
  const trophy = writers.trophy[0];

  // The canonical literal key at both call sites — the same key the registry,
  // the queue mirror and the leaderboards all use.
  assert.equal(rating.gameKey, GAME_KEY);
  assert.equal(trophy.gameKey, GAME_KEY);
  // The match id is the journal key on both sides.
  assert.equal(rating.matchId, MATCH_ID);
  assert.equal(trophy.matchId, MATCH_ID);
  // Both writers see the SAME pair, derived from server state.
  assert.equal(rating.winnerClerkId, trophy.winnerClerkId);
  assert.equal(rating.loserClerkId, trophy.loserClerkId);
  // The caller's transaction, never a fresh one.
  assert.ok(rating.tx, `${label}: rating ran inside the caller's transaction`);
  assert.ok(trophy.tx, `${label}: trophies ran inside the caller's transaction`);

  if (winner) {
    assert.equal(rating.winnerClerkId, winner, `${label}: winner`);
    assert.equal(rating.loserClerkId, loser, `${label}: loser`);
  }
  if (result === "draw") {
    assert.equal(rating.result, "draw");
    assert.equal(trophy.result, "draw");
  } else {
    // A win is the DEFAULT, so the word "win" must not appear — that is what
    // makes a mis-derived draw impossible to hide.
    assert.equal(rating.result, undefined);
    assert.equal(trophy.result, undefined);
  }
}

// ════════════════════════════════════════════════════════════════════════
// 1. Normal win / normal loss
// ════════════════════════════════════════════════════════════════════════

test("settlement: a normal win moves the shared writers and the counters once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  // Alice finishes first, Bob second: Alice wins on the earlier verified finish.
  const first = await submitFinish({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT,
    nowMs: GO + 20_000,
  });
  assert.equal(first.accepted, true);
  assert.equal(first.outcome, null, "one finish does not end a race");
  assert.equal(writers.rating.length, 0, "one finish settles nothing");

  const second = await submitFinish({
    userId: BOB,
    matchId: MATCH_ID,
    typedText: TEXT,
    nowMs: GO + 25_000,
  });
  assert.equal(second.outcome.settled, true);
  assert.equal(second.outcome.winnerSeat, SEAT.PLAYER1, "the EARLIER finish wins");
  assert.equal(second.outcome.resolutionReason, RESOLUTION.FINISH);

  settledExactlyOnce("normal win", { winner: ALICE, loser: BOB });

  // The row itself carries the server's verdict, which is the only thing the
  // result screen is allowed to read.
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(row(fake).result, RESULT.PLAYER1);
  assert.equal(row(fake).winnerId, ALICE);
  assert.ok(row(fake).endedAt instanceof Date);
  assert.equal(row(fake).resolutionReason, RESOLUTION.FINISH);

  // Player statistics: exactly one win and exactly one loss.
  assert.equal(userBy(fake, ALICE).gamesWon, 4);
  assert.equal(userBy(fake, ALICE).gamesLost, 2);
  assert.equal(userBy(fake, BOB).gamesWon, 3);
  assert.equal(userBy(fake, BOB).gamesLost, 3);
});

test("settlement: the losing seat's own result is what settles it, not its WPM", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  // Bob finishes SECOND but with the better-looking race: he typed the same
  // text, later. The result is still a loss for Bob, and the ONLY inputs the
  // writers see are the two ids — never a time, a WPM or an accuracy.
  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 10_000 });
  const bob = await submitFinish({
    userId: BOB,
    matchId: MATCH_ID,
    typedText: TEXT,
    nowMs: GO + 30_000,
  });

  assert.equal(bob.accepted, true);
  assert.equal(row(fake).result, RESULT.PLAYER1);
  settledExactlyOnce("normal loss", { winner: ALICE, loser: BOB });
  assert.equal(userBy(fake, BOB).gamesLost, 3, "the losing seat books the loss");
  assert.equal(userBy(fake, BOB).gamesWon, 3, "and no win");

  // No writer argument carries a number the client could have influenced.
  for (const args of [...writers.rating, ...writers.trophy]) {
    for (const forbidden of ["wpm", "accuracy", "elapsedMs", "finishedAtMs", "durationMs", "score"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(args, forbidden),
        false,
        `settlement must not receive ${forbidden}`,
      );
    }
  }
});

// ════════════════════════════════════════════════════════════════════════
// 2. Duplicates: a completion request, and a Socket.IO event
// ════════════════════════════════════════════════════════════════════════

test("settlement: a duplicate completion request never settles a second time", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 });
  const writesAfterSettle = fake.state.writes.length;

  // Both seats replay, ten times each — a retrying client, a flapping network,
  // a duplicated request. Every one must be a no-op.
  for (let i = 0; i < 10; i += 1) {
    const byBob = await submitFinish({
      userId: BOB,
      matchId: MATCH_ID,
      typedText: TEXT,
      nowMs: GO + 26_000 + i,
    });
    const byAlice = await submitFinish({
      userId: ALICE,
      matchId: MATCH_ID,
      typedText: TEXT,
      nowMs: GO + 27_000 + i,
    });
    assert.equal(byBob.accepted, false);
    assert.equal(byBob.reason, "duplicate");
    assert.equal(byAlice.accepted, false);
    assert.equal(byAlice.reason, "duplicate");
    // The stored finish instants are the FIRST verified ones.
    assert.equal(byBob.seatState.finishedAtMs, GO + 25_000);
    assert.equal(byAlice.seatState.finishedAtMs, GO + 20_000);
  }

  assert.equal(fake.state.writes.length, writesAfterSettle, "a replay writes nothing at all");
  settledExactlyOnce("duplicate request", { winner: ALICE, loser: BOB });
  // The counters did not drift either.
  assert.equal(userBy(fake, ALICE).gamesWon, 4);
  assert.equal(userBy(fake, BOB).gamesLost, 3);
});

test("settlement: a duplicated Socket.IO event cannot settle anything", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch, submitFinish } = await loadStore();
  seed(fake, armedRow());

  // ── The transport carries NO decision, so its duplicate paths are all
  //    routes onto the same store call. The one a duplicate can actually
  //    reach is the disconnect forfeit (the realtime server retries it).
  //
  // A reconnect inside the grace window cancels the timer; a LATE call — the
  // one this test models — arrives for a match that is already over.
  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 });
  const writesAfterSettle = fake.state.writes.length;

  for (let i = 0; i < 5; i += 1) {
    const retry = await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO + 30_000 + i });
    assert.equal(retry.forfeited, false, "a finished race is not forfeited");
    assert.equal(retry.cancelled, false);
    assert.equal(retry.match.status, MATCH_STATUS.FINISHED);
    assert.equal(retry.match.result, RESULT.PLAYER1, "the recorded verdict is untouched");
  }

  assert.equal(fake.state.writes.length, writesAfterSettle, "a retried socket event writes nothing");
  settledExactlyOnce("duplicate socket event", { winner: ALICE, loser: BOB });

  // The `speed-typing:ready` poke is the other client→server event, and it is a
  // bare invalidation hint: it reaches no store mutator at all. Its handler in
  // the realtime server takes `{ matchId }` and relays `lobby:updated`, so
  // there is no field on the wire that a settlement could read.
  const serverSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("realtime-server/server.js", "utf8"),
  );
  // The realtime server is plain CommonJS and cannot import the TS vocabulary,
  // so it carries the event name as a literal. It must still be the SAME name.
  assert.match(serverSrc, /socket\.on\("speed-typing:ready"/);
  assert.doesNotMatch(
    serverSrc.slice(serverSrc.indexOf('speed-typing:ready')),
    /applyRatingResult|applyTrophyResult/,
    "the socket layer must never touch a progression writer",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 3. Simultaneous completion attempts
// ════════════════════════════════════════════════════════════════════════

test("settlement: simultaneous completion attempts settle exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  // Both seats' finish packets land in the same tick. The row lock is the
  // guard; the fake serialises transactions to model it.
  const [alice, bob] = await Promise.all([
    submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 }),
    submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 }),
  ]);

  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialised both writes");
  assert.equal(alice.accepted, true);
  assert.equal(bob.accepted, true, "both seats legitimately completed the passage");

  settledExactlyOnce("simultaneous finishes", { winner: ALICE, loser: BOB });
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(row(fake).winnerId, ALICE, "the earlier verified instant stands");
  assert.equal(userBy(fake, ALICE).gamesWon, 4);
  assert.equal(userBy(fake, BOB).gamesLost, 3);
});

test("settlement: a photo-finish inside the dead-heat window is a draw, settled once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  // Two finish packets 100 ms apart — inside DEAD_HEAT_TOLERANCE_MS. A draw is
  // the honest rating outcome: packet ARRIVAL order is not a skill signal.
  const [alice, bob] = await Promise.all([
    submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 }),
    submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_100 }),
  ]);
  assert.equal(fake.state.maxConcurrent, 1);
  assert.ok(alice.accepted && bob.accepted);

  // A draw journals BOTH seats with result "draw" and names no winner.
  settledExactlyOnce("photo finish", { winner: ALICE, loser: BOB, result: "draw" });
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(row(fake).result, RESULT.TIE);
  assert.equal(row(fake).winnerId, null, "a draw names no winner");
  assert.equal(row(fake).resolutionReason, RESOLUTION.DRAW);
  // A draw is a result, not a win: no win/loss counter moves.
  assert.equal(userBy(fake, ALICE).gamesWon, 3);
  assert.equal(userBy(fake, ALICE).gamesLost, 2);
  assert.equal(userBy(fake, BOB).gamesWon, 3);
  assert.equal(userBy(fake, BOB).gamesLost, 2);
});

test("settlement: a finish racing a forfeit settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish, forfeitMatch } = await loadStore();
  seed(fake, armedRow());

  // Alice's finish packet and Bob's disconnect-forfeit land together. One of
  // them decides the race; the other must find it already decided.
  const [finished, forfeited] = await Promise.all([
    submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 10_000 }),
    forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: GO + 10_000 }),
  ]);

  assert.equal(fake.state.maxConcurrent, 1, "the row lock serialised both writes");
  assert.ok(
    finished.accepted === true || forfeited.forfeited === true,
    "one of the two paths decided the race",
  );
  settledExactlyOnce("finish racing a forfeit", { winner: ALICE, loser: BOB });
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(row(fake).winnerId, ALICE);
  assert.equal(userBy(fake, ALICE).gamesWon, 4);
  assert.equal(userBy(fake, BOB).gamesLost, 3);
});

test("settlement: a finish racing the deadline resolution settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish, resolveDueRace } = await loadStore();
  // The hard limit expires exactly at GO, and Alice is already at the end of
  // the passage — her finish packet and the scheduler's sweep land together.
  const state = createRaceState({ version: 2 });
  state.seats[SEAT.PLAYER1] = { ...state.seats[SEAT.PLAYER1], charsTyped: TEXT.length };
  state.seats[SEAT.PLAYER2] = { ...state.seats[SEAT.PLAYER2], charsTyped: 12 };
  seed(
    fake,
    armedRow({
      goAt: new Date(GO - RACE_LIMIT_MS),
      raceState: state,
      player1CharsTyped: TEXT.length,
      player2CharsTyped: 12,
    }),
  );

  const [finish, due] = await Promise.all([
    submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO }),
    resolveDueRace({ matchId: MATCH_ID, nowMs: GO }),
  ]);
  assert.equal(fake.state.maxConcurrent, 1);

  // Whichever landed first decided it; the loser of that race is inert. Alice
  // typed furthest either way, so the verdict is unambiguous — and there is
  // exactly ONE settlement, never two.
  assert.ok(finish.accepted === true || due.resolved === true, "one path must decide the race");
  settledExactlyOnce("finish racing the deadline", { winner: ALICE, loser: BOB });
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(row(fake).winnerId, ALICE);
  assert.equal(userBy(fake, ALICE).gamesWon, 4);
  assert.equal(userBy(fake, BOB).gamesLost, 3);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Player disconnect near completion
// ════════════════════════════════════════════════════════════════════════

test("settlement: a disconnect near completion settles once, for the seat still racing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch } = await loadStore();
  // Alice has banked a verified finish; Bob is still typing when his socket
  // dies past the grace window.
  seed(fake, rowWithFinisher({ finisher: SEAT.PLAYER1 }));

  const result = await forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: GO + 40_000 });
  assert.equal(result.forfeited, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.match.status, MATCH_STATUS.FINISHED);
  assert.equal(result.match.result, RESULT.PLAYER1);
  assert.equal(result.match.winnerId, ALICE);
  // A walkover is not a typed win, and the row says so.
  assert.equal(result.match.resolutionReason, RESOLUTION.FORFEIT);
  settledExactlyOnce("disconnect near completion", { winner: ALICE, loser: BOB });

  // The disconnecting seat's own banked progress is what its result screen
  // reports — the finish instant the server froze, not a client claim.
  const frozen = row(fake).raceState.seats[SEAT.PLAYER1];
  assert.equal(frozen.finished, true);
  assert.equal(frozen.finishedAtMs, GO + 20_000);
});

test("settlement: disconnecting while BEHIND still loses the race", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch, recordProgress } = await loadStore();
  seed(fake, armedRow());

  // Alice is nearly done; Bob has barely started and then vanishes.
  await recordProgress({
    userId: ALICE,
    matchId: MATCH_ID,
    typedText: TEXT.slice(0, TEXT.length - 2),
    nowMs: GO + 30_000,
  });
  const result = await forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: GO + 31_000 });

  assert.equal(result.forfeited, true);
  assert.equal(result.match.winnerId, ALICE, "leaving forfeits, whatever the scoreboard said");
  assert.equal(result.match.result, RESULT.PLAYER1);
  // The seat that left cannot have its losing submission inflate anything: the
  // writers never see a progress number at all.
  settledExactlyOnce("disconnect while behind", { winner: ALICE, loser: BOB });
  assert.equal(userBy(fake, BOB).gamesLost, 3);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Already-finished match
// ════════════════════════════════════════════════════════════════════════

test("settlement: an already-finished match never settles again, by any path", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish, forfeitMatch, resolveDueRace } = await loadStore();
  seed(fake, {
    ...rowWithFinisher({ finisher: SEAT.PLAYER1, finishedAtMs: GO + 20_000 }),
    status: MATCH_STATUS.FINISHED,
    result: RESULT.PLAYER1,
    winnerId: ALICE,
    endedAt: new Date(GO + 20_000),
    resolutionReason: RESOLUTION.FINISH,
  });

  // Every entry point, against a row that already has its verdict.
  const finish = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 50_000 });
  assert.equal(finish.accepted, false);
  assert.equal(finish.reason, "resolved", "Bob never finished, so it is not even a duplicate");

  const aliceReplay = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 51_000 });
  assert.equal(aliceReplay.reason, "duplicate", "the seat that DID finish replays as a duplicate");

  const forfeit = await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO + 52_000 });
  assert.equal(forfeit.forfeited, false);
  assert.equal(forfeit.cancelled, false);

  const deadline = await resolveDueRace({ matchId: MATCH_ID, nowMs: GO + RACE_LIMIT_MS + 60_000 });
  assert.equal(deadline.resolved, false);

  assert.equal(fake.state.writes.length, 0, "nothing writes to a terminal match");
  assert.equal(writers.rating.length, 0, "and nothing settles");
  assert.equal(writers.trophy.length, 0);
  // The recorded verdict is intact.
  assert.equal(row(fake).result, RESULT.PLAYER1);
  assert.equal(row(fake).winnerId, ALICE);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Invalid participant
// ════════════════════════════════════════════════════════════════════════

test("settlement: a non-participant can neither finish nor forfeit, and settles nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish, forfeitMatch, recordProgress } = await loadStore();
  seed(fake, armedRow(), [ALICE, BOB, MALLORY]);

  const finish = await submitFinish({ userId: MALLORY, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  assert.equal(finish.error, "Not a participant of this match");
  assert.equal(finish.status, 403);

  const progress = await recordProgress({ userId: MALLORY, matchId: MATCH_ID, typedText: TEXT.slice(0, 20), nowMs: GO + 20_000 });
  assert.equal(progress.status, 403);

  const forfeit = await forfeitMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: GO + 20_000 });
  assert.equal(forfeit.status, 403, "a stranger cannot decide someone else's race");

  assert.equal(fake.state.writes.length, 0);
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
  assert.equal(row(fake).status, MATCH_STATUS.PLAYING, "the race is untouched");

  // The realtime disconnect endpoint maps exactly these definitive statuses to
  // a non-retried no-op, so the socket retry loop cannot be used to hammer (or
  // to settle) someone else's match.
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("src/app/api/speed-typing/disconnect-forfeit/route.ts", "utf8");
  assert.match(route, /DEFINITIVE_STATUSES = new Set<number>\(\[403, 404\]\)/);
  assert.match(route, /verifyToken\(/, "the socket's own session token is re-verified");
  assert.match(route, /forfeitMatch\(\{ userId: clerkUserId, matchId \}\)/, "the token owner, never a body-supplied id");
});

// ════════════════════════════════════════════════════════════════════════
// 7. Stale client
// ════════════════════════════════════════════════════════════════════════

test("settlement: a stale client cannot move a settled result", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish, recordProgress, forfeitMatch } = await loadStore();

  // ── (a) A client that was already finished replays its whole buffer.
  seed(fake, armedRow());
  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 });
  const writesAfterSettle = fake.state.writes.length;

  const staleFinish = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 90_000 });
  assert.equal(staleFinish.accepted, false);
  assert.equal(staleFinish.reason, "duplicate");
  assert.equal(staleFinish.seatState.finishedAtMs, GO + 20_000, "the frozen instant is the server's first");
  assert.equal(staleFinish.match.winnerId, ALICE);

  // ── (b) A stale checkpoint arrives after the race closed. The store treats a
  //    late packet as a benign no-op rather than an error — the socket layer
  //    must not have to fail a request whose only sin is arriving late — but it
  //    still writes nothing and cannot re-open the row.
  const staleProgress = await recordProgress({
    userId: BOB,
    matchId: MATCH_ID,
    typedText: TEXT.slice(0, 5),
    nowMs: GO + 91_000,
  });
  assert.equal(staleProgress.accepted, false);
  assert.equal(staleProgress.reason, "resolved");
  assert.equal(staleProgress.seatState.charsTyped, TEXT.length, "Bob's frozen progress is untouched");

  // ── (c) A stale forfeit packet from a seat that already lost.
  const staleForfeit = await forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: GO + 92_000 });
  assert.equal(staleForfeit.forfeited, false);
  assert.equal(staleForfeit.cancelled, false);

  assert.equal(fake.state.writes.length, writesAfterSettle, "a stale client writes nothing");
  settledExactlyOnce("stale client", { winner: ALICE, loser: BOB });
});

test("settlement: a client cannot claim a finish before the server's GO", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();
  seed(fake, armedRow());

  // The GO instant is in the future: a client that has already "typed" the
  // passage (a script, a cached buffer, a manipulated clock) is refused.
  const early = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO - 5_000 });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, "before_go");
  assert.equal(fake.state.writes.length, 0);
  assert.equal(writers.rating.length, 0);

  // And with the race resolved, the rule denies before it even looks at text.
  const resolved = createRaceState({ version: 3 });
  resolved.resolvedAtMs = GO + 1;
  resolved.resolutionReason = RESOLUTION.DEADLINE;
  seed(fake, armedRow({ raceState: resolved }));
  const late = await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 1_000 });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "resolved");
  assert.equal(writers.rating.length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Rating / trophy settlement failure
// ════════════════════════════════════════════════════════════════════════

test("settlement: a REFUSED rating/trophy write is reported, never double-applied", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { settleSpeedTypingMatch, submitFinish } = await loadStore();

  // The shared writers refuse rather than throw for an expected input — a
  // deleted account is `user-not-found`, the platform's documented refusal.
  writers.ratingMode = "refuse";
  writers.trophyMode = "refuse";
  seed(fake, armedRow());

  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  const settled = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 });

  // The match still finishes: a progression hiccup must never withhold the
  // result the two players earned, and must never throw into the route.
  assert.equal(settled.accepted, true);
  assert.equal(settled.outcome.settled, true);
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED);
  assert.equal(row(fake).winnerId, ALICE);

  // …and the seam reports what actually landed instead of claiming success.
  const outcome = await settleSpeedTypingMatch({
    tx: fake.tx,
    matchId: MATCH_ID,
    winnerClerkId: ALICE,
    loserClerkId: BOB,
  });
  assert.deepEqual(outcome, { rated: false, trophied: false }, "a refusal is visible, not implied");

  // A refusal is still called exactly ONCE per finished match — the journal is
  // the writers' own job, and the store never retries a terminal row.
  assert.equal(writers.rating.length, 2, "one attempt at finish, one explicit call");
  assert.equal(writers.trophy.length, 2);
});

test("settlement: a THROWING writer never breaks the match, and never double-settles", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { submitFinish } = await loadStore();

  // An unexpected database error inside a shared writer. Speed Typing's
  // settlement runs as a best-effort side effect of finalisation, exactly like
  // every other game's, so this must not abort the transaction that recorded
  // the match.
  writers.ratingMode = "throw";
  writers.trophyMode = "throw";
  seed(fake, armedRow());

  await submitFinish({ userId: ALICE, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 20_000 });
  const settled = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 25_000 });

  assert.equal(settled.accepted, true, "the finish is still accepted");
  assert.equal(settled.outcome.settled, true);
  assert.equal(row(fake).status, MATCH_STATUS.FINISHED, "the match still reached its terminal state");
  assert.equal(row(fake).result, RESULT.PLAYER1);
  assert.equal(row(fake).winnerId, ALICE);
  assert.equal(writers.rating.length, 1, "the writer was attempted exactly once");
  assert.equal(writers.trophy.length, 1);

  // The row is terminal, so no path retries it — a replay is still a no-op,
  // which is what keeps "at most once" true even when a write fails.
  const writesAfterSettle = fake.state.writes.length;
  const replay = await submitFinish({ userId: BOB, matchId: MATCH_ID, typedText: TEXT, nowMs: GO + 26_000 });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(fake.state.writes.length, writesAfterSettle);
  assert.equal(writers.rating.length, 1, "never a second attempt");
  assert.equal(writers.trophy.length, 1);
});

test("settlement: a healthy settlement reports rated, and a draw journals both seats", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { settleSpeedTypingMatch } = await loadStore();
  seed(fake, armedRow());

  const applied = await settleSpeedTypingMatch({
    tx: fake.tx,
    matchId: MATCH_ID,
    winnerClerkId: ALICE,
    loserClerkId: BOB,
  });
  assert.deepEqual(applied, { rated: true, trophied: true });
  assert.equal(writers.rating[0].gameKey, GAME_KEY);
  assert.equal(writers.trophy[0].gameKey, GAME_KEY);

  // A dead heat has no winner, so the seats are named by POSITION and both
  // writers are told "draw" — still journaled, so the event history is whole.
  writers.rating.length = 0;
  writers.trophy.length = 0;
  const drawn = await settleSpeedTypingMatch({
    tx: fake.tx,
    matchId: MATCH_ID,
    winnerClerkId: ALICE,
    loserClerkId: BOB,
    result: "draw",
  });
  assert.deepEqual(drawn, { rated: true, trophied: true });
  settledExactlyOnce("draw", { winner: ALICE, loser: BOB, result: "draw" });
});

test("settlement: a match with no opponent, a practice match and a bad pair never settle", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const { forfeitMatch, settleSpeedTypingMatch } = await loadStore();

  // A waited-on-but-never-joined lobby that gets abandoned: cancelled, nothing rated.
  seed(fake, {
    ...armedRow(),
    player2Id: null,
    goAt: null,
    raceSeed: null,
    passageId: null,
    status: MATCH_STATUS.WAITING,
  });
  const abandoned = await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO });
  assert.equal(abandoned.cancelled, true);
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);

  // A practice row (isAi) can never reach a writer even if it somehow resolves.
  seed(fake, { ...rowWithFinisher({ finisher: SEAT.PLAYER1 }), isAi: true, player2Id: null });
  await forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: GO + 40_000 });
  assert.equal(writers.rating.length, 0, "practice is never rated");
  assert.equal(writers.trophy.length, 0);

  // And the settlement seam's own guards: a seat can never rate against
  // itself, and a match with no id cannot be journaled.
  const sameSeat = await settleSpeedTypingMatch({
    tx: fake.tx,
    matchId: MATCH_ID,
    winnerClerkId: ALICE,
    loserClerkId: ALICE,
  });
  assert.deepEqual(sameSeat, { rated: false, trophied: false }, "a seat never rates against itself");
  const noSeat = await settleSpeedTypingMatch({
    tx: fake.tx,
    matchId: "",
    winnerClerkId: ALICE,
    loserClerkId: BOB,
  });
  assert.deepEqual(noSeat, { rated: false, trophied: false });
  assert.equal(writers.rating.length, 0);
  assert.equal(writers.trophy.length, 0);
});
