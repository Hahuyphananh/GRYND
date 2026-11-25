/**
 * solitaire-puzzle-session.test.mjs
 *
 * THE SERVER-AUTHORITATIVE PUZZLE SESSION, driven for real.
 *
 * What these tests pin, in the order the store enforces it:
 *
 *   1. FAIRNESS — one server seed, one frozen manifest, two independent copies
 *      of the same start state, one absolute GO/deadline pair.
 *   2. THE CLIENT BOUNDARY — the projection carries no face-down identity, no
 *      stock order, no manifest, no selection seed and no accepted solution.
 *   3. MOVE PROCESSING — legal moves apply and are logged; illegal, malformed,
 *      stale, duplicate, unauthorised and post-deadline moves are all refused
 *      without mutating the stored row.
 *   4. SETTLEMENT — the server derives completion, the winner, the deadline
 *      outcome and the practice result; nothing is client-decided.
 *   5. PERSISTENCE — a re-read rebuilds the identical session from the stored
 *      manifest and seat state.
 *   6. MODE ISOLATION — a practice session is `is_ai`, untimed and rated by
 *      nothing; a ranked session needs two human seats and a real clock.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * The same harness shape as tests/solitaire-duel-store.test.mjs: a fake Drizzle
 * client whose reads target the seeded rows. Two properties are modelled
 * deliberately, because the store's guarantees depend on them:
 *
 *   * `FOR UPDATE` serialization — transactions run one at a time, so the
 *     concurrent-move test observes what the real row lock guarantees.
 *   * rollback on throw and the move log's `(session, seat, ply)` unique key —
 *     so the duplicate-submission backstop is exercised, not assumed.
 *
 * The store module is cached for the whole file, so every test mocks THE SAME
 * fake and resets it; the store is imported LAZILY so `t.mock.module` can
 * intercept `src/db/client.ts`.
 *
 * Run: node --import tsx --test --experimental-test-module-mocks tests/solitaire-puzzle-session.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import {
  solitairePuzzleSessionMoves,
  solitairePuzzleSessions,
} from "../src/db/schema.ts";
import {
  PUZZLE_SESSION_DEADLINE_MS,
  PUZZLE_SESSION_MODE,
  PUZZLE_SESSION_STATUS,
  SOLITAIRE_PUZZLE_AI_PLAYER_ID,
} from "../src/lib/solitaire-puzzle/constants.ts";
import {
  buildPuzzleManifest,
  manifestFromIds,
} from "../src/lib/solitaire-puzzle/manifest.ts";
import { createSeatSnapshot } from "../src/lib/solitaire-puzzle/state.ts";
import { puzzleLibraryPuzzles } from "../src/lib/solitaire-duel/puzzleLibrary.ts";
import { getServerSeedHash } from "../src/lib/solitaire-duel/seeds.js";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:solitaire-duel";

const SESSION_ID = "77777777-7777-4777-8777-777777777777";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const NOW = 1_800_000_000_000;
const SEED = "ab".repeat(32);

const LIBRARY = puzzleLibraryPuzzles();
/** The shortest accepted puzzle, so a full completion is a handful of moves. */
const SAMPLE = [...LIBRARY].sort(
  (a, b) => a.spec.solutions[0].length - b.spec.solutions[0].length,
)[0];
const SAMPLE_MOVE_COUNT = SAMPLE.spec.solutions[0].length;

/** Every card identity reachable inside a payload. */
function identitiesIn(value) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.suit === "string" && typeof node.rank === "number") {
      found.add(`${node.suit}-${node.rank}`);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child);
  };
  walk(value);
  return found;
}

/** Identities the player cannot legitimately see in a start state. */
function hiddenIdentities(startState) {
  const hidden = new Set();
  for (const column of startState.tableau ?? []) {
    for (const pile of column) {
      if (!pile.faceUp && pile.card) hidden.add(`${pile.card.suit}-${pile.card.rank}`);
    }
  }
  return hidden;
}

// ── The fake database ─────────────────────────────────────────────────────

