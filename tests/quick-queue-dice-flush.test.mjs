// tests/quick-queue-dice-flush.test.mjs
//
// Contract guard for the Dice Flush → Barricade cutover in the platform Quick
// Queue.
//
// This file used to assert the OPPOSITE of what it asserts now: that Dice Flush
// WAS a supported Quick Queue destination and that its adapter used the native
// room tables. That is retired public behaviour, so the assertions are inverted
// rather than deleted — a retired game must be provably absent from matchmaking,
// not merely unlinked from it.
//
// Dice Flush's own rooms, tables, API routes and engine are deliberately
// PRESERVED (this cutover is a catalogue change, not a data deletion), so the
// retired adapter file still exists on disk; what must be gone is every path
// that could put a player into it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { QUICK_QUEUE_GAME_KEYS } from "../src/lib/quickQueue.ts";

const WORKER = "src/lib/quickQueueWorker.ts";

test("Dice Flush is no longer a Quick Queue destination", () => {
  assert.ok(!QUICK_QUEUE_GAME_KEYS.includes("dice-flush"));
});

test("Barricade owns the destination Dice Flush vacated", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes("barricade"));
});

test("the worker never dispatches to the retired Dice Flush adapter", () => {
  const worker = readFileSync(WORKER, "utf8");
  // No import, no destination entry, no partner-dispatch branch.
  assert.doesNotMatch(worker, /quickQueueDiceFlush/);
  assert.doesNotMatch(worker, /createOrJoinDiceFlushDestination/);
  assert.doesNotMatch(worker, /"dice-flush"\s*:/);
});

test("a pair is only matched on a game both players queued for", () => {
  const queue = readFileSync("src/lib/quickQueue.ts", "utf8");
  // A candidate must be queued for a game the requester also asked for…
  assert.match(queue, /if \(!request\.preferredGames\.includes\(candidate\.gameKey\)\) return false;/);
  // …and the game the pair is created for is the intersection of the two
  // preference sets, which is why a retired key can never be paired with a live
  // one (it cannot enter either set: validation filters on
  // QUICK_QUEUE_GAME_KEYS, which no longer contains it).
  assert.match(queue, /source\.preferredGames[\s\S]{0,160}candidate\.preferredGames\.includes\(gameKey\)/);
});

test("the retired adapter is kept on disk, not deleted", () => {
  const adapter = readFileSync("src/lib/quickQueueDiceFlush.ts", "utf8");
  const createRoute = readFileSync("src/app/api/dice-flush/create/route.js", "utf8");
  const joinRoute = readFileSync("src/app/api/dice-flush/join/route.js", "utf8");
  assert.match(adapter, /diceFlushRooms/);
  assert.match(adapter, /diceFlushPlayers/);
  assert.match(createRoute, /diceFlushRooms/);
  assert.match(joinRoute, /diceFlushPlayers/);
});
