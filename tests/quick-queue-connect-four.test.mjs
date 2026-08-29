import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueConnectFour.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Connect Four adapter uses native game storage and join semantics", () => {
  assert.match(adapter, /connectFourGames/);
  assert.match(adapter, /guestClerkId/);
  assert.match(adapter, /status: \"in_progress\"/);
});

test("Connect Four is a selectable Quick Queue game", () => {
  assert.match(queue, /"connect-four"/);
  assert.match(worker, /createOrJoinConnectFourDestination/);
  assert.match(ui, /Connect Four/);
  assert.match(ui, /casino\/connect-four\/game/);
});
