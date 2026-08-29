import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueuePool.ts", "utf8");
const createRoute = fs.readFileSync("src/app/api/pool/create-lobby/route.ts", "utf8");
const joinRoute = fs.readFileSync("src/app/api/pool/join-lobby/route.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Pool adapter preserves lobby, player, turn, and state initialization", () => {
  assert.match(adapter, /poolLobbies/);
  assert.match(adapter, /poolMatches/);
  assert.match(adapter, /player1Id/);
  assert.match(adapter, /player2Id/);
  assert.match(adapter, /currentTurnUserId/);
  assert.match(adapter, /gameState/);
  assert.match(createRoute, /poolLobbies/);
  assert.match(joinRoute, /poolMatches/);
});

test("Pool Masters is registered without changing native routes", () => {
  assert.match(queue, /"pool-masters"/);
  assert.match(worker, /createOrJoinPoolDestination/);
  assert.match(ui, /\["pool-masters", "Pool Masters"\]/);
  assert.match(ui, /casino\/pool-masters\/game/);
});
