/**
 * solitaire-puzzle-ai.test.mjs
 *
 * PUZZLE vs AI — the six shipped bots on the strategic puzzle library.
 *
 * What this file pins:
 *
 *   1. IDENTITY — the opponents are exactly the existing six Solitaire bots
 *      (rookie, felix, ace, professor, grandmaster, perfect), with their names,
 *      difficulty labels, descriptions and avatars untouched. No seventh bot.
 *   2. SOLVING — every bot solves every supported library puzzle through the
 *      shared `applySeatMove` engine, using only legal moves, deterministically.
 *   3. FAIRNESS — a bot's decision does not change when face-down identities
 *      the player cannot see (or stock order) are scrambled.
 *   4. DIFFICULTY — pacing comes from each bot's existing profile, so the six
 *      profiles genuinely differ in time-to-finish and in how many moves are
 *      due in a fixed window.
 *   5. PRACTICE-ONLY — the bot plays on server reads, the human can still win,
 *      and a finished practice session writes NO rating, NO trophy and NO
 *      ranked-history row.
 *   6. TIES — equal solved counts with equal completion instants are a draw.
 *
 * Run: node --import tsx --test --experimental-test-module-mocks tests/solitaire-puzzle-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";

import {
  solitairePuzzleSessionMoves,
  solitairePuzzleSessions,
} from "../src/db/schema.ts";
import {
  PUZZLE_SESSION_STATUS,
  SOLITAIRE_PUZZLE_AI_PLAYER_ID,
} from "../src/lib/solitaire-puzzle/constants.ts";
import {
  PUZZLE_AI_BOT_IDS,
  choosePuzzleAiMove,
  planPuzzleAiSeat,
  puzzleAiPaceMs,
  visiblePuzzleSignature,
} from "../src/lib/solitaire-puzzle/ai.ts";
import {
  createSeatSnapshot,
  resolvePuzzleOutcome,
  applySeatMove,
} from "../src/lib/solitaire-puzzle/state.ts";
import { manifestFromIds } from "../src/lib/solitaire-puzzle/manifest.ts";
import {
  SOLITAIRE_BOTS,
  SOLITAIRE_BOT_BY_ID,
  isSolitaireBotId,
  publicSolitaireBots,
} from "../src/lib/solitaire-duel/bots.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { puzzleMoveSignature } from "../src/lib/solitaire-duel/puzzleValidation.ts";
import { applyMove } from "../src/lib/solitaire-duel/rules.ts";
import { puzzleLibraryPuzzles } from "../src/lib/solitaire-duel/puzzleLibrary.ts";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:puzzle-ai";

const ALICE = "user_alice";
const NOW = 1_800_000_000_000;
const LIBRARY = puzzleLibraryPuzzles();
const BY_LENGTH = [...LIBRARY].sort(
  (a, b) => a.spec.solutions[0].length - b.spec.solutions[0].length,
);
const SAMPLE = BY_LENGTH[0];

// ── 1. The six existing identities ────────────────────────────────────────

test("roster: the six existing bots are the only puzzle opponents", () => {
  assert.deepEqual(
    SOLITAIRE_BOTS.map((bot) => bot.id),
    ["rookie", "felix", "ace", "professor", "grandmaster", "perfect"],
  );
  assert.deepEqual([...PUZZLE_AI_BOT_IDS], SOLITAIRE_BOTS.map((bot) => bot.id));

  // Names, difficulty copy, audience and avatars are the shipped identities.
  assert.equal(SOLITAIRE_BOT_BY_ID.rookie.name, "Rookie");
  assert.equal(SOLITAIRE_BOT_BY_ID.rookie.difficultyLabel, "Very Easy");
  assert.equal(SOLITAIRE_BOT_BY_ID.felix.name, "Felix");
  assert.equal(SOLITAIRE_BOT_BY_ID.ace.name, "Ace");
  assert.equal(SOLITAIRE_BOT_BY_ID.professor.name, "Professor");
  assert.equal(SOLITAIRE_BOT_BY_ID.grandmaster.name, "Grandmaster");
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.name, "Perfect");
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.rating, null);
  assert.equal(SOLITAIRE_BOT_BY_ID.rookie.avatar.src, "/images/solitaire-bots/rookie.webp");
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.avatar.src, "/images/mascot/glitch-idle.webp");

  // The public picker payload is the shared one — six, not a puzzle copy.
  assert.equal(publicSolitaireBots().length, 6);
  assert.deepEqual(
    publicSolitaireBots().map((bot) => bot.id),
    ["rookie", "felix", "ace", "professor", "grandmaster", "perfect"],
  );

  assert.equal(isSolitaireBotId("perfect"), true);
  assert.equal(isSolitaireBotId("glitch-bot"), false);
  assert.equal(isSolitaireBotId("easy"), false, "legacy tiers are not bot ids in a new route");
  assert.equal(isSolitaireBotId(null), false);
});

test("roster mapping: established difficulties and Glitch-as-Perfect are unchanged", () => {
  const expected = {
    rookie: "Very Easy",
    felix: "Easy",
    ace: "Intermediate",
    professor: "Hard",
    grandmaster: "Expert",
    perfect: "Perfect",
  };
  for (const [botId, label] of Object.entries(expected)) {
    assert.equal(SOLITAIRE_BOT_BY_ID[botId].difficultyLabel, label, botId);
  }
  // The sixth opponent still speaks and appears as Glitch.
  assert.match(SOLITAIRE_BOT_BY_ID.perfect.avatar.alt, /Glitch/);
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.difficulty, "perfect");
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.order, 6);
  assert.deepEqual(
    PUZZLE_AI_BOT_IDS,
    ["rookie", "felix", "ace", "professor", "grandmaster", "perfect"],
  );
});

// ── 2. Every bot solves every supported puzzle ────────────────────────────

function playPuzzle(botId, puzzle) {
  const entry = manifestFromIds([puzzle.id])[0];
  let seat = createSeatSnapshot(entry);
  let steps = 0;
  const sources = new Set();

  for (;;) {
    const decision = choosePuzzleAiMove({ entry, seat, botId });
    if (!decision) break;
    sources.add(decision.source);

    const legal = legalMoves(seat.state).some(
      (move) => puzzleMoveSignature(move) === puzzleMoveSignature(decision.move),
    );
    assert.ok(legal, `${botId} proposed a non-legal move on ${puzzle.id}`);

    const applied = applySeatMove({
      manifest: [entry],
      seat,
      move: decision.move,
      nowMs: steps,
    });
    assert.notEqual(applied.status, "illegal", `${botId} on ${puzzle.id}`);

    seat = applied.seat;
    steps += 1;
    if (applied.completedSession) break;
    assert.ok(steps < 40, `${botId} did not finish ${puzzle.id} (${puzzle.level})`);
  }

  return { seat, steps, sources };
}

test("solving: all six bots finish every library puzzle, legally and deterministically", () => {
  let runs = 0;
  for (const botId of PUZZLE_AI_BOT_IDS) {
    for (const puzzle of LIBRARY) {
      const entry = manifestFromIds([puzzle.id])[0];
      const seat = createSeatSnapshot(entry);

      // Same board + same bot → the same move, every time.
      const first = choosePuzzleAiMove({ entry, seat, botId });
      const second = choosePuzzleAiMove({ entry, seat, botId });
      assert.deepEqual(first, second, `${botId} is not deterministic on ${puzzle.id}`);

      const { seat: solvedSeat, steps, sources } = playPuzzle(botId, puzzle);
      assert.equal(solvedSeat.solved, 1, `${botId} did not solve ${puzzle.id}`);
      assert.notEqual(solvedSeat.finishedAtMs, null);
      assert.deepEqual([...sources], ["line"], `${botId} left the verified line on ${puzzle.id}`);
      assert.ok(steps >= 2, "practice puzzles are multi-decision positions");
      runs += 1;
    }
  }
  assert.equal(runs, LIBRARY.length * PUZZLE_AI_BOT_IDS.length);
});

test("fairness: decisions ignore hidden identities and stock order", () => {
  const SUITS = ["spades", "hearts", "diamonds", "clubs"];
  const otherSuit = { spades: "hearts", hearts: "clubs", clubs: "diamonds", diamonds: "spades" };
  const key = (card) => `${card.suit}${card.rank}`;
  const remap = (card) => ({
    suit: otherSuit[card.suit],
    rank: ((card.rank + 6 - 1) % 13) + 1,
  });

  /** Cards the verified lines legitimately turn face-up. */
  function revealedByLines(puzzle) {
    const seen = new Set();
    for (const line of puzzle.spec.solutions) {
      let state = puzzle.spec.startState;
      for (const move of line) {
        const applied = applyMove({ state, move });
        if (!applied.ok) break;
        for (const card of applied.revealed ?? []) seen.add(key(card));
        state = applied.state;
      }
    }
    return seen;
  }

  let checked = 0;
  for (const puzzle of LIBRARY) {
    const entry = manifestFromIds([puzzle.id])[0];
    const revealed = revealedByLines(puzzle);
    const start = structuredClone(puzzle.spec.startState);

    // Scramble every face-down identity the solution never reveals, and reverse
    // the hidden stock. A human could not tell these boards apart.
    let changed = 0;
    for (const column of start.tableau) {
      for (const pile of column) {
        if (pile.faceUp) continue;
        if (revealed.has(key(pile.card))) continue;
        pile.card = remap(pile.card);
        changed += 1;
      }
    }
    start.stock.reverse();

    const scrambled = { ...entry, spec: { ...entry.spec, startState: start } };
    const before = choosePuzzleAiMove({ entry, seat: createSeatSnapshot(entry), botId: "perfect" });
    const after = choosePuzzleAiMove({
      entry: scrambled,
      seat: createSeatSnapshot(scrambled),
      botId: "perfect",
    });

    // If a line needed one of the identities that was hidden at decision time,
    // that move is no longer legal on the scrambled board — skip that puzzle
    // rather than weaken the assertion for the ones that can be compared.
    if (!before || !after) continue;
    if (before.source !== "line" || after.source !== "line") continue;
    const comparable = applyMove({ state: start, move: before.move }).ok;
    if (!comparable) continue;

    assert.deepEqual(after.move, before.move, `${puzzle.id} depended on hidden information`);
    checked += 1;
  }

  assert.ok(checked >= 10, `only ${checked} puzzles were comparable`);
});

