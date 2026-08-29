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
  assert.match(adapter, /precisionLobbyStore/);
  assert.match(adapter, /precisionMatchStore/);
  assert.match(adapter, /makeInitialMatch/);
  assert.match(adapter, /ready_up/);
  assert.match(matchmaking, /makeInitialMatch/);
  assert.match(store, /armMatchRound/);
  assert.match(createRoute, /tryAutoMatch/);
  assert.match(joinRoute, /markPlayerReady|makeInitialMatch/);
});

test("Precision is registered without changing its multiplayer routes", () => {
  assert.match(queue, /"precision"/);
  assert.match(worker, /createOrJoinPrecisionDestination/);
  assert.match(ui, /\["precision", "Precision"\]/);
  assert.match(ui, /casino\/precision\/game/);
});
