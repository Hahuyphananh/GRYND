import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueFourInARow.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Four-In-A-Row adapter uses native game storage and join semantics", () => {
  assert.match(adapter, /fourInARowGames/);
  assert.match(adapter, /guestClerkId/);
  assert.match(adapter, /status: \"in_progress\"/);
});

test("Four-In-A-Row is a selectable Quick Queue game", () => {
  assert.match(queue, /"four-in-a-row"/);
  assert.match(worker, /createOrJoinFourInARowDestination/);
  assert.match(ui, /Four-In-A-Row/);
  assert.match(ui, /casino\/four-in-a-row\/game/);
});
