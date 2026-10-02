/**
 * sudoku-duel-store.test.mjs
 *
 * THE AUTHORITATIVE MATCH STORE, driven for real.
 *
 * The model under test, in one line: a client may only ever say WHICH CELL AND
 * WHICH VALUE. The board, the correct count, the mistake count, the penalty, the
 * completion instant, the winner, the result, the rating change and the trophies
 * are all derived by the server from its own state. So most of what these tests
 * do is try to make the store accept something a client is not allowed to decide
 * — and watch it refuse, or ignore the claim and derive the truth anyway.
 *
 * The fairness properties this file exists to prove:
 *
 *   1. ONE puzzle per match: `createOrJoin` mints a seed, commits its hash and
 *      derives one puzzle; BOTH seats are written from it, and joining never
 *      regenerates anything.
 *   2. SEAT ISOLATION: a seat's action writes only that seat's columns. The other
 *      seat's board is byte-identical afterwards.
 *   3. SERVER-DERIVED SETTLEMENT: progress, completion, adjusted time and the
 *      winner come from the boards, and the shared writers are called exactly once
 *      with the canonical literal `gameKey: "sudoku-duel"`.
 *
 * ── THE FAKE ─────────────────────────────────────────────────────────────
 *
 * Same harness shape as tests/solitaire-duel-store.test.mjs: a fake Drizzle client
 * that ignores WHERE clauses (every store read targets the one match row under
 * test), so each scenario seeds exactly the rows it means to act on. Updates
 * persist, so a read after a write observes the new state.
 *
 * The store is loaded LAZILY (never with a static import) so `t.mock.module` can
 * intercept its dependencies.
 *
 * Run:  npm run test:sudoku-duel
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";

import {
  ratingEvents,
  sudokuDuelMatches,
  sudokuDuelMoves,
  trophyEvents,
  users,
} from "../src/db/schema.ts";
import {
  adjustedFinishMs,
  clockLabel,
  solveMs,
  tiebreakLabel,
  viewerOutcome,
} from "../src/lib/sudoku-duel/ui.ts";
import {
  DEFAULT_DIFFICULTY,
  INACTIVITY_ALARM_MS,
  INACTIVITY_FORFEIT_MS,
  MATCH_STATUS,
  MAX_MOVES_PER_SEAT,
  READY_COUNTDOWN_MS,
  VARIANT,
  VARIANT_VERSION,
} from "../src/lib/sudoku-duel/constants.ts";
import { generatePuzzle } from "../src/lib/sudoku-duel/generator.ts";
import { initialStateFromPuzzle } from "../src/lib/sudoku-duel/rules.ts";
import { derivePuzzleSeed, getServerSeedHash } from "../src/lib/sudoku-duel/seeds.js";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:sudoku-duel";

const STORE_PATH = "src/lib/sudoku-duel/serverStore.ts";
const MATCH_ID = "77777777-7777-4777-8777-777777777777";
const ALICE = "user_alice";
const BOB = "user_bob";
const MALLORY = "user_mallory";
const NOW = 1_800_000_000_000;

const SERVER_SEED = "cd".repeat(32);
const PUZZLE_SEED = derivePuzzleSeed({ serverSeed: SERVER_SEED, variantVersion: VARIANT_VERSION });
const SET = generatePuzzle({
  seed: PUZZLE_SEED,
  difficulty: DEFAULT_DIFFICULTY,
  variantVersion: VARIANT_VERSION,
});
const PUZZLE = SET.puzzle;
const SOLUTION = SET.solution;
const GIVENS = SET.givens;
const EMPTIES = [];
for (let i = 0; i < 81; i += 1) if (PUZZLE[i] === 0) EMPTIES.push(i);
const LAST = EMPTIES[EMPTIES.length - 1];
const FIRST = EMPTIES[0];
const GIVEN_INDEX = PUZZLE.findIndex((value) => value !== 0);

/** Every 81-length array reachable anywhere inside a value (for leak checks). */
function arraysOf81(value) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (node.length === 81) found.push(node);
      for (const child of node) walk(child);
      return;
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return found;
}

function assertNoSolution(value) {
  for (const array of arraysOf81(value)) {
    assert.notDeepEqual(array, SOLUTION, "the solution must never appear in a client payload");
  }
}

