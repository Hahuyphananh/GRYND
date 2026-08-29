import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueUno.ts", "utf8");
const route = fs.readFileSync("src/app/api/uno/join-online/route.js", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");

test("UNO adapter preserves native multiplayer state and wager semantics", () => {
  assert.match(adapter, /unoGames/);
  assert.match(adapter, /player1Hand/);
  assert.match(adapter, /player2Hand/);
  assert.match(adapter, /discardPile/);
  assert.match(adapter, /turn/);
  assert.match(route, /mode === "create"/);
  assert.match(route, /mode === "join-specific"/);
});

test("UNO is registered with the lobby destination", () => {
  assert.match(queue, /"uno"/);
  assert.match(worker, /createOrJoinUnoDestination/);
  assert.match(ui, /\["uno", "UNO"\]/);
  assert.match(ui, /casino\/uno/);
});