function createFakeDb() {
  const state = {
    tables: new Map(),
    nextId: 1,
    transactions: 0,
    lock: Promise.resolve(),
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
        Promise.resolve(rowsOf(table).map((row) => structuredClone(row))).then(resolve, reject),
    };
    return q;
  };

  const update = (table) => {
    let values = null;
    let applied = null;
    const apply = () => {
      const rows = rowsOf(table);
      for (const row of rows) Object.assign(row, structuredClone(values));
      return rows.map((row) => structuredClone(row));
    };
    const b = {
      set(v) {
        values = v;
        return b;
      },
      where() {
        applied = apply();
        return b;
      },
      returning() {
        return Promise.resolve(applied ?? apply());
      },
      then(resolve, reject) {
        const out = applied ?? apply();
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };

  const insert = (table) => ({
    values: (v) => {
      const seq = state.nextId++;
      // Session ids are real UUIDs, because the store's route guard rejects
      // anything else before the database is touched.
      const id =
        table === solitairePuzzleSessions
          ? `77777777-7777-4777-8777-${String(seq).padStart(12, "0")}`
          : `row-${seq}`;
      const row = { id, createdAt: new Date(), ...structuredClone(v) };
      if (table === solitairePuzzleSessionMoves) {
        const key = `${row.sessionId}|${row.seat}|${row.ply}`;
        const clash = rowsOf(table).some(
          (existing) => `${existing.sessionId}|${existing.seat}|${existing.ply}` === key,
        );
        if (clash) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
          });
        }
      }
      rowsOf(table).push(row);
      const out = { returning: () => Promise.resolve([structuredClone(row)]) };
      out.then = (resolve, reject) => Promise.resolve([structuredClone(row)]).then(resolve, reject);
      return out;
    },
  });

  const tx = {
    select,
    update,
    insert,
    execute: async () => ({ rows: [] }),
  };

  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.transactions = 0;
    state.lock = Promise.resolve();
  };

  return {
    state,
    reset,
    rowsOf,
    db: {
      select,
      update,
      insert,
      transaction: (fn) => {
        const run = async () => {
          state.transactions += 1;
          const backup = new Map(
            [...state.tables].map(([table, rows]) => [table, rows.map((row) => structuredClone(row))]),
          );
          try {
            return await fn(tx);
          } catch (error) {
            // A thrown write rolls the whole transaction back, as Postgres does.
            state.tables.clear();
            for (const [table, rows] of backup) state.tables.set(table, rows);
            throw error;
          }
        };
        // `SELECT … FOR UPDATE`: transactions serialize.
        const result = state.lock.then(run, run);
        state.lock = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
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

const loadStore = () => import("../src/lib/solitaire-puzzle/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Seed one 5-puzzle ranked session row, started and inside its deadline.
 *
 * Built from the store's own creation path so the fixture cannot drift from it.
 */
async function seedRankedSession(fake, overrides = {}) {
  const store = await loadStore();
  const session = await store.createRankedPuzzleSession({
    player1Id: ALICE,
    player2Id: BOB,
    nowMs: NOW,
    seed: SEED,
    ...overrides,
  });
  return session;
}

function seedMove(fake, overrides = {}) {
  fake.rowsOf(solitairePuzzleSessionMoves).push({
    id: `seed-${fake.state.nextId++}`,
    sessionId: SESSION_ID,
    seat: "player1",
    ply: 0,
    puzzleIndex: 0,
    kind: "draw",
    move: { kind: "draw" },
    createdAt: new Date(NOW),
    ...overrides,
  });
}

// ── 1. Fairness: one seed, one manifest, two seats ────────────────────────

test("create: both seats start from the SAME frozen manifest and start state", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const session = await store.createRankedPuzzleSession({
    player1Id: ALICE,
    player2Id: BOB,
    nowMs: NOW,
    seed: SEED,
  });

  assert.equal(session.mode, PUZZLE_SESSION_MODE.RANKED);
  assert.equal(session.status, PUZZLE_SESSION_STATUS.PLAYING);
  assert.equal(session.isAi, false);
  assert.equal(session.player2Id, BOB);

  // Five puzzles, one per difficulty band, in band order.
  assert.equal(session.puzzleCount, 5);
  assert.deepEqual(
    session.manifest.map((entry) => entry.slot),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    session.manifest.map((entry) => entry.level),
    ["beginner", "intermediate", "advanced", "expert", "master"],
  );

  // The commitment: the stored hash is the hash of the stored seed.
  assert.equal(session.selectionSeed, SEED);
  assert.equal(session.selectionHash, getServerSeedHash(SEED));

  // Identical opening, but NOT the same object: one seat cannot mutate the
  // other's board through a shared reference.
  assert.deepEqual(session.p1.state, session.p2.state);
  assert.notEqual(session.p1.state, session.p2.state);
  assert.equal(session.p1.ply, 0);
  assert.equal(session.p2.ply, 0);
  assert.equal(session.p1.solved, 0);
  assert.equal(session.p2.solved, 0);

  // ONE absolute clock, shared by both seats.
  assert.equal(session.goAtMs, NOW);
  assert.equal(session.deadlineAtMs, NOW + PUZZLE_SESSION_DEADLINE_MS);
  assert.equal(fake.rowsOf(solitairePuzzleSessions).length, 1);
});

test("create: the seeded selector is deterministic and both seats re-derive it identically", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const one = await store.createRankedPuzzleSession({
    player1Id: ALICE,
    player2Id: BOB,
    nowMs: NOW,
    seed: SEED,
  });
  const replay = buildPuzzleManifest(SEED);
  assert.deepEqual(
    one.manifest.map((entry) => entry.id),
    replay.map((entry) => entry.id),
    "the stored manifest must equal what the committed seed rebuilds",
  );

  const other = await store.createRankedPuzzleSession({
    player1Id: ALICE,
    player2Id: BOB,
    nowMs: NOW,
    seed: "cd".repeat(32),
  });
  assert.notDeepEqual(
    one.manifest.map((entry) => entry.id),
    other.manifest.map((entry) => entry.id),
  );
});

test("create: a ranked session without a second seat waits, with no clock and no board", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const session = await store.createRankedPuzzleSession({ player1Id: ALICE, nowMs: NOW, seed: SEED });
  assert.equal(session.status, PUZZLE_SESSION_STATUS.WAITING);
  assert.equal(session.player2Id, null);
  assert.equal(session.goAtMs, null, "no GO before an opponent is seated");
  assert.equal(session.deadlineAtMs, null, "no deadline before the clock starts");

  const read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);
  assert.equal(read.view.board, null, "the board is withheld while waiting");
  assert.equal(read.view.status, PUZZLE_SESSION_STATUS.WAITING);
});