// ── The fake database ─────────────────────────────────────────────────────

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = { tables: new Map(), nextId: 1, transactions: 0, writes: [], locks: [] };
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

  const insert = (table) => ({
    values: (v) => {
      const row = { id: `row-${state.nextId++}`, createdAt: new Date(), ...v };
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

function resetAll(fake) {
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;
  settlement.queue.length = 0;
}

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

const loadStore = () => import("../src/lib/sudoku-duel/serverStore.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────

let generatedCache = new Map();
function GENERATED_FOR(seed) {
  if (!generatedCache.has(seed)) {
    generatedCache.set(
      seed,
      generatePuzzle({ seed, difficulty: DEFAULT_DIFFICULTY, variantVersion: VARIANT_VERSION }),
    );
  }
  return generatedCache.get(seed);
}

/** The clues at ply 0. */
const opening = () => initialStateFromPuzzle(PUZZLE);

/** A board with the first `count` empties filled correctly. */
function stateAt(count, overrides = {}) {
  const grid = PUZZLE.slice();
  for (let n = 0; n < count; n += 1) grid[EMPTIES[n]] = SOLUTION[EMPTIES[n]];
  return {
    grid,
    ply: count,
    mistakes: 0,
    penaltyMs: 0,
    completed: false,
    completedAtMs: null,
    progressAtMs: count > 0 ? NOW - 60_000 : null,
    ...overrides,
  };
}

/** A board one correct placement away from completion. */
function oneFromDone(overrides = {}) {
  const grid = PUZZLE.slice();
  for (const i of EMPTIES) grid[i] = SOLUTION[i];
  grid[LAST] = 0;
  return {
    grid,
    ply: EMPTIES.length - 1,
    mistakes: 0,
    penaltyMs: 0,
    completed: false,
    completedAtMs: null,
    progressAtMs: NOW - 60_000,
    ...overrides,
  };
}

/** Seed one match row directly, in whatever lifecycle the scenario needs. */
function seedMatch(fake, overrides = {}) {
  const board = opening();
  const row = {
    id: MATCH_ID,
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    difficulty: DEFAULT_DIFFICULTY,
    player1Id: ALICE,
    player2Id: BOB,
    winnerId: null,
    status: MATCH_STATUS.PLAYING,
    isAi: false,
    result: null,
    resolutionReason: null,
    serverSeed: SERVER_SEED,
    serverSeedHash: getServerSeedHash(SERVER_SEED),
    puzzleSeed: PUZZLE_SEED,
    puzzle: PUZZLE.slice(),
    solution: SOLUTION.slice(),
    givens: GIVENS,
    p1State: board,
    p2State: structuredClone(board),
    p1Ply: 0,
    p2Ply: 0,
    p1Correct: 0,
    p2Correct: 0,
    p1Mistakes: 0,
    p2Mistakes: 0,
    p1PenaltyMs: 0,
    p2PenaltyMs: 0,
    p1FinishedAt: null,
    p2FinishedAt: null,
    goAt: new Date(NOW - 5_000),
    startedAt: new Date(NOW - 5_000),
    endedAt: null,
    createdAt: new Date(NOW - 6_000),
    updatedAt: new Date(NOW - 6_000),
    ...overrides,
  };
  // Each board's own ply cursor must agree with its denormalised column.
  if (row.p1State) row.p1State = { ...row.p1State, ply: row.p1Ply };
  if (row.p2State) row.p2State = { ...row.p2State, ply: row.p2Ply };
  fake.rowsOf(sudokuDuelMatches).push(row);
  return row;
}

// ── 1. One seed, one puzzle, two identical boards ─────────────────────────

test("create-or-join: opens a lobby with ONE seed, ONE puzzle and two identical boards", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const { match, joined } = await store.createOrJoin({ userId: ALICE, nowMs: NOW });

  assert.equal(joined, false);
  assert.equal(match.status, MATCH_STATUS.WAITING);
  assert.ok(!match.player2Id, "an open lobby has no second seat");
  assert.equal(match.variant, VARIANT);
  assert.equal(match.variantVersion, VARIANT_VERSION);

  // The seed pair: random server entropy, publicly committed.
  assert.match(match.serverSeed, /^[0-9a-f]{64}$/);
  assert.equal(match.serverSeedHash, getServerSeedHash(match.serverSeed));

  // The puzzle is exactly the one that seed derives, at the row's difficulty.
  assert.equal(
    match.puzzleSeed,
    derivePuzzleSeed({ serverSeed: match.serverSeed, variantVersion: VARIANT_VERSION }),
  );
  assert.deepEqual(
    { puzzle: match.puzzle, solution: match.solution, givens: match.givens },
    {
      puzzle: GENERATED_FOR(match.puzzleSeed).puzzle,
      solution: GENERATED_FOR(match.puzzleSeed).solution,
      givens: GENERATED_FOR(match.puzzleSeed).givens,
    },
  );
  assert.equal(match.givens >= 17, true);

  // BOTH seats hold the same CLUE board, and it is the puzzle's clues.
  assert.deepEqual(match.p1State, match.p2State);
  assert.deepEqual(match.p1State.grid, match.puzzle);
  assert.equal(match.p1Ply, 0);
  assert.equal(match.p2Ply, 0);

  // Nothing has started: no clock yet.
  assert.ok(!match.goAt, "a waiting lobby has no GO instant");
  assert.equal(fake.rowsOf(sudokuDuelMatches).length, 1);
});

test("create-or-join: a second caller joins WITHOUT touching the puzzle", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const first = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const serverSeed = first.match.serverSeed;
  const board = structuredClone(first.match.p1State);

  const second = await store.createOrJoin({ userId: BOB, nowMs: NOW + 1_000 });

  assert.equal(second.joined, true);
  assert.equal(second.match.player2Id, BOB);
  assert.equal(second.match.status, MATCH_STATUS.PLAYING);

  // No new entropy, no new puzzle, no regenerated board.
  assert.equal(second.match.serverSeed, serverSeed);
  assert.equal(second.match.puzzleSeed, first.match.puzzleSeed);
  assert.deepEqual(second.match.puzzle, first.match.puzzle);
  assert.deepEqual(second.match.solution, first.match.solution);
  assert.deepEqual(second.match.p1State, board, "seat 1's board must be untouched");
  assert.deepEqual(second.match.p2State, board, "seat 2 starts from the same board");

  // The clock: one absolute GO instant, no match deadline. The match is
  // untimed; both seats' inactivity clocks start at GO instead.
  const goAt = second.match.goAt.getTime();
  assert.equal(goAt, NOW + 1_000 + READY_COUNTDOWN_MS);
  assert.equal(second.match.p1LastActionAt.getTime(), goAt);
  assert.equal(second.match.p2LastActionAt.getTime(), goAt);

  // Re-asking as the host returns the SAME row rather than opening a second.
  const again = await store.createOrJoin({ userId: ALICE, nowMs: NOW + 2_000 });
  assert.equal(again.match.id, first.match.id);
  assert.equal(fake.rowsOf(sudokuDuelMatches).length, 1);
});

test("create-or-join: two lobbies get different seeds and different puzzles", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const one = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  fake.reset();
  const two = await store.createOrJoin({ userId: MALLORY, nowMs: NOW });

  assert.notEqual(one.match.serverSeed, two.match.serverSeed);
  assert.notEqual(one.match.puzzleSeed, two.match.puzzleSeed);
  assert.notDeepEqual(one.match.puzzle, two.match.puzzle);
});

// ── 2. The puzzle is revealed to both seats, and only when racing ─────────

test("dto: nothing is revealed while the lobby is waiting, and no solution ever leaks", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const { match } = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const dto = store.matchToDto(match, ALICE, NOW);

  assert.equal(dto.view, null, "no board before the race is live");
  assert.equal(dto.opponent, null);
  assert.equal(dto.serverSeed, null, "the seed stays secret until terminal");
  assert.equal(dto.puzzleSeed, null, "the puzzle seed is withheld until terminal");
  assert.equal(dto.seedHash, match.serverSeedHash, "the commitment is public");
  assert.equal("solution" in dto, false);
  assertNoSolution(dto);
});