// ── 3. Difficulty and pacing ──────────────────────────────────────────────

test("difficulty: pacing is the shipped profile's, and the six differ measurably", () => {
  const delays = PUZZLE_AI_BOT_IDS.map((botId) => puzzleAiPaceMs(botId));
  assert.deepEqual(delays, [2_600, 2_300, 1_550, 1_150, 820, 560]);

  // Strictly faster down the roster: a fixed 5 s window gives more bot moves to
  // a stronger profile, and the estimated finish time falls with it.
  const movesInFiveSeconds = PUZZLE_AI_BOT_IDS.map((botId) =>
    Math.min(6, Math.floor(5_000 / puzzleAiPaceMs(botId))),
  );
  assert.deepEqual(movesInFiveSeconds, [1, 2, 3, 4, 6, 6]);

  const entry = manifestFromIds([SAMPLE.id])[0];
  const session = {
    id: "session",
    mode: "ai",
    status: PUZZLE_SESSION_STATUS.PLAYING,
    player1Id: ALICE,
    player2Id: SOLITAIRE_PUZZLE_AI_PLAYER_ID,
    isAi: true,
    manifest: [entry],
    puzzleCount: 1,
    selectionSeed: "seed",
    selectionHash: "hash",
    p1: createSeatSnapshot(entry),
    p2: createSeatSnapshot(entry),
    goAtMs: 0,
    deadlineAtMs: null,
    endedAtMs: null,
    result: null,
    winnerId: null,
    resolutionReason: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    aiDifficulty: "perfect",
  };

  const fiveSeconds = PUZZLE_AI_BOT_IDS.map((botId) => {
    const advance = planPuzzleAiSeat({
      snapshot: { ...session, aiDifficulty: botId },
      nowMs: 5_000,
    });
    return advance ? advance.moves.length : 0;
  });
  // A bot can stop early when the puzzle is already solved, but a stronger
  // profile never plays FEWER due moves than a slower one in the same window.
  fiveSeconds.forEach((count, index) => {
    assert.ok(count >= 1, `${PUZZLE_AI_BOT_IDS[index]} never moved`);
    assert.ok(count <= movesInFiveSeconds[index]);
  });
  assert.ok(fiveSeconds[5] >= fiveSeconds[0]);

  // Every bot's moves are stamped on the server clock, spaced by its own pace.
  const advance = planPuzzleAiSeat({ snapshot: session, nowMs: 5_000 });
  assert.ok(advance);
  advance.moves.forEach((move, index) => {
    assert.equal(move.atMs, (index + 1) * 560);
    assert.ok(move.atMs <= 5_000);
  });
});

