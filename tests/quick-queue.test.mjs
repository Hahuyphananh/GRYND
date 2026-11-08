import test from "node:test";
import assert from "node:assert/strict";
import { findCompatibleQuickQueueCandidate, normalizeQuickQueueRequest } from "../src/lib/quickQueue.ts";

// Quick Queue is retired from the public Solitaire-first product: its panel is
// hidden and src/proxy.ts closes its APIs. The matcher itself is preserved for
// future reactivation, and these tests keep its normalization/ordering rules
// covered.

test("normalizes a Quick Queue request", () => {
  const request = normalizeQuickQueueRequest({ userId: " user-1 ", preferredGames: ["mines-pvp", "invalid", "mines-pvp"], preferredModes: [" pvp "], playerCount: 2, region: "eu", maxWaitMs: 5000 });
  assert.deepEqual(request.preferredGames, ["mines-pvp"]);
  assert.deepEqual(request.preferredModes, ["pvp"]);
  assert.equal(request.region, "eu");
});

test("rejects invalid Quick Queue constraints", () => {
  assert.throws(() => normalizeQuickQueueRequest({ userId: "u", preferredGames: [], playerCount: 2 }));
  assert.throws(() => normalizeQuickQueueRequest({ userId: "u", playerCount: 0 }));
  assert.throws(() => normalizeQuickQueueRequest({ userId: "u", playerCount: 2, maxWaitMs: 0 }));
});

test("selects the first compatible preferred game and ignores unavailable candidates", () => {
  const request = normalizeQuickQueueRequest({ userId: "u", preferredGames: ["four-in-a-row", "mines-pvp"], preferredModes: ["pvp"], playerCount: 2, maxWaitMs: 1000 });
  const result = findCompatibleQuickQueueCandidate(request, [
    { gameKey: "mines-pvp", mode: "pvp", region: "eu", playerCount: 2, queuedAt: 999500, available: false },
    { gameKey: "four-in-a-row", mode: "pvp", region: "eu", playerCount: 2, queuedAt: 999900, available: true },
    { gameKey: "mines-pvp", mode: "pvp", region: "eu", playerCount: 2, queuedAt: 998000, available: true },
  ], 1000000);
  assert.equal(result?.queuedAt, 999900);
});

test("a request is never matched with itself", () => {
  const request = normalizeQuickQueueRequest({ userId: "u", preferredGames: ["mines-pvp"], playerCount: 2 });
  assert.equal(
    findCompatibleQuickQueueCandidate(request, [{ ...request, gameKey: "mines-pvp", mode: "pvp", queuedAt: 1, available: true }], 10),
    null,
  );
});