test("dto: once racing, both seats receive the identical puzzle, and only counts for the opponent", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const first = await store.createOrJoin({ userId: ALICE, nowMs: NOW });
  const { match } = await store.createOrJoin({ userId: BOB, nowMs: NOW + 1_000 });

  const fromAlice = store.matchToDto(match, ALICE, NOW + 1_000);
  const fromBob = store.matchToDto(match, BOB, NOW + 1_000);

  assert.deepEqual(fromAlice.view.puzzle, fromBob.view.puzzle, "the same clues");
  assert.deepEqual(fromAlice.view.puzzle, match.puzzle, "the clue grid is the match's puzzle");
  assert.equal(fromAlice.seat, "player1");
  assert.equal(fromBob.seat, "player2");
  assert.equal(fromAlice.difficulty, fromBob.difficulty);

  // The opponent appears as counts and status, never as a board or answer.
  assert.equal(fromAlice.opponent.seatKey, "player2");
  assert.equal(fromAlice.opponent.correctCells, 0);
  assert.equal(fromAlice.opponent.completed, false);
  for (const key of ["grid", "entries", "solution", "puzzle", "board", "moves"]) {
    assert.equal(key in fromAlice.opponent, false, `${key} must not be in OpponentProgress`);
  }
  assertNoSolution(fromAlice);
  assert.equal(first.match.id, match.id);
});

test("dto: a non-participant is refused, and told nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const result = await store.fetchMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(result.status, 403);

  const dto = store.matchToDto(row, MALLORY, NOW);
  assert.equal(dto.isParticipant, false);
  assert.equal(dto.seat, null);
  assert.equal(dto.view, null);
  assert.equal(dto.opponent, null);
  assert.equal(dto.serverSeed, null);
  assertNoSolution(dto);
});

test("dto: the revealed seed verifies against the pre-match commitment", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  assert.equal(store.matchToDto(row, ALICE, NOW).serverSeed, null, "secret while live");

  row.status = MATCH_STATUS.FINISHED;
  row.result = "draw";
  row.resolutionReason = "draw";
  row.endedAt = new Date(NOW);

  const after = store.matchToDto(row, ALICE, NOW);
  assert.equal(after.serverSeed, SERVER_SEED, "revealed once terminal");
  assert.equal(getServerSeedHash(after.serverSeed), after.seedHash);
  assertNoSolution(after);
});

// ── 3. Actions: correct, incorrect, strict and seat-scoped ────────────────

test("move: a CORRECT placement advances ONLY the acting seat's board", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const opponentBoard = structuredClone(row.p2State);

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal("error" in result, false, result.error);
  assert.equal(result.correct, true);
  assert.equal(result.verdict, "correct");
  assert.equal(result.progress.correctCells, 1);
  assert.equal(result.completed, false);

  // Seat 1 advanced.
  assert.equal(row.p1Ply, 1);
  assert.equal(row.p1State.grid[FIRST], SOLUTION[FIRST]);
  assert.equal(row.p1Correct, 1);

  // Seat 2 did not move, and its board is byte-identical.
  assert.equal(row.p2Ply, 0);
  assert.deepEqual(row.p2State, opponentBoard);

  // The append-only log recorded the validated input at the ply it was played.
  const log = fake.rowsOf(sudokuDuelMoves);
  assert.equal(log.length, 1);
  assert.equal(log[0].seat, "player1");
  assert.equal(log[0].ply, 0);
  assert.equal(log[0].kind, "place");
  assert.deepEqual(log[0].action, { kind: "place", index: FIRST, value: SOLUTION[FIRST] });
});

test("move: an INCORRECT placement records a mistake and a +1s penalty, and writes no value", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const wrong = SOLUTION[FIRST] === 1 ? 2 : 1;
  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: FIRST, value: wrong },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal("error" in result, false, "a wrong value is accepted as an action");
  assert.equal(result.correct, false);
  assert.equal(result.verdict, "incorrect");
  assert.equal(result.progress.correctCells, 0, "progress must not increase");
  assert.equal(result.progress.mistakes, 1);
  assert.equal(result.progress.penaltyMs, 1_000);

  // The value was NOT written, and the answer is NOT in the payload.
  assert.equal(row.p1State.grid[FIRST], 0);
  assert.equal(row.p1Mistakes, 1);
  assert.equal(row.p1PenaltyMs, 1_000);
  assert.equal(row.p1Correct, 0);
  assert.equal(row.p1Ply, 1);
  // The client-visible payload never carries the answer (the raw row does, but
  // it is server-side only and is projected through `matchToDto`).
  assertNoSolution(store.matchToDto(row, ALICE, NOW));

  // The mistake is still an authoritative log row.
  assert.equal(fake.rowsOf(sudokuDuelMoves).length, 1);
  assert.equal(row.status, MATCH_STATUS.PLAYING, "a mistake never ends the match");
});

test("move: an illegal action is refused and mutates nothing", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);
  const before = structuredClone(row);

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: GIVEN_INDEX, value: 1 },
    expectedPly: 0,
    nowMs: NOW,
  });

  assert.equal(result.status, 422);
  assert.match(result.error, /fixed clue/i);
  assert.deepEqual(row, before, "the whole row must be untouched");
  assert.equal(fake.rowsOf(sudokuDuelMoves).length, 0);
  assert.equal(settlement.rating.length, 0);
});

test("move: a malformed action is refused BEFORE any database work", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  for (const bad of [
    { kind: "place", index: "40", value: 1 },
    { kind: "place", index: 40, value: 0 },
    { kind: "place", index: 40, value: 10 },
    { kind: "teleport", index: 0 },
    null,
    "place",
  ]) {
    const result = await store.submitMove({ userId: ALICE, matchId: MATCH_ID, action: bad, nowMs: NOW });
    assert.equal(result.status, 400, `${JSON.stringify(bad)} must be a 400`);
  }

  assert.equal(fake.state.transactions, 0, "shape-checking must not open a transaction");
});

