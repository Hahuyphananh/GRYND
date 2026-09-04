// tests/recently-played.test.mjs
//
// Unit tests for src/lib/recentlyPlayed.js — the sessionStorage-backed
// "Recently played" tracking behind the casino lobby strip (UX plan P1-1).
//
// The module is browser-oriented (guards on `window`/`sessionStorage`), so
// we install a minimal sessionStorage stub BEFORE importing it, mirroring
// how tests/creator-recorder.test.mjs stubs MediaRecorder etc.

import test from "node:test";
import assert from "node:assert/strict";

// --- Browser stubs (installed before importing the module) ---
const store = new Map();

globalThis.window = {
  sessionStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
};

const {
  recordPlayedGame,
  getPlayedGames,
  clearPlayedGames,
} = await import("../src/lib/recentlyPlayed.js");

test("starts empty", () => {
  assert.deepEqual(getPlayedGames(), []);
});

test("records plays newest-first", () => {
  recordPlayedGame("plinko-duel");
  recordPlayedGame("roulette");
  recordPlayedGame("chess");
  assert.deepEqual(getPlayedGames(), ["chess", "roulette", "plinko-duel"]);
});

test("replaying a game moves it to the front without duplicating", () => {
  recordPlayedGame("plinko-duel");
  assert.deepEqual(getPlayedGames(), ["plinko-duel", "chess", "roulette"]);
});

test("caps the list at 10 entries", () => {
  for (let i = 0; i < 12; i++) recordPlayedGame(`game-${i}`);
  const list = getPlayedGames();
  assert.equal(list.length, 10);
  // Newest first: game-11 … game-2
  assert.equal(list[0], "game-11");
  assert.equal(list[9], "game-2");
  assert.ok(!list.includes("game-1"));
});

test("ignores empty / non-string labels", () => {
  recordPlayedGame("");
  recordPlayedGame(null);
  recordPlayedGame(undefined);
  recordPlayedGame(42);
  // List unchanged: still the capped 10 from the previous test.
  assert.equal(getPlayedGames().length, 10);
});

test("clearPlayedGames empties the list", () => {
  clearPlayedGames();
  assert.deepEqual(getPlayedGames(), []);
});

test("tolerates a sessionStorage that throws (private mode)", async () => {
  const broken = new Map();
  globalThis.window.sessionStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  // Should not throw and should not record anything.
  recordPlayedGame("keno");
  assert.deepEqual(getPlayedGames(), []);
  // Restore for any later tests in this file.
  globalThis.window.sessionStorage = {
    getItem: (key) => (broken.has(key) ? broken.get(key) : null),
    setItem: (key, value) => broken.set(key, String(value)),
    removeItem: (key) => broken.delete(key),
  };
});