// ── 4. Practice-only, server-driven match ─────────────────────────────────

const isSqlExpression = (value) =>
  Boolean(value) && typeof value === "object" && "queryChunks" in value;

function createFakeDb() {
  const state = { tables: new Map(), nextId: 1, lock: Promise.resolve(), nowMs: NOW, ratingRows: [] };

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
      for (const row of rows) {
        for (const [key, value] of Object.entries(values)) {
          row[key] = isSqlExpression(value) ? (Number(row[key]) || 0) + 1 : value;
        }
      }
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
      returning: () => Promise.resolve(applied ?? apply()),
      then: (resolve, reject) => Promise.resolve(applied ?? apply()).then(resolve, reject),
    };
    return b;
  };

  const insert = (table) => ({
    values: (v) => {
      const seq = state.nextId++;
      const row = {
        id:
          table === solitairePuzzleSessions
            ? `77777777-7777-4777-8777-${String(seq).padStart(12, "0")}`
            : `row-${seq}`,
        createdAt: new Date(state.nowMs),
        ...structuredClone(v),
      };
      if (table === solitairePuzzleSessionMoves) {
        const key = `${row.sessionId}|${row.seat}|${row.ply}`;
        if (rowsOf(table).some((r) => `${r.sessionId}|${r.seat}|${r.ply}` === key)) {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
      }
      rowsOf(table).push(row);
      const out = { returning: () => Promise.resolve([structuredClone(row)]) };
      out.then = (resolve, reject) => Promise.resolve([structuredClone(row)]).then(resolve, reject);
      return out;
    },
  });

  const execute = async (query) => {
    const text = (() => {
      try {
        return JSON.stringify(query?.queryChunks ?? "");
      } catch {
        return "";
      }
    })();
    if (text.includes("rating_events")) return { rows: state.ratingRows };
    if (text.includes("trophy_events")) return { rows: [] };
    return { rows: [] };
  };

  const tx = { select, update, insert, execute };
  const reset = () => {
    state.tables.clear();
    state.nextId = 1;
    state.lock = Promise.resolve();
    state.nowMs = NOW;
    state.ratingRows = [];
  };

  return {
    state,
    reset,
    rowsOf,
    db: {
      select,
      update,
      insert,
      execute,
      transaction: (fn) => {
        const run = async () => {
          const backup = new Map(
            [...state.tables].map(([table, rows]) => [table, rows.map((row) => structuredClone(row))]),
          );
          try {
            return await fn(tx);
          } catch (error) {
            state.tables.clear();
            for (const [table, rows] of backup) state.tables.set(table, rows);
            throw error;
          }
        };
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
const settlement = { rating: [], trophy: [] };

function installMocks(t) {
  if (!sharedFake) sharedFake = createFakeDb();
  const fake = sharedFake;
  fake.reset();
  settlement.rating.length = 0;
  settlement.trophy.length = 0;

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
  return fake;
}

const loadStore = () => import("../src/lib/solitaire-puzzle/serverStore.ts");

async function solveAsHuman(store, sessionId, puzzle, nowMs) {
  let ply = 0;
  let last = null;
  for (const move of puzzle.spec.solutions[0]) {
    last = await store.submitPuzzleMove({
      userId: ALICE,
      sessionId,
      move,
      expectedPly: ply,
      nowMs,
    });
    assert.equal("error" in last, false, last.error);
    ply += 1;
  }
  return last;
}

test("practice: the bot plays on server reads and can win the race", { skip: SKIP_REASON }, async (t) => {
  const fake = installMocks(t);
  const store = await loadStore();

  const session = await store.createPuzzlePracticeSession({
    userId: ALICE,
    botId: "perfect",
    manifest: manifestFromIds([SAMPLE.id]),
    nowMs: NOW,
  });

  assert.equal(session.mode, "ai");
  assert.equal(session.isAi, true);
  assert.equal(session.player2Id, SOLITAIRE_PUZZLE_AI_PLAYER_ID);
  assert.equal(session.aiDifficulty, "perfect");
  assert.equal(session.deadlineAtMs, null, "practice is untimed");

  // No move is due at t=0.
  const fresh = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: session.id,
    nowMs: NOW,
  });
  assert.equal(fresh.view.opponentSolvedCount, 0);
  assert.equal(fake.rowsOf(solitairePuzzleSessionMoves).length, 0);

  const delay = puzzleAiPaceMs("perfect");
  let now = NOW;
  let read = fresh;
  for (let step = 0; step < 40; step += 1) {
    now += delay;
    read = await store.fetchPuzzleSession({ userId: ALICE, sessionId: session.id, nowMs: now });
    if (read.view.status === PUZZLE_SESSION_STATUS.FINISHED) break;
  }

  assert.equal(read.view.status, PUZZLE_SESSION_STATUS.FINISHED);
  assert.equal(read.view.result.result, "player2");
  assert.equal(read.view.result.player2.solved, 1);
  assert.equal(read.view.result.player1.solved, 0);
  assert.equal(read.view.result.resolutionReason, "finish");

  const row = fake.rowsOf(solitairePuzzleSessions)[0];
  assert.equal(row.winnerId, SOLITAIRE_PUZZLE_AI_PLAYER_ID);
  assert.ok(fake.rowsOf(solitairePuzzleSessionMoves).length >= 2, "the bot's moves are logged");
  assert.equal(settlement.rating.length, 0, "practice never rates");
  assert.equal(settlement.trophy.length, 0, "practice never awards trophies");
});

test("practice: the human can win, and a finished race is never replayed", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const session = await store.createPuzzlePracticeSession({
    userId: ALICE,
    botId: "rookie",
    manifest: manifestFromIds([SAMPLE.id]),
    nowMs: NOW,
  });

  const last = await solveAsHuman(store, session.id, SAMPLE, NOW + 1);
  assert.equal(last.finished, true);
  assert.equal(last.view.result.result, "player1");
  assert.equal(last.view.status, PUZZLE_SESSION_STATUS.FINISHED);

  // A late read cannot resurrect the race or let the bot overtake.
  const later = await store.fetchPuzzleSession({
    userId: ALICE,
    sessionId: session.id,
    nowMs: NOW + 60_000,
  });
  assert.equal(later.view.result.result, "player1");
  assert.equal(later.view.result.player2.solved, 0);
  assert.equal(settlement.rating.length, 0);
});

test("practice: no ranked history row, no rating and no trophy", { skip: SKIP_REASON }, async (t) => {
  installMocks(t);
  const store = await loadStore();

  const session = await store.createPuzzlePracticeSession({
    userId: ALICE,
    botId: "ace",
    manifest: manifestFromIds([SAMPLE.id]),
    nowMs: NOW,
  });
  await solveAsHuman(store, session.id, SAMPLE, NOW + 1);

  const history = await store.listPuzzleRankedHistory({ userId: ALICE, nowMs: NOW + 2 });
  assert.deepEqual(history, [], "practice must never appear as a competitive match");

  assert.equal(settlement.rating.length, 0);
  assert.equal(settlement.trophy.length, 0);
});

test("ties: equal solves and equal instants are a draw, not a winner", () => {
  const entry = manifestFromIds([SAMPLE.id])[0];
  const seat = createSeatSnapshot(entry);
  const snapshot = {
    id: "session",
    mode: "ai",
    status: PUZZLE_SESSION_STATUS.PLAYING,
    player1Id: ALICE,
    player2Id: SOLITAIRE_PUZZLE_AI_PLAYER_ID,
    isAi: true,
    aiDifficulty: "perfect",
    manifest: [entry],
    puzzleCount: 1,
    selectionSeed: "seed",
    selectionHash: "hash",
    p1: { ...seat, solved: 1, finishedAtMs: 10_000, lastSolveAtMs: 10_000 },
    p2: { ...seat, solved: 1, finishedAtMs: 10_000, lastSolveAtMs: 10_000 },
    goAtMs: 0,
    deadlineAtMs: null,
    endedAtMs: null,
    result: null,
    winnerId: null,
    resolutionReason: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };

  const outcome = resolvePuzzleOutcome(snapshot, 10_000);
  assert.equal(outcome.result, "draw");
  assert.equal(outcome.winnerId, null);
  assert.equal(outcome.reason, "finish");
});

// ── 5. The normal Solitaire AI is untouched ───────────────────────────────

test("isolation: the puzzle solver is additive, not a fork of the duel AI", () => {
  const puzzleAi = fs.readFileSync("src/lib/solitaire-puzzle/ai.ts", "utf8");
  assert.doesNotMatch(puzzleAi, /Math\.random\s*\(/, "puzzle decisions must be deterministic");
  assert.doesNotMatch(puzzleAi, /from "\.\.\/solitaire-duel\/puzzleLibraryData"/);
  assert.doesNotMatch(puzzleAi, /nextStockCard/);
  assert.doesNotMatch(puzzleAi, /solitaireDuelMatches|solitaire_duel_matches/);

  // The profiles it reads are the shipped duel profiles, unchanged.
  assert.equal(SOLITAIRE_BOT_BY_ID.rookie.ai.moveDelayMs, 2_600);
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.ai.moveDelayMs, 560);
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.ai.blunderRate, 0);
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.ai.mistakeRate, 0);

  // The solver sees the same visible board a human sees.
  const entry = manifestFromIds([SAMPLE.id])[0];
  const signature = visiblePuzzleSignature(entry.spec.startState);
  assert.equal(signature.includes("stock"), false);
  assert.ok(signature.split("/")[0].includes("?") || signature.includes("?"));
});