test("create: a session needs at least one puzzle", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  await assert.rejects(() => store.createPuzzleSessionRecord({
    mode: PUZZLE_SESSION_MODE.RANKED,
    player1Id: ALICE,
    seed: SEED,
    manifest: [],
  }));
});

// ── 2. The client boundary ────────────────────────────────────────────────

test("projection: no hidden identity, stock order, manifest or solution reaches the client", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const session = await seedRankedSession(sharedFake);
  const read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);

  const view = read.view;
  const json = JSON.stringify(view);

  // No server-only structure, by name.
  for (const key of [
    "manifest",
    "startState",
    "selectionSeed",
    "selectionHash",
    "p1State",
    "p2State",
    "player1Id",
    "player2Id",
    "solutions",
    "verification",
    "solutionCount",
  ]) {
    assert.equal(key in view, false, `${key} must not be a top-level view field`);
    assert.equal(json.includes(`"${key}"`), false, `${key} must not be serialized`);
  }

  // The stock is a COUNT, and the next card is never named.
  assert.equal("stock" in view.board, false, "the stock array must not be sent");
  assert.equal(typeof view.board.stockCount, "number");
  assert.equal(view.board.nextStockCard, null, "the next stock card is hidden information");

  // Every face-down tableau identity is absent; face-down slots carry no card.
  const leaked = hiddenIdentities(session.manifest[0].spec.startState);
  const visible = identitiesIn(view);
  for (const identity of leaked) {
    assert.equal(visible.has(identity), false, `${identity} leaked from a face-down slot`);
  }
  for (const column of view.board.tableau) {
    for (const slot of column) {
      if (!slot.faceUp) assert.equal(slot.card, null, "a face-down slot must be masked");
    }
  }

  // The one solution the library holds is nowhere in the payload.
  const solutionJson = JSON.stringify(SAMPLE.spec.solutions);
  assert.equal(json.includes(solutionJson), false);
});

