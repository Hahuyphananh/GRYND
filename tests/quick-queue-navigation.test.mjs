import test from "node:test";
import assert from "node:assert/strict";
import { quickQueueGameRoute } from "../src/components/lobby/PlatformQuickQueue.jsx";
import fs from "node:fs";

const source = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("maps supported assignment games to lobby routes", () => {
  assert.equal(quickQueueGameRoute("mines-pvp", "123"), "/casino/mines-pvp/123");
  assert.equal(quickQueueGameRoute("plinko-pvp", "abc"), "/casino/plinko/abc");
  assert.equal(quickQueueGameRoute("unknown", "123"), null);
});

test("assignment events navigate while availability alerts remain notifications", () => {
  assert.match(source, /router\.push\(route\)/);
  assert.match(source, /quick_queue:ready/);
  assert.match(source, /quick-queue:availability/);
});
