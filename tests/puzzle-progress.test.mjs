/**
 * STRATEGIC PUZZLE PROGRESSION — local records, filtering and the daily pick.
 *
 * What this pins:
 *   * a record survives a "refresh" (write, then read through a fresh call);
 *   * guests and signed-in accounts cannot see each other's puzzles;
 *   * an attempt never erases a completion, and a worse replay never replaces
 *     the best line (fewest moves, then fewest hints);
 *   * a spec-version change reports "updated" and requires a replay, while the
 *     attempt history is preserved;
 *   * corrupt payloads and ids no longer in the library are discarded;
 *   * category / difficulty / status filters select the right puzzles;
 *   * "Next challenge" skips recently opened and completed puzzles;
 *   * the daily pick is the same for one UTC date, different across consecutive
 *     days, and cycles all puzzles before repeating;
 *   * the daily puzzle opens on a masked view.
 *
 * Run: node --import tsx --test tests/puzzle-progress.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { puzzleLibraryPuzzles } from "../src/lib/solitaire-duel/puzzleLibrary.ts";
import { toPlayerPuzzle } from "../src/lib/solitaire-duel/puzzlePlayerData.ts";
import { PUZZLE_PLAYER_TRANSLATIONS } from "../src/lib/puzzlePlayerTranslations.js";
import { createPuzzleSession } from "../src/lib/solitaire-duel/puzzleSession.ts";
import {
  PUZZLE_PROGRESS_STORAGE_PREFIX,
  completedPuzzleCount,
  dailyPuzzleForDate,
  dailyPuzzleIndex,
  emptyPuzzleProgress,
  filterPuzzles,
  parsePuzzleProgress,
  puzzleDayKey,
  puzzleProgressStorageKey,
  puzzleStatus,
  readPuzzleProgress,
  recordPuzzleCompletion,
  recordPuzzleStart,
  recommendedPuzzle,
  writePuzzleProgress,
} from "../src/lib/solitaire-duel/puzzleProgress.ts";

const LIBRARY = puzzleLibraryPuzzles();
const KNOWN_IDS = LIBRARY.map((puzzle) => puzzle.id);
const [FIRST, SECOND, THIRD] = LIBRARY;
const DAY_MS = 86_400_000;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

function started(puzzle, state = emptyPuzzleProgress(), now = 1000) {
  return recordPuzzleStart(state, { id: puzzle.id, version: puzzle.spec.version }, now);
}

function completed(puzzle, state, moves, hints, now = 2000) {
  return recordPuzzleCompletion(
    state,
    { id: puzzle.id, version: puzzle.spec.version, moves, hints },
    now,
  );
}

test("a completed record survives a refresh", () => {
  const store = memoryStorage();
  let state = started(FIRST);
  state = completed(FIRST, state, 4, 1);
  writePuzzleProgress(store, "guest", state);

  // A refresh reads the same storage again.
  const reopened = readPuzzleProgress(store, "guest", KNOWN_IDS);
  assert.equal(puzzleStatus(reopened, FIRST), "completed");
  assert.equal(reopened.puzzles[FIRST.id].bestMoves, 4);
  assert.equal(reopened.puzzles[FIRST.id].bestHints, 1);
  assert.equal(reopened.puzzles[FIRST.id].attempts, 1);
  assert.equal(reopened.lastPuzzleId, FIRST.id);
  assert.deepEqual(reopened.recentIds, [FIRST.id]);
  assert.deepEqual(store.keys(), [puzzleProgressStorageKey("guest")]);
});

test("guests and signed-in players are isolated", () => {
  const store = memoryStorage();
  writePuzzleProgress(store, "guest", completed(FIRST, started(FIRST), 3, 0));

  assert.equal(puzzleStatus(readPuzzleProgress(store, "guest", KNOWN_IDS), FIRST), "completed");
  assert.equal(puzzleStatus(readPuzzleProgress(store, "user_123", KNOWN_IDS), FIRST), "new");
  assert.equal(puzzleProgressStorageKey(null), `${PUZZLE_PROGRESS_STORAGE_PREFIX}:guest`);
  assert.equal(
    puzzleProgressStorageKey("user_123"),
    `${PUZZLE_PROGRESS_STORAGE_PREFIX}:user_123`,
  );
});

test("an attempt does not erase a completion", () => {
  let state = completed(FIRST, started(FIRST), 5, 2);
  state = started(FIRST, state, 3000);

  assert.equal(puzzleStatus(state, FIRST), "completed");
  assert.equal(state.puzzles[FIRST.id].attempts, 2);
  assert.equal(state.puzzles[FIRST.id].bestMoves, 5);
});

test("the best line is fewest moves, then fewest hints", () => {
  let state = completed(FIRST, started(FIRST), 4, 1);

  // Worse: more moves.
  state = completed(FIRST, started(FIRST, state), 6, 0, 3000);
  assert.equal(state.puzzles[FIRST.id].bestMoves, 4);
  assert.equal(state.puzzles[FIRST.id].bestHints, 1);

  // Same moves, fewer hints wins.
  state = completed(FIRST, started(FIRST, state), 4, 0, 4000);
  assert.equal(state.puzzles[FIRST.id].bestHints, 0);

  // Better: fewer moves wins.
  state = completed(FIRST, started(FIRST, state), 3, 3, 5000);
  assert.equal(state.puzzles[FIRST.id].bestMoves, 3);
  assert.equal(state.puzzles[FIRST.id].bestHints, 3);
});

test("a revised puzzle reports updated and needs a replay", () => {
  let state = completed(FIRST, started(FIRST), 4, 1);
  const revised = { id: FIRST.id, spec: { version: FIRST.spec.version + 1 } };

  assert.equal(puzzleStatus(state, revised), "updated");

  // Opening it again does not silently count the old completion.
  state = started(revised, state, 3000);
  assert.equal(puzzleStatus(state, revised), "updated");
  assert.equal(state.puzzles[FIRST.id].attempts, 2);

  // Completing the new version replaces the best line and keeps attempts.
  state = recordPuzzleCompletion(
    state,
    { id: FIRST.id, version: revised.spec.version, moves: 7, hints: 0 },
    4000,
  );
  assert.equal(puzzleStatus(state, revised), "completed");
  assert.equal(state.puzzles[FIRST.id].bestMoves, 7);
  assert.equal(state.puzzles[FIRST.id].version, revised.spec.version);
  assert.equal(state.puzzles[FIRST.id].attempts, 2);
});

test("corrupt payloads and unknown ids are discarded", () => {
  assert.deepEqual(parsePuzzleProgress("{not json"), emptyPuzzleProgress());
  assert.deepEqual(parsePuzzleProgress(null), emptyPuzzleProgress());

  const raw = JSON.stringify({
    puzzles: {
      "library:v1:does-not-exist": { version: 1, completed: true, attempts: 9 },
      [FIRST.id]: { version: 1, completed: true, bestMoves: -3, bestHints: -1, attempts: 2 },
    },
    lastPuzzleId: "library:v1:does-not-exist",
    recentIds: ["library:v1:does-not-exist", FIRST.id],
    updatedAt: 5,
  });
  const parsed = parsePuzzleProgress(raw, KNOWN_IDS);
  assert.deepEqual(Object.keys(parsed.puzzles), [FIRST.id]);
  assert.equal(parsed.puzzles[FIRST.id].bestMoves, null);
  assert.equal(parsed.puzzles[FIRST.id].bestHints, null);
  assert.equal(parsed.lastPuzzleId, null);
  assert.deepEqual(parsed.recentIds, [FIRST.id]);
});

test("category, difficulty and status filters select the right puzzles", () => {
  const state = completed(FIRST, started(FIRST), 3, 0);

  const tableau = filterPuzzles(LIBRARY, { category: "tableau" }, state);
  assert.ok(tableau.length > 0);
  assert.ok(tableau.every((puzzle) => puzzle.category === "tableau"));

  const advanced = filterPuzzles(LIBRARY, { level: 3 }, state);
  assert.ok(advanced.length > 0);
  assert.ok(advanced.every((puzzle) => puzzle.levelNumber === 3));

  const done = filterPuzzles(LIBRARY, { status: "completed" }, state);
  assert.deepEqual(done.map((puzzle) => puzzle.id), [FIRST.id]);

  const unfinished = filterPuzzles(LIBRARY, { status: "unfinished" }, state);
  assert.equal(unfinished.length, LIBRARY.length - 1);
  assert.equal(unfinished.some((puzzle) => puzzle.id === FIRST.id), false);
});

test("next challenge skips completed and recently opened puzzles", () => {
  let state = completed(FIRST, started(FIRST), 3, 0);
  state = started(SECOND, state, 3000);

  const next = recommendedPuzzle(LIBRARY, state);
  assert.ok(next);
  assert.notEqual(next.id, FIRST.id);
  assert.notEqual(next.id, SECOND.id);
  assert.ok(!state.recentIds.includes(next.id));

  // With everything completed, it still returns a puzzle to replay.
  let allDone = emptyPuzzleProgress();
  for (const puzzle of LIBRARY) {
    allDone = completed(puzzle, started(puzzle, allDone), 3, 0);
  }
  assert.ok(recommendedPuzzle(LIBRARY, allDone));
});

test("the daily pick is deterministic per UTC date and cycles without repeats", () => {
  const dateKey = "2026-11-22";
  const first = dailyPuzzleForDate(LIBRARY, dateKey);
  const second = dailyPuzzleForDate(LIBRARY, dateKey);
  assert.equal(first.id, second.id);

  // A whole cycle visits every puzzle exactly once.
  const base = Date.UTC(2026, 0, 1);
  const seen = new Set();
  for (let day = 0; day < LIBRARY.length; day += 1) {
    const key = new Date(base + day * DAY_MS).toISOString().slice(0, 10);
    seen.add(dailyPuzzleIndex(key, LIBRARY.length));
  }
  assert.equal(seen.size, LIBRARY.length);

  // Consecutive days differ, including across a month boundary.
  assert.notEqual(
    dailyPuzzleIndex("2026-01-31", LIBRARY.length),
    dailyPuzzleIndex("2026-02-01", LIBRARY.length),
  );
});

test("the day key is UTC, not local time", () => {
  assert.equal(puzzleDayKey(new Date("2026-11-22T00:00:00Z")), "2026-11-22");
  assert.equal(puzzleDayKey(new Date("2026-11-22T23:59:59Z")), "2026-11-22");
  assert.equal(puzzleDayKey(new Date("2026-11-23T00:00:00Z")), "2026-11-23");
});

test("the daily puzzle opens on a masked view", () => {
  const puzzle = dailyPuzzleForDate(LIBRARY, "2026-11-22");
  assert.ok(puzzle);
  const session = createPuzzleSession(puzzle.spec);
  assert.equal(session.view.nextStockCard, null);
  assert.equal(JSON.stringify(session.view).includes("startState"), false);
});

test("storage failures degrade to empty or in-memory progress", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(readPuzzleProgress(throwing, "guest", KNOWN_IDS), emptyPuzzleProgress());
  assert.doesNotThrow(() => writePuzzleProgress(throwing, "guest", emptyPuzzleProgress()));
  assert.equal(readPuzzleProgress(null, "guest", KNOWN_IDS).puzzles !== undefined, true);
});

test("the library browser copy resolves in all three locales", () => {
  const keys = [
    "library.title",
    "library.summary",
    "library.continue",
    "library.next",
    "library.daily",
    "library.dailyNote",
    "library.playDaily",
    "library.categoryLabel",
    "library.levelLabel",
    "library.statusLabel",
    "library.allCategories",
    "library.allLevels",
    "library.allStatuses",
    "library.unfinished",
    "library.completedFilter",
    "library.empty",
    "library.attempts",
    "library.best",
    "library.bestHints",
    "library.replay",
    "library.newBadge",
    "library.inProgressBadge",
    "library.completedBadge",
    "library.updatedBadge",
    "library.dailyBadge",
    "complete.best",
  ];

  const readPath = (source, path) =>
    path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), source);

  for (const locale of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = readPath(PUZZLE_PLAYER_TRANSLATIONS[locale], key);
      assert.equal(typeof value, "string", `${locale} is missing puzzlePlayer.${key}`);
    }
  }
});

test("the player payload contains no accepted solution paths", () => {
  const player = toPlayerPuzzle(FIRST);

  assert.equal("solutions" in player.spec, false);
  assert.equal(JSON.stringify(player).includes('"solutions"'), false);
  assert.equal(JSON.stringify(player).includes('"verification"'), false);
  assert.equal(JSON.stringify(player).includes('"tableau-to-tableau"'), false);
  assert.equal(player.par, FIRST.spec.solutions[0].length);
  assert.equal(player.solutionCount, FIRST.spec.solutions.length);
  assert.deepEqual(player.spec.startState, FIRST.spec.startState);
  assert.deepEqual(player.spec.objective, FIRST.spec.objective);
});

test("the completion count only counts current-version completions", () => {
  const state = completed(FIRST, started(FIRST), 3, 0);
  assert.equal(completedPuzzleCount(LIBRARY, state), 1);
  assert.equal(completedPuzzleCount([THIRD], state), 0);

  const revised = [{ ...FIRST, spec: { ...FIRST.spec, version: FIRST.spec.version + 1 } }];
  assert.equal(completedPuzzleCount(revised, state), 0);
});