test("projection: the public objective is the sanitized shape, not the accepted-move form", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(sharedFake);

  const read = await store.fetchPuzzleSession({ userId: BOB, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);

  const objective = read.view.puzzle.objective;
  const allowed = new Set([
    "kind",
    "count",
    "column",
    "card",
    "destination",
    "total",
    "suit",
    "rank",
    "in",
    "target",
    "objectives",
  ]);
  for (const key of Object.keys(objective)) {
    assert.equal(allowed.has(key), true, `unexpected objective field ${key}`);
  }
  assert.equal("moves" in objective, false, "an objective must never carry its answer path");
});

test("projection: a non-participant receives no view at all", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(sharedFake);

  const read = await store.fetchPuzzleSession({ userId: MALLORY, sessionId: session.id, nowMs: NOW });
  assert.equal(read.status, 403);
  assert.equal("view" in read, false, "a refused read carries nothing");
});

// ── 3. Moves ──────────────────────────────────────────────────────────────

test("move: a legal draw advances ONLY the acting seat, and is logged", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);
  const opponentBoard = structuredClone(session.p2.state);

  const result = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal("error" in result, false, result.error);
  assert.equal(result.moveStatus !== "illegal", true);
  assert.equal(result.view.board.stockCount, session.p1.state.stock.length - 1);
  // A library puzzle opens mid-game, so the waste may already hold cards; a
  // draw adds exactly the one card the stock lost.
  assert.equal(result.view.board.waste.length, session.p1.state.waste.length + 1);
  assert.equal(result.seat, "player1");

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.p1Ply, 1);
  assert.equal(row.p1State.stock.length, session.p1.state.stock.length - 1);
  // The opponent's board is byte-identical: one seat cannot move the other.
  assert.equal(row.p2Ply, 0);
  assert.deepEqual(row.p2State, opponentBoard);

  const log = fake.rowsOf(solitairePuzzleSessionMoves);
  assert.equal(log.length, 1);
  assert.deepEqual(
    [log[0].seat, log[0].ply, log[0].puzzleIndex, log[0].kind],
    ["player1", 0, 0, "draw"],
  );
  assert.deepEqual(log[0].move, { kind: "draw" });
});

test("move: an illegal move is refused and mutates nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);
  const before = structuredClone(fake.rowsOf(solitairePuzzleSessions)[0]);

  const result = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    // The waste is empty on the opening board.
    move: { kind: "waste-to-foundation", suit: "hearts" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 422);
  assert.deepEqual(fake.rowsOf(solitairePuzzleSessions)[0], before);
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 0);
});

test("move: a malformed payload is refused before any database work", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);
  const transactionsSoFar = fake.state.transactions;

  for (const bad of [
    { kind: "waste-to-tableau", toColumn: "0" },
    { kind: "waste-to-tableau", toColumn: 99 },
    { kind: "teleport" },
    null,
    "draw",
  ]) {
    const result = await store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move: bad,
      nowMs: NOW,
    });
    assert.equal(result.status, 400, `${JSON.stringify(bad)} must be a 400`);
  }

  const malformedCursor = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: "0",
    nowMs: NOW,
  });
  assert.equal(malformedCursor.status, 400);

  assert.equal(
    fake.state.transactions,
    transactionsSoFar,
    "shape-checking must not open a transaction",
  );
});

test("move: a stale cursor and a duplicate submission are both refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);

  const first = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });
  assert.equal("error" in first, false, first.error);

  // The same submission again: the cursor has moved on.
  const duplicate = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW + 1,
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.error, /stale|already/i);

  // A stale tab that missed several moves is refused the same way.
  const stale = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW + 2,
  });
  assert.equal(stale.status, 409);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.p1Ply, 1, "only the first move applied");
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 1);

  // A malformed cursor is a client error, not a stale one.
  const malformed = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: -1,
    nowMs: NOW,
  });
  assert.equal(malformed.status, 400);
});

