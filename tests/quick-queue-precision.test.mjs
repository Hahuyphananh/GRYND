import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueuePrecision.ts", "utf8");
const matchmaking = fs.readFileSync("src/lib/precision/matchmaking.ts", "utf8");
const store = fs.readFileSync("src/lib/precision/serverStore.ts", "utf8");
const createRoute = fs.readFileSync("src/app/api/precision/create-lobby/route.ts", "utf8");
const joinRoute = fs.readFileSync("src/app/api/precision/join-lobby/route.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Precision adapter preserves native ready-up match lifecycle", () => {
  // The adapter now pairs through the DB-backed matchmaker instead of walking
  // a process-local Map, but the destination contract is unchanged: both calls
  // must resolve to the SAME lobby/match id (the worker asserts it).
  assert.match(adapter, /tryAutoMatch/);
  assert.match(adapter, /match: \{ id: result\.gameId \}/);
  assert.match(matchmaking, /makeInitialMatch/);
  assert.match(matchmaking, /export async function tryAutoMatch/);
  assert.match(store, /ready_up/);
  assert.match(store, /export async function createMatchForPairing/);
  assert.match(store, /const allReady =/);
  assert.match(createRoute, /tryAutoMatch/);
  assert.match(joinRoute, /joinLobbyById/);
});

test("Precision is registered without changing its multiplayer routes", () => {
  assert.match(queue, /"precision"/);
  assert.match(worker, /createOrJoinPrecisionDestination/);
  assert.match(ui, /\["precision", "Precision"\]/);
  assert.match(ui, /casino\/precision\/game/);
});
