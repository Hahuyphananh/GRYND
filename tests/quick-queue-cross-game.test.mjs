import test from "node:test";
import assert from "node:assert/strict";
import { findCompatibleQuickQueuePair, normalizeQuickQueueRequest } from "../src/lib/quickQueue.ts";

test("finds a shared game across two platform-ready requests", () => {
  const pair = findCompatibleQuickQueuePair([
    { ...normalizeQuickQueueRequest({ userId: "u1", preferredGames: ["mines-pvp", "plinko-pvp"], playerCount: 2 }), requestId: "r1", queuedAt: 999000 },
    { ...normalizeQuickQueueRequest({ userId: "u2", preferredGames: ["plinko-pvp"], playerCount: 2 }), requestId: "r2", queuedAt: 999500 },
  ], 1000000);
  assert.equal(pair?.candidate.gameKey, "plinko-pvp");
  assert.deepEqual([pair?.source.requestId, pair?.partner.requestId], ["r1", "r2"]);
});

test("does not match a request with itself", () => {
  const request = { ...normalizeQuickQueueRequest({ userId: "u1", preferredGames: ["mines-pvp"], playerCount: 2 }), requestId: "r1", queuedAt: 999000 };
  assert.equal(findCompatibleQuickQueuePair([request], 1000000), null);
});