test("move: a duplicate (session, seat, ply) row is rejected by the log and rolled back", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);
  // A pre-existing log row at the ply this seat is about to write: the unique
  // key, not the cursor, is what must refuse the write.
  seedMove(fake, { sessionId: session.id });
  const before = structuredClone(fake.rowsOf(solitairePuzzleSessions)[0]);

  const result = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /already been applied/i);
  assert.deepEqual(
    fake.rowsOf(solitairePuzzleSessions)[0],
    before,
    "the seat patch must be rolled back with the failed log write",
  );
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 1);
});

test("move: concurrent submissions of the same ply apply exactly once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);

  const [a, b] = await Promise.all([
    store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move: { kind: "draw" },
      expectedPly: 0,
      nowMs: NOW,
    }),
    store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move: { kind: "draw" },
      expectedPly: 0,
      nowMs: NOW,
    }),
  ]);

  const accepted = [a, b].filter((result) => !("error" in result));
  const refused = [a, b].filter((result) => "error" in result);
  assert.equal(accepted.length, 1, "the row lock must serialise the two writers");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].status, 409);

  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].p1Ply, 1);
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 1);
});

test("move: a non-participant cannot move, and sees nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);

  const result = await store.submitPuzzleMove({
    userId: MALLORY,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 403);
  assert.equal(fake.rowsOf(solitairePuzzleSessions)[0].p1Ply, 0);
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 0);
});

test("move: refused before GO, while waiting, and after settlement", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  // Before the synchronized GO instant.
  const waiting = await store.createRankedPuzzleSession({
    player1Id: ALICE,
    nowMs: NOW,
    seed: SEED,
  });
  const notStarted = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: waiting.id,
    move: { kind: "draw" },
    nowMs: NOW,
  });
  assert.equal(notStarted.status, 409);
  assert.match(notStarted.error, /waiting|not started/i);

  // A live session whose GO is still in the future. (The fake ignores WHERE,
  // so each scenario seeds exactly one row.)
  fake.reset();
  const early = await store.createPuzzleSessionRecord({
    mode: PUZZLE_SESSION_MODE.RANKED,
    player1Id: ALICE,
    player2Id: BOB,
    seed: SEED,
    nowMs: NOW,
    status: PUZZLE_SESSION_STATUS.PLAYING,
    deadlineAtMs: NOW + PUZZLE_SESSION_DEADLINE_MS,
  });
  const earlyRow = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(earlyRow.id, early.id);
  earlyRow.goAt = new Date(NOW + 5_000);
  const tooEarly = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: early.id,
    move: { kind: "draw" },
    nowMs: NOW,
  });
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.error, /not started/i);

  // After settlement.
  fake.reset();
  const finished = await seedRankedSession(fake);
  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.status = PUZZLE_SESSION_STATUS.FINISHED;
  row.result = "player1";
  row.winnerId = ALICE;
  const after = await store.submitPuzzleMove({
    userId: BOB,
    sessionId: finished.id,
    move: { kind: "draw" },
    nowMs: NOW,
  });
  assert.equal(after.status, 409);
  assert.match(after.error, /ended/i);
  assert.equal(row.p2Ply, 0);
});

test("move: a session id that is not a uuid is a 400, not a driver error", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  assert.equal(store.isPuzzleSessionId(SESSION_ID), true);
  assert.equal(store.isPuzzleSessionId("not-a-uuid"), false);

  const read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: "nope", nowMs: NOW });
  assert.equal(read.status, 400);
  const move = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: "nope",
    move: { kind: "draw" },
    nowMs: NOW,
  });
  assert.equal(move.status, 400);
});

// ── 4. Settlement ─────────────────────────────────────────────────────────