test("move: a stale expectedPly is refused", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, { p1State: stateAt(7), p1Ply: 7, p1Correct: 7 });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: EMPTIES[7], value: SOLUTION[EMPTIES[7]] },
    expectedPly: 6,
    nowMs: NOW,
  });
  assert.equal(result.status, 409);
  assert.match(result.error, /stale/i);
  assert.equal(row.p1Ply, 7);

  const malformed = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: EMPTIES[7], value: SOLUTION[EMPTIES[7]] },
    expectedPly: "7",
    nowMs: NOW,
  });
  assert.equal(malformed.status, 400);
});

test("move: no action is accepted before the synchronized GO instant", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, { goAt: new Date(NOW + 1_000) });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] },
    nowMs: NOW,
  });

  assert.equal(result.status, 409);
  assert.match(result.error, /has not started/i);
  assert.equal(row.p1Ply, 0);
});

test("move: refused while waiting, and once the match is terminal", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });
  const waiting = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] },
    nowMs: NOW,
  });
  assert.equal(waiting.status, 409);
  assert.match(waiting.error, /waiting for an opponent/i);

  fake.reset();
  const terminal = seedMatch(fake, { status: MATCH_STATUS.FINISHED, result: "player1" });
  const after = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] },
    nowMs: NOW,
  });
  assert.equal(after.status, 409);
  assert.equal(terminal.p1Ply, 0);
});

test("move: the per-seat cap bounds action spam", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    p1State: stateAt(3, { ply: MAX_MOVES_PER_SEAT }),
    p1Ply: MAX_MOVES_PER_SEAT,
  });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: EMPTIES[3], value: SOLUTION[EMPTIES[3]] },
    nowMs: NOW,
  });
  assert.equal(result.status, 409);
  assert.match(result.error, /limit/i);
});

// ── 4. The client cannot submit a result ─────────────────────────────────

test("fake result: every claim smuggled into an action is ignored", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedPly: 0,
    nowMs: NOW,
    action: {
      kind: "place",
      index: FIRST,
      value: SOLUTION[FIRST],
      // Claims about the board, the score, the result and the rewards.
      grid: PUZZLE.slice(),
      solution: SOLUTION.slice(),
      correctCells: 81,
      progress: 100,
      mistakes: 0,
      penaltyMs: 0,
      completed: true,
      completedAtMs: NOW,
      winner: "player1",
      result: "player1",
      score: 9999,
      elo: 2400,
      trophy: 99,
      status: MATCH_STATUS.FINISHED,
    },
    winner: "player1",
    result: "player1",
  });

  assert.equal("error" in result, false, result.error);
  assert.equal(result.correct, true, "the action itself was the one correct placement");
  assert.equal(result.completed, false, "the fabricated completion is ignored");
  assert.equal(result.raceResolved, false);

  // The board decided everything: one correct placement, no rating, no trophies.
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(row.result, null);
  assert.equal(row.winnerId, null);
  assert.equal(row.resolutionReason, null);
  assert.equal(row.p1Ply, 1);
  assert.equal(row.p1Correct, 1);
  assert.equal(row.p1State.completed, false);
  assert.equal(row.p1State.completedAtMs, null);
  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("fake result: a fabricated board or solution in the payload never reaches storage", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    expectedPly: 0,
    nowMs: NOW,
    action: {
      kind: "place",
      index: FIRST,
      value: SOLUTION[FIRST],
      // A solved board and the answer key, neither of which may be written.
      grid: (() => {
        const g = PUZZLE.slice();
        for (const i of EMPTIES) g[i] = SOLUTION[i];
        return g;
      })(),
      solution: SOLUTION.slice(),
    },
  });

  const grid = row.p1State.grid;
  assert.equal(grid[FIRST], SOLUTION[FIRST], "only the submitted placement applied");
  assert.equal(grid[LAST], 0, "the rest of the fabricated board is not there");
  assert.equal(row.p1Correct, 1);
  assert.equal(row.p1State.ply, 1);
});

// ── 5. Completion is detected by the server ───────────────────────────────

test("completion: the server detects it, decides the winner and settles once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: oneFromDone(),
    p1Ply: EMPTIES.length - 1,
    p1Correct: EMPTIES.length - 1,
  });

  const result = await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: LAST, value: SOLUTION[LAST] },
    expectedPly: EMPTIES.length - 1,
    nowMs: NOW,
  });

  assert.equal(result.correct, true);
  assert.equal(result.completed, true);
  assert.equal(result.raceResolved, true);
  assert.equal(result.progress.correctCells, EMPTIES.length);
  assert.equal(result.progress.progressPercent, 100);

  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.resolutionReason, "finish");
  assert.equal(row.winnerId, ALICE);
  assert.ok(row.p1FinishedAt instanceof Date, "the completion instant is server-stamped");
  assert.equal(row.p1State.completed, true);
  assert.equal(row.p1State.completedAtMs, NOW, "stamped from the server clock, not the client");

  // Exactly one settlement, with the literal canonical game key.
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].gameKey, "sudoku-duel");
  assert.equal(settlement.rating[0].matchId, MATCH_ID);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.trophy[0].gameKey, "sudoku-duel");
  assert.equal(settlement.trophy[0].winnerClerkId, ALICE);

  // The queue mirror saw exactly one transition, and no second creation.
  assert.deepEqual(
    settlement.queue.map((entry) => [entry.kind, entry.gameKey]),
    [["transition", "sudoku-duel"]],
  );
});

test("completion: an already-finished match never settles twice", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: oneFromDone(),
    p1Ply: EMPTIES.length - 1,
    p1Correct: EMPTIES.length - 1,
  });

  await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: { kind: "place", index: LAST, value: SOLUTION[LAST] },
    expectedPly: EMPTIES.length - 1,
    nowMs: NOW,
  });
  assert.equal(settlement.rating.length, 1);

  const again = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW + 60_000 });
  assert.equal(again.resolved, false);
  assert.equal(again.match.status, MATCH_STATUS.FINISHED);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);

  const second = await store.submitMove({
    userId: BOB,
    matchId: MATCH_ID,
    action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] },
    nowMs: NOW + 1,
  });
  assert.equal(second.status, 409);
  assert.equal(settlement.rating.length, 1);
  assert.equal(row.p2Ply, 0);
});

