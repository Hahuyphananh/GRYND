import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueDiceDuel.ts", "utf8");
const createRoute = fs.readFileSync("src/app/api/dice-duel/create-lobby/route.ts", "utf8");
const joinRoute = fs.readFileSync("src/app/api/dice-duel/join-lobby/route.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Dice Duel adapter uses native lobby and match tables", () => {
  assert.match(adapter, /diceLobbies/);
  assert.match(adapter, /diceMatches/);
  assert.match(adapter, /turnUserId/);
  assert.match(adapter, /hp1: 20/);
  assert.match(adapter, /hp2: 20/);
  assert.match(createRoute, /create-lobby/);
  assert.match(joinRoute, /join-lobby/);
});

test("Dice Duel registration does not modify native routes", () => {
  assert.match(queue, /"dice-duel"/);
  assert.match(worker, /createOrJoinDiceDuelDestination/);
  assert.match(ui, /\["dice-duel", "Dice Duel"\]/);
  assert.match(ui, /casino\/dice-duel\/game/);
});