test("completion: solving every puzzle settles the race on the server", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await store.createRankedPuzzleSession({
    player1Id: ALICE,
    player2Id: BOB,
    nowMs: NOW,
    seed: SEED,
    manifest: manifestFromIds([SAMPLE.id]),
  });

  let ply = 0;
  let last = null;
  for (const move of SAMPLE.spec.solutions[0]) {
    last = await store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move,
      expectedPly: ply,
      nowMs: NOW + ply * 1_000,
    });
    assert.equal("error" in last, false, last.error);
    ply += 1;
  }

  assert.equal(last.completedSession, true);
  assert.equal(last.finished, true);
  assert.equal(last.view.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(last.view.result.result, "player1");
  assert.equal(last.view.result.winnerSeat, "player1");

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.winnerId, ALICE);
  assert.equal(row.resolutionReason, "finish");
  assert.ok(row.endedAt instanceof Date);
  assert.equal(row.p1Solved, 1);
  assert.ok(row.p1FinishedAt instanceof Date, "the solve instant is server-stamped");
  assert.equal(row.p1Ply, SAMPLE_MOVE_COUNT);
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, SAMPLE_MOVE_COUNT);

  // The solver cannot keep playing a settled session.
  const extra = await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    nowMs: NOW + 60_000,
  });
  assert.equal(extra.status, 409);
});

test("deadline: a post-deadline move is refused and the stored race is settled once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 2;
  row.p2Solved = 1;

  const result = await store.submitPuzzleMove({
    userId: BOB,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /deadline/i);
  assert.equal(row.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(row.result, "player1", "more solved puzzles wins at the deadline");
  assert.equal(row.winnerId, ALICE);
  assert.equal(row.resolutionReason, "deadline");
  assert.equal(row.p2Ply, 0, "the late move is never applied");
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 0);

  // A second pass over the settled row must not re-settle it.
  const read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);
  assert.equal(read.view.result.result, "player1");
  assert.equal(row.resolutionReason, "deadline");
});

test("deadline: an exact tie is a draw, not a fabricated winner", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(sharedFake);

  const row = sharedFake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 0;
  row.p2Solved = 0;

  const read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);
  assert.equal(read.view.result.result, "draw");
  assert.equal(read.view.result.winnerSeat, null);
  assert.equal(row.winnerId, null);
});

test("deadline: an equal solved count is broken by the earlier server solve instant", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(sharedFake);

  const row = sharedFake.rowsOf(solitairePuzzleSessions)[0];
  row.deadlineAt = new Date(NOW - 1_000);
  row.p1Solved = 1;
  row.p2Solved = 1;
  row.p1LastSolveAt = new Date(NOW - 30_000);
  row.p2LastSolveAt = new Date(NOW - 10_000);

  const read = await store.fetchPuzzleSession({ userId: BOB, sessionId: session.id, nowMs: NOW });
  assert.equal("error" in read, false, read.error);
  assert.equal(read.view.result.result, "player1");
  assert.equal(row.winnerId, ALICE);
});

// ── 5. Persistence and recovery ───────────────────────────────────────────

test("persistence: a re-read rebuilds the identical session from stored state", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await seedRankedSession(fake);

  await store.submitPuzzleMove({
    userId: ALICE,
    sessionId: session.id,
    move: { kind: "draw" },
    expectedPly: 0,
    nowMs: NOW,
  });

  const first = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW + 1 });
  const second = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: NOW + 2 });
  assert.equal("error" in first, false, first.error);
  assert.equal("error" in second, false, second.error);

  assert.deepEqual(first.snapshot.manifest, second.snapshot.manifest);
  assert.deepEqual(first.view.board, second.view.board);
  assert.equal(first.snapshot.p1.ply, 1);
  assert.equal(first.snapshot.p1.ply, second.snapshot.p1.ply);

  // The board the client is served is the stored seat state, re-projected.
  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.deepEqual(first.snapshot.p1.state, row.p1State);

  // The append-only log survives too, and is readable per session.
  const log = await store.listPuzzleSessionMoves({ sessionId: session.id });
  assert.equal(log.length, 1);
  assert.equal(log[0].ply, 0);
  assert.equal(log[0].seat, "player1");
});

