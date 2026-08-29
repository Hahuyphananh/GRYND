import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueRps.ts", "utf8");
const createRoute = fs.readFileSync("src/app/api/rps/pvp/create/route.js", "utf8");
const joinRoute = fs.readFileSync("src/app/api/rps/pvp/join/route.js", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("RPS adapter preserves native wagered create and match flow", () => {
  assert.match(adapter, /rpsPvpGames/);
  assert.match(adapter, /player2Id/);
  assert.match(adapter, /status: "matched"/);
  assert.match(createRoute, /player1Id/);
  assert.match(joinRoute, /player2Id/);
});

test("RPS is registered with its match route", () => {
  assert.match(queue, /"rps-pvp"/);
  assert.match(worker, /createOrJoinRpsDestination/);
  assert.match(ui, /\["rps-pvp", "RPS"\]/);
  assert.match(ui, /casino\/rps\/game/);
});