test("completion/adjusted time: the lower ADJUSTED time wins a photo finish", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Seat 1 already completed 1s earlier, but with five mistakes (+5s): its
  // adjusted time is 4s WORSE than seat 2's clean finish.
  seedMatch(fake, {
    p1State: oneFromDone({
      completed: true,
      completedAtMs: NOW - 1_000,
      grid: (() => {
        const g = PUZZLE.slice();
        for (const i of EMPTIES) g[i] = SOLUTION[i];
        return g;
      })(),
      mistakes: 5,
      penaltyMs: 5_000,
    }),
    p1Ply: 90,
    p1Correct: EMPTIES.length,
    p1FinishedAt: new Date(NOW - 1_000),
    p2State: oneFromDone(),
    p2Ply: EMPTIES.length - 1,
    p2Correct: EMPTIES.length - 1,
  });

  const result = await store.submitMove({
    userId: BOB,
    matchId: MATCH_ID,
    action: { kind: "place", index: LAST, value: SOLUTION[LAST] },
    expectedPly: EMPTIES.length - 1,
    nowMs: NOW,
  });

  assert.equal(result.raceResolved, true);
  const row = fake.rowsOf(sudokuDuelMatches)[0];
  assert.equal(row.result, "player2", "adjusted time beats raw completion instant");
  assert.equal(row.winnerId, BOB);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, BOB);
});

// ── 6. Inactivity (the untimed match) ────────────────────────────────────

test("inactivity: the idle seat forfeits past the threshold and the opponent wins", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    // ALICE has not acted for longer than the forfeit threshold; BOB acted a
    // moment ago, so only ALICE is idle.
    p1LastActionAt: new Date(NOW - INACTIVITY_FORFEIT_MS - 1),
    p2LastActionAt: new Date(NOW),
    p1State: stateAt(5, { progressAtMs: NOW - 60_000 }),
    p1Correct: 5,
    p1Ply: 5,
    p2State: stateAt(30, { progressAtMs: NOW - 30_000 }),
    p2Correct: 30,
    p2Ply: 30,
  });

  const result = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.resolved, true);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player2", "the active seat wins");
  assert.equal(row.winnerId, BOB);
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, BOB);
});

test("inactivity: nothing resolves while every seat is still active", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1LastActionAt: new Date(NOW - 1_000),
    p2LastActionAt: new Date(NOW - 2_000),
  });

  const result = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.resolved, false);
  assert.equal(row.status, MATCH_STATUS.PLAYING);
  assert.equal(settlement.rating.length, 0);
});

test("inactivity: a read resolves the forfeit without a sweeper", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    p1LastActionAt: new Date(NOW - INACTIVITY_FORFEIT_MS - 1),
    p2LastActionAt: new Date(NOW),
  });

  const result = await store.fetchMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.dto.status, MATCH_STATUS.FINISHED);
  assert.equal(result.dto.result, "player2");
  assert.equal(result.dto.resolutionReason, "forfeit");
});

test("inactivity: each viewer is served their OWN alarm and forfeit instants", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    p1LastActionAt: new Date(NOW - 1_000),
    p2LastActionAt: new Date(NOW - 2_000),
  });

  const result = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  assert.equal(result.dto.inactivityAlarmAtMs, NOW - 1_000 + INACTIVITY_ALARM_MS);
  assert.equal(result.dto.inactivityForfeitAtMs, NOW - 1_000 + INACTIVITY_FORFEIT_MS);
  // The opponent's own clock is projected too, so the active seat can be warned.
  assert.equal(result.dto.opponentInactivityAlarmAtMs, NOW - 2_000 + INACTIVITY_ALARM_MS);
  assert.equal(result.dto.opponentInactivityForfeitAtMs, NOW - 2_000 + INACTIVITY_FORFEIT_MS);
});

// ── 7. Forfeit, cancel and disconnect ─────────────────────────────────────

test("forfeit: the conceding seat loses, whoever was ahead", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1Ply: 2,
    p2State: stateAt(20, { progressAtMs: NOW - 30_000 }),
    p2Ply: 40,
    p2Correct: 20,
  });

  const result = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });

  assert.equal("error" in result, false, result.error);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(row.winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);

  fake.reset();
  seedMatch(fake);
  const stranger = await store.forfeitMatch({ userId: MALLORY, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(stranger.status, 403);
});

test("cancel: only the lobby creator, and only while waiting", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });

  const stranger = await store.cancelMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(stranger.status, 403);

  const owner = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal("error" in owner, false, owner.error);
  assert.equal(row.status, MATCH_STATUS.CANCELLED);
  assert.equal(row.result, null);
  assert.equal(settlement.rating.length, 0, "a cancelled lobby never settles");

  fake.reset();
  const live = seedMatch(fake);
  const tooLate = await store.cancelMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(tooLate.status, 409);
  assert.equal(live.status, MATCH_STATUS.PLAYING);
});

test("disconnect: releases a lobby, forfeits a live match, ignores a finished one", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const lobby = seedMatch(fake, { status: MATCH_STATUS.WAITING, player2Id: null });
  const released = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(released.cancelled, true);
  assert.equal(released.forfeited, false);
  assert.equal(lobby.status, MATCH_STATUS.CANCELLED);
  assert.equal(settlement.rating.length, 0);

  fake.reset();
  const live = seedMatch(fake, { p1Ply: 4 });
  const forfeited = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(forfeited.forfeited, true);
  assert.equal(live.result, "player2");
  assert.equal(live.resolutionReason, "forfeit");
  assert.equal(settlement.rating.length, 1);

  fake.reset();
  const settledSoFar = settlement.rating.length;
  const done = seedMatch(fake, { status: MATCH_STATUS.FINISHED, result: "player1", winnerId: ALICE });
  const noop = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(noop.forfeited, false);
  assert.equal(noop.cancelled, false);
  assert.equal(done.result, "player1");
  assert.equal(settlement.rating.length, settledSoFar, "a terminal match must not re-settle");
});

// ── 8. Reads ──────────────────────────────────────────────────────────────

