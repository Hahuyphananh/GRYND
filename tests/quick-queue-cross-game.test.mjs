import test from "node:test";
import assert from "node:assert/strict";
import { findCompatibleQuickQueuePair } from "../src/lib/quickQueue.ts";

// No public game is queueable while GRYND is Solitaire-first, so pairing is
// exercised with a synthetic available key. Archived keys are rejected at
// normalization and at candidate matching (see tests/quick-queue.test.mjs).

const request = (userId, preferredGames) => ({
  userId,
  preferredGames,
  preferredModes: ["pvp"],
  playerCount: 2,
  region: null,
  maxWaitMs: 120000,
  isGuest: false,
  rated: true,
});

test("finds a shared game across two platform-ready requests", () => {
  const pair = findCompatibleQuickQueuePair([
    { ...request("u1", ["test-a", "test-b"]), requestId: "r1", queuedAt: 999000 },
    { ...request("u2", ["test-b"]), requestId: "r2", queuedAt: 999500 },
  ], 1000000);
  assert.equal(pair?.candidate.gameKey, "test-b");
  assert.deepEqual([pair?.source.requestId, pair?.partner.requestId], ["r1", "r2"]);
});

test("does not match a request with itself", () => {
  const only = { ...request("u1", ["test-a"]), requestId: "r1", queuedAt: 999000 };
  assert.equal(findCompatibleQuickQueuePair([only], 1000000), null);
});
