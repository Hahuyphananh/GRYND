import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueHexDuel.ts", "utf8");
const createRoute = fs.readFileSync("src/app/api/hex-duel/multiplayer/create/route.ts", "utf8");
const joinRoute = fs.readFileSync("src/app/api/hex-duel/multiplayer/join/route.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Hex Duel adapter preserves native player, turn, and action cursor state", () => {
  assert.match(adapter, /hexDuelGames/);
  assert.match(adapter, /player2Id/);
  assert.match(adapter, /currentTurn: "player1"/);
  assert.match(adapter, /lastActionSeq: 0/);
  assert.match(createRoute, /status: "waiting"/);
  assert.match(joinRoute, /currentTurn: "player1"/);
});

test("Hex Duel is registered without modifying native multiplayer routes", () => {
  assert.match(queue, /"hex-duel"/);
  assert.match(worker, /createOrJoinHexDuelDestination/);
  assert.match(ui, /\["hex-duel", "Hex Duel"\]/);
  assert.match(ui, /casino\/hex-duel\/game/);
});
