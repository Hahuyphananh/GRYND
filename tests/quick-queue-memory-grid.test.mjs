import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueMemoryGrid.ts", "utf8");
const store = fs.readFileSync("src/lib/memory-grid/serverStore.js", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Memory Grid adapter delegates to native createOrJoin", () => {
  assert.match(adapter, /memory-grid\/serverStore/);
  assert.match(adapter, /createOrJoin\(\{ userId, stakeAmount: stake \}\)/);
  assert.match(store, /pg_advisory_xact_lock/);
  assert.match(store, /player2Id/);
});

test("Memory Grid is registered with its native destination route", () => {
  assert.match(queue, /"memory-grid"/);
  assert.match(worker, /createOrJoinMemoryGridDestination/);
  assert.match(ui, /Memory Grid/);
  assert.match(ui, /casino\/memory-grid/);
});
