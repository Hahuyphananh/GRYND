import test from "node:test";
import assert from "node:assert/strict";
import { quickQueueGameRoute } from "../src/components/lobby/PlatformQuickQueue.jsx";
import fs from "node:fs";

const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const migration = fs.readFileSync("src/db/migrations/0111_quick_queue_assignment_destination.sql", "utf8");
const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("assignment schema carries explicit destination metadata", () => {
  assert.match(migration, /destination_match_id/);
  assert.match(worker, /destinationMatchId/);
  assert.match(worker, /createOrJoinMinesMatch/);
  assert.match(worker, /destinationMatchId = String\(result\.match\.id\)/);
});

test("navigation requires a valid destination match id", () => {
  assert.equal(quickQueueGameRoute("mines-pvp", "match-1"), "/casino/mines-pvp/match-1");
  assert.equal(quickQueueGameRoute("mines-pvp", ""), null);
  assert.equal(quickQueueGameRoute("unknown", "match-1"), null);
  assert.match(controller, /destinationMatchId/);
});