test("lobby: the open-lobby list exposes nothing but the fact that it is waiting", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const { match } = await store.createOrJoin({ userId: ALICE, nowMs: NOW });

  const rows = await store.listOpenMatches();
  assert.equal(rows.length, 1);

  const entry = store.lobbyEntry(match, NOW);
  assert.equal(entry.open, true);
  assert.equal(entry.matchId, match.id);
  assert.equal(entry.seedHash, match.serverSeedHash);
  for (const key of ["puzzle", "solution", "p1State", "p2State", "serverSeed", "player1Id", "player2Id"]) {
    assert.equal(key in entry, false, `${key} must not be in a public lobby entry`);
  }
  assertNoSolution(entry);

  const mine = await store.listMyWaitingMatch({ userId: ALICE });
  assert.equal(mine.id, match.id);
});

test("moves: the append-only log records each seat's own ply sequence", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake);

  await store.submitMove({ userId: ALICE, matchId: MATCH_ID, action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] }, expectedPly: 0, nowMs: NOW });
  await store.submitMove({ userId: ALICE, matchId: MATCH_ID, action: { kind: "clear", index: FIRST }, expectedPly: 1, nowMs: NOW });
  await store.submitMove({ userId: BOB, matchId: MATCH_ID, action: { kind: "place", index: FIRST, value: SOLUTION[FIRST] }, expectedPly: 0, nowMs: NOW });

  const log = fake.rowsOf(sudokuDuelMoves);
  assert.deepEqual(
    log.map((entry) => [entry.seat, entry.ply, entry.kind]),
    [
      ["player1", 0, "place"],
      ["player1", 1, "clear"],
      ["player2", 0, "place"],
    ],
  );

  const read = await store.fetchSeatMoves(MATCH_ID, "player1");
  assert.equal(read.length, 3);

  assert.equal(store.isMatchId(MATCH_ID), true);
  assert.equal(store.isMatchId("not-a-uuid"), false);
  assert.equal(store.isParticipant(row, ALICE), true);
  assert.equal(store.isParticipant(row, BOB), true);
  assert.equal(store.isParticipant(row, MALLORY), false);
});

// ── 9. The competitive result — every state, settled exactly once ────────
//
// Sudoku Duel has no result screen, rating or trophy logic of its own. What it
// owns is the DERIVATION of the outcome from its own boards and the faithful
// handing of it to the platform's shared writers. These tests pin that down for
// each result state the game can reach, plus the two properties the whole
// integration rests on: the writers are reached EXACTLY ONCE per match, and the
// only thing the client can ask for afterwards is a READ of what was written.

/** Seed `users` rows so the journal read can resolve a Clerk id. */
function seedUsers(fake, clerkIds) {
  clerkIds.forEach((clerkId, index) => {
    fake.rowsOf(users).push({
      id: 11 + index,
      clerkId,
      email: `${clerkId}@example.test`,
      name: clerkId,
    });
  });
}

/** Seed the rating/trophy journal rows the REAL writers would have written. */
function seedJournals(fake, { userId, outcome }) {
  fake.rowsOf(ratingEvents).push({
    id: `rating-${userId}`,
    userId,
    gameKey: "sudoku-duel",
    matchId: MATCH_ID,
    opponentId: null,
    outcome,
    ratingBefore: 1000,
    ratingAfter: outcome === "win" ? 1032 : outcome === "loss" ? 968 : 1000,
    delta: outcome === "win" ? 32 : outcome === "loss" ? -32 : 0,
    kFactor: 64,
  });
  fake.rowsOf(trophyEvents).push({
    id: `trophy-${userId}`,
    userId,
    gameKey: "sudoku-duel",
    matchId: MATCH_ID,
    opponentId: null,
    outcome,
    trophiesBefore: 0,
    trophiesAfter: outcome === "win" ? 30 : 0,
    delta: outcome === "win" ? 30 : 0,
  });
}

const lastEmpty = () => EMPTIES[EMPTIES.length - 1];

function completeAs(store, userId, nowMs = NOW) {
  return store.submitMove({
    userId,
    matchId: MATCH_ID,
    action: { kind: "place", index: lastEmpty(), value: SOLUTION[lastEmpty()] },
    expectedPly: EMPTIES.length - 1,
    nowMs,
  });
}

test("result/win: a verified completion names the finisher the winner, and the writers see it once", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: oneFromDone(),
    p1Ply: EMPTIES.length - 1,
    p1Correct: EMPTIES.length - 1,
  });

  const result = await completeAs(store, ALICE);

  assert.equal(result.raceResolved, true);
  assert.equal(result.completed, true);
  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1");
  assert.equal(row.resolutionReason, "finish");
  assert.equal(row.winnerId, ALICE);

  // The completion instant is the SERVER's, stamped on the seat's own state.
  assert.equal(row.p1State.completedAtMs, NOW);
  assert.equal(row.p1FinishedAt?.getTime?.(), NOW);

  // Exactly one settlement, with the server-derived winner — the request
  // carried a cell and a value and nothing else.
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.trophy.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].loserClerkId, BOB);
  assert.equal(settlement.trophy[0].winnerClerkId, ALICE);
  assert.equal(settlement.rating[0].gameKey, "sudoku-duel");

  // Both seats read the same settled row, each seeing their OWN completion.
  const winnerDto = store.matchToDto(row, ALICE, NOW);
  const loserDto = store.matchToDto(row, BOB, NOW);
  assert.equal(winnerDto.completedAtMs, NOW);
  assert.equal(loserDto.completedAtMs, null, "the loser never completed");
  assert.equal(viewerOutcome(winnerDto.seat, winnerDto.result), "win");
  assert.equal(viewerOutcome(loserDto.seat, loserDto.result), "loss");
  // The completion facts the result screen states, from the server's instants.
  assert.equal(solveMs(winnerDto.goAtMs, winnerDto.completedAtMs), NOW - winnerDto.goAtMs);
  assert.equal(adjustedFinishMs(winnerDto.goAtMs, winnerDto.completedAtMs, winnerDto.penaltyMs), NOW - winnerDto.goAtMs + winnerDto.penaltyMs);
  assert.equal(tiebreakLabel(winnerDto.resolutionReason), "Fastest adjusted completion");
});