test("persistence: the stored manifest carries no solution or verification data", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  await seedRankedSession(fake);

  const stored = fake.rowsOf(solitairePuzzleSessions)[0].manifest;
  const json = JSON.stringify(stored);
  assert.equal(json.includes("solutions"), false);
  assert.equal(json.includes("verification"), false);
  assert.equal(json.includes("hints"), false);
  for (const entry of stored) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["category", "concept", "id", "level", "objectiveText", "slot", "spec"],
    );
    // `constraints` is present only when the puzzle declares one; nothing else
    // may be stored on a session spec.
    assert.deepEqual(
      Object.keys(entry.spec).filter((key) => key !== "constraints").sort(),
      ["id", "objective", "startState", "version"],
    );
  }
  // The start state IS stored (the server needs it); it must simply never be
  // projected. That boundary is covered by the projection test above.
  assert.ok(stored[0].spec.startState.tableau.length > 0);
});

// ── 6. Practice vs AI ─────────────────────────────────────────────────────

test("practice: the AI seat starts from the identical puzzle and the session is never ranked", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const session = await store.createAiPuzzleSession({
    userId: ALICE,
    difficulty: "ace",
    nowMs: NOW,
    seed: SEED,
  });

  assert.equal(session.mode, PUZZLE_SESSION_MODE.AI);
  assert.equal(session.isAi, true);
  assert.equal(session.player2Id, SOLITAIRE_PUZZLE_AI_PLAYER_ID);
  assert.equal(session.aiDifficulty, "ace");
  assert.equal(session.status, PUZZLE_SESSION_STATUS.PLAYING);

  // The same published puzzle set and the same opening — no hidden advantage.
  assert.equal(session.puzzleCount, 5);
  assert.deepEqual(session.p1.state, session.p2.state);
  assert.notEqual(session.p1.state, session.p2.state);

  // Untimed, and rated by nothing: no deadline, and the row is is_ai.
  assert.equal(session.deadlineAtMs, null);
  assert.equal(session.goAtMs, NOW);
  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.isAi, true);
  assert.equal(row.mode, "ai");
  assert.equal(row.deadlineAt, null);
});

test("practice: completing the set ends it as a personal finish, with no rating path", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const session = await store.createAiPuzzleSession({
    userId: ALICE,
    nowMs: NOW,
    seed: SEED,
    manifest: manifestFromIds([SAMPLE.id]),
  });

  let ply = 0;
  let last = null;
  for (const move of SAMPLE.spec.solutions[0]) {
    last = await store.submitPuzzleMove({
      userId: ALICE,
      sessionId: session.id,
      move,
      expectedPly: ply,
      nowMs: NOW + ply * 500,
    });
    assert.equal("error" in last, false, last.error);
    ply += 1;
  }

  assert.equal(last.finished, true);
  assert.equal(last.view.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(last.view.result.result, "player1");

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.mode, "ai");
  assert.equal(row.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(row.winnerId, ALICE);
  // The bot seat never plays and never decides anything.
  assert.equal(row.p2Solved, 0);
  assert.equal(row.p2Ply, 0);
});

test("isolation: a practice session is not reachable by a non-owner and never by ranked", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const practice = await store.createAiPuzzleSession({ userId: ALICE, nowMs: NOW, seed: SEED });
  assert.equal(practice.mode, "ai");

  const stranger = await store.fetchPuzzleSession({
    userId: MALLORY,
    sessionId: practice.id,
    nowMs: NOW,
  });
  assert.equal(stranger.status, 403);

  // The ranked creator refuses to put the bot in a competitive seat.
  await assert.rejects(
    store.createRankedPuzzleSession({
      player1Id: ALICE,
      player2Id: SOLITAIRE_PUZZLE_AI_PLAYER_ID,
      nowMs: NOW,
      seed: SEED,
    }),
    /practice bot/i,
  );
});

// ── 7. Fixture sanity ─────────────────────────────────────────────────────

test("fixture: the sample puzzle is a real, multi-move library solution", () => {
  assert.ok(SAMPLE_MOVE_COUNT >= 2, "the sample must need more than one move");
  assert.equal(createSeatSnapshot(manifestFromIds([SAMPLE.id])[0]).solved, 0);
});
