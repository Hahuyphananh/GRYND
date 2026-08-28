import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const route = fs.readFileSync("src/app/api/quick-queue/assign/route.ts", "utf8");
const migration = fs.readFileSync("src/db/migrations/0108_quick_queue_assignments.sql", "utf8");

test("assignment migration stores request groups and ready state", () => {
  assert.match(migration, /request_ids jsonb NOT NULL/);
  assert.match(migration, /status varchar\(20\) NOT NULL DEFAULT 'ready'/);
});

test("worker claims queued requests with skip-locked rows", () => {
  assert.match(worker, /eq\(quickQueueRequests\.status, "queued"\)/);
  assert.match(worker, /for\("update", \{ skipLocked: true \}\)/);
  assert.match(worker, /quickQueueAssignments/);
});

test("assignment endpoint is protected and does not launch games", () => {
  assert.match(route, /QUICK_QUEUE_ENABLED/);
  assert.match(route, /x-internal-secret/);
  assert.match(route, /launched: false/);
  assert.doesNotMatch(route, /launchGame|startGame/);
});