test("result/loss: a conceding seat loses whoever was ahead, and the stayer takes it", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // ALICE is far ahead on the board — and still loses, because she leaves.
  const row = seedMatch(fake, {
    p1State: stateAt(20, { progressAtMs: NOW - 90_000 }),
    p1Ply: 40,
    p1Correct: 20,
  });

  const result = await store.forfeitMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });

  assert.equal("error" in result, false, result.error);
  assert.equal(row.result, "player2");
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(row.winnerId, BOB);
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, BOB);
  assert.equal(settlement.trophy[0].winnerClerkId, BOB);

  const loserDto = store.matchToDto(row, ALICE, NOW);
  assert.equal(loserDto.completedAtMs, null);
  assert.equal(viewerOutcome(loserDto.seat, loserDto.result), "loss");
  assert.equal(tiebreakLabel(loserDto.resolutionReason), "Opponent left the match");
});

test("result/inactivity: an idle seat forfeits, and the verified progress is preserved on both sides", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1LastActionAt: new Date(NOW),
    p2LastActionAt: new Date(NOW - INACTIVITY_FORFEIT_MS - 1),
    p1State: stateAt(10, { mistakes: 2, penaltyMs: 2_000, progressAtMs: NOW - 40_000 }),
    p1Ply: 30,
    p1Correct: 10,
    p2State: stateAt(4, { mistakes: 5, penaltyMs: 5_000, progressAtMs: NOW - 20_000 }),
    p2Ply: 20,
    p2Correct: 4,
  });

  await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW });

  assert.equal(row.status, MATCH_STATUS.FINISHED);
  assert.equal(row.result, "player1", "the idle seat forfeits");
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(row.winnerId, ALICE);
  assert.equal(settlement.rating.length, 1);

  // Neither seat completed, so there is no completion fact to report — but the
  // numbers the settlement compared are all still in the snapshot.
  const winnerDto = store.matchToDto(row, ALICE, NOW);
  const loserDto = store.matchToDto(row, BOB, NOW);
  assert.equal(winnerDto.completedAtMs, null);
  assert.equal(loserDto.completedAtMs, null);
  assert.equal(solveMs(winnerDto.goAtMs, winnerDto.completedAtMs), null);
  assert.equal(winnerDto.progress.correctCells, 10);
  assert.equal(winnerDto.progress.progressPercent, Math.round((10 / EMPTIES.length) * 100));
  assert.equal(winnerDto.mistakeCount, 2);
  assert.equal(loserDto.progress.correctCells, 4);
  assert.equal(loserDto.mistakeCount, 5);
  assert.equal(viewerOutcome(loserDto.seat, loserDto.result), "loss");
  assert.equal(tiebreakLabel(loserDto.resolutionReason), "Opponent left the match");
  // The loser sees the OPPONENT only as counts — never a board.
  assert.equal(loserDto.opponent.correctCells, 10);
  assert.equal("grid" in loserDto.opponent, false);
});

test("result/simultaneous completion: only the first completion can settle, and the other seat is frozen", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  // Both seats are one cell from done: whichever is judged first settles the
  // race, and the other seat's completing move can never be applied after.
  const row = seedMatch(fake, {
    p1State: oneFromDone(),
    p1Ply: EMPTIES.length - 1,
    p1Correct: EMPTIES.length - 1,
    p2State: oneFromDone(),
    p2Ply: EMPTIES.length - 1,
    p2Correct: EMPTIES.length - 1,
  });

  const first = await completeAs(store, ALICE, NOW);
  assert.equal(first.raceResolved, true);
  assert.equal(row.result, "player1");
  assert.equal(settlement.rating.length, 1);

  const second = await completeAs(store, BOB, NOW + 1);
  assert.equal(second.status, 409);
  assert.match(second.error, /no longer active/i);
  assert.equal(row.p2Ply, EMPTIES.length - 1, "the losing board was never written");
  assert.equal(row.p2State.completed, false);
  assert.equal(settlement.rating.length, 1, "a photo finish settles once");
  assert.equal(settlement.trophy.length, 1);
});

test("result/duplicate: every later settlement path is a no-op after the first", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: oneFromDone(),
    p1Ply: EMPTIES.length - 1,
    p1Correct: EMPTIES.length - 1,
  });

  await completeAs(store, ALICE);
  assert.equal(settlement.rating.length, 1);

  // 1. A duplicate completion report from the other seat (a retry, a replayed
  //    request, a second tab).
  const replay = await completeAs(store, BOB, NOW + 1);
  assert.equal(replay.status, 409);

  // 2. An inactivity sweep running long after the match finished.
  const sweep = await store.resolveInactivityDue({ matchId: MATCH_ID, nowMs: NOW + 60_000 });
  assert.equal(sweep.resolved, false);

  // 3. A forfeit arriving after the result is already final.
  const forfeit = await store.forfeitMatch({ userId: BOB, matchId: MATCH_ID, nowMs: NOW + 2 });
  assert.equal(forfeit.status, 409);

  // 4. The realtime disconnect grace timer for either seat.
  const disconnect = await store.forfeitMatchOnDisconnect({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW + 3 });
  assert.equal(disconnect.forfeited, false);
  assert.equal(disconnect.cancelled, false);

  assert.equal(row.result, "player1");
  assert.equal(row.winnerId, ALICE);
  assert.equal(settlement.rating.length, 1, "the rating writer ran exactly once");
  assert.equal(settlement.trophy.length, 1, "the trophy writer ran exactly once");
});

test("result/duplicate: a second settlement attempt can never reach the writers from the client side", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake);

  // The only player-authored payload is an action + cursor. Everything a
  // malicious client could smuggle alongside it is ignored, and no route or
  // store function accepts a result, a winner, a score or a delta.
  await store.submitMove({
    userId: ALICE,
    matchId: MATCH_ID,
    action: {
      kind: "place",
      index: FIRST,
      value: SOLUTION[FIRST],
      result: "player1",
      winnerId: ALICE,
      completed: true,
      correct: true,
      score: 9999,
      elo: 9999,
      trophies: 9999,
    },
    expectedPly: 0,
    result: "player1",
    nowMs: NOW,
  });

  const row = fake.rowsOf(sudokuDuelMatches)[0];
  assert.equal(row.status, MATCH_STATUS.PLAYING, "one cell is not a completed board");
  assert.equal(row.result, null);
  assert.equal(settlement.rating.length, 0, "nothing settles a live match");
  assert.equal(settlement.trophy.length, 0);
});

