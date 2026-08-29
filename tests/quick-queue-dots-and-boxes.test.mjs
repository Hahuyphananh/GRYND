import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueDotsAndBoxes.ts", "utf8");
const store = fs.readFileSync("src/lib/dotsAndBoxesServer.js", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Dots and Boxes adapter preserves native two-step lobby flow", () => {
  assert.match(adapter, /dotsAndBoxesGames/);
  assert.match(adapter, /guestClerkId/);
  assert.match(adapter, /status: "in_progress"/);
  assert.match(adapter, /moveDeadlineAt/);
  assert.match(store, /settleDotsAndBoxesGame/);
});

test("Dots and Boxes is registered with its game route", () => {
  assert.match(queue, /"dots-and-boxes"/);
  assert.match(worker, /createOrJoinDotsAndBoxesDestination/);
  assert.match(ui, /Dots & Boxes/);
  assert.match(ui, /casino\/dots-and-boxes\/game/);
});