test("result/reconnect: a read never settles, and the grace timer decides a real disconnect", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  const row = seedMatch(fake, {
    p1State: stateAt(6, { progressAtMs: NOW - 30_000 }),
    p1Ply: 12,
    p1Correct: 6,
  });

  // A reconnect is just a read: the seat is still held and its board is intact,
  // and NOTHING settles — a dropped socket is not a result.
  const reconnected = await store.fetchMatch({ userId: ALICE, matchId: MATCH_ID, nowMs: NOW });
  assert.equal("error" in reconnected, false, reconnected.error);
  assert.equal(reconnected.dto.view.entries.length, 81);
  assert.equal(reconnected.dto.progress.correctCells, 6);
  assert.equal(reconnected.dto.status, MATCH_STATUS.PLAYING);
  assert.equal(settlement.rating.length, 0, "reading a live match settles nothing");

  // Only the realtime server's grace timer can end it, and it awards the win to
  // the seat that stayed.
  const timedOut = await store.forfeitMatchOnDisconnect({ userId: BOB, matchId: MATCH_ID, nowMs: NOW });
  assert.equal(timedOut.forfeited, true);
  assert.equal(row.result, "player1");
  assert.equal(row.resolutionReason, "forfeit");
  assert.equal(settlement.rating.length, 1);
  assert.equal(settlement.rating[0].winnerClerkId, ALICE);
});

test("history: the settled match keeps its move log, and its journal holds the movement", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, {
    p1State: oneFromDone(),
    p1Ply: EMPTIES.length - 1,
    p1Correct: EMPTIES.length - 1,
  });

  await completeAs(store, ALICE);

  // The append-only action log survives the settlement in full — it is the
  // per-seat record of the match, alongside the match row itself.
  const log = await store.fetchSeatMoves(MATCH_ID, "player1");
  assert.equal(log.length, 1, "the settling action is logged");
  assert.equal(log[0].seat, "player1");
  assert.equal(log[0].kind, "place");
  assert.equal(log[0].action.index, lastEmpty());

  // The rating/trophy journals ARE the platform's match history for a rated
  // duel: one row per seat, keyed by (user, game, match).
  seedUsers(fake, [ALICE]);
  seedJournals(fake, { userId: 11, outcome: "win" });
  const movement = await store.settlementForMatch({ clerkId: ALICE, matchId: MATCH_ID });
  assert.equal(movement.outcome, "win");
  assert.equal(movement.elo.before, 1000);
  assert.equal(movement.elo.after, 1032);
  assert.equal(movement.elo.delta, 32);
  assert.equal(movement.trophies.before, 0);
  assert.equal(movement.trophies.after, 30);
  assert.equal(movement.trophies.delta, 30);
});

test("history: a match that never rated reports NO movement rather than a fake zero", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();
  seedMatch(fake, { status: MATCH_STATUS.CANCELLED, result: null, winnerId: null });

  seedUsers(fake, [ALICE]);
  // A cancelled lobby settles nothing, so the journals hold no row at all.
  assert.equal(
    await store.settlementForMatch({ clerkId: ALICE, matchId: MATCH_ID }),
    null,
    "absent movement is null, never a fabricated 0",
  );
  // Guards come first: a missing identity or match id reads nothing at all.
  assert.equal(await store.settlementForMatch({ clerkId: null, matchId: MATCH_ID }), null);
  assert.equal(await store.settlementForMatch({ clerkId: ALICE, matchId: null }), null);
});

test("completion/adjusted time: the reported final time is solve + penalty (3:00 + 10 mistakes = 3:10)", () => {
  // The exact worked example the match rules state: a board finished in 3:00
  // with ten mistakes carries a ten-second penalty and a 3:10 final time.
  const GO = 1_700_000_000_000;
  const completedAtMs = GO + 180_000; // 3:00 of racing
  const penaltyMs = 10 * 1_000; // ten mistakes, +1s each

  assert.equal(solveMs(GO, completedAtMs), 180_000);
  assert.equal(clockLabel(solveMs(GO, completedAtMs)), "03:00");
  assert.equal(adjustedFinishMs(GO, completedAtMs, penaltyMs), 190_000);
  assert.equal(clockLabel(adjustedFinishMs(GO, completedAtMs, penaltyMs)), "03:10");

  // The helpers are pure formatting over SERVER instants: no completion, no time.
  assert.equal(solveMs(GO, null), null);
  assert.equal(adjustedFinishMs(GO, null, penaltyMs), null);
  assert.equal(solveMs(GO, GO - 1), null, "a completion before GO is not a time");
});

test("history: the settlement read is scoped to the game, the match and the caller's own account", () => {
  const source = readFileSync(STORE_PATH, "utf8");
  const start = source.indexOf("export async function settlementForMatch");
  assert.ok(start > 0, "settlementForMatch must exist");
  const block = source.slice(
    start,
    source.indexOf("/** True when a live match has a seat past the inactivity"),
  );
  // The reader can only ever look at the caller's OWN account, this game and
  // this match — an id from the request can never widen it.
  assert.match(block, /eq\(users\.clerkId, String\(clerkId\)\)/);
  assert.match(block, /eq\(ratingEvents\.gameKey, "sudoku-duel"\)/);
  assert.match(block, /eq\(ratingEvents\.matchId, String\(matchId\)\)/);
  assert.match(block, /eq\(trophyEvents\.gameKey, "sudoku-duel"\)/);
  assert.match(block, /eq\(trophyEvents\.matchId, String\(matchId\)\)/);
  // A READ can never write: it cannot settle, re-settle or forge anything.
  for (const forbidden of [
    "applyRatingResult",
    "applyTrophyResult",
    ".insert(",
    ".update(",
    ".delete(",
    "finalizeMatch",
  ]) {
    assert.equal(block.includes(forbidden), false, `the read must never ${forbidden}`);
  }
});
