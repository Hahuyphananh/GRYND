import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync("src/db/migrations/0109_quick_queue_assignment_events.sql", "utf8");
const publisher = fs.readFileSync("src/lib/quickQueueAssignmentEvents.ts", "utf8");
const route = fs.readFileSync("src/app/api/quick-queue/publish/route.ts", "utf8");

test("assignment event migration is durable and retryable", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS quick_queue_assignment_events/);
  assert.match(migration, /published_at timestamp/);
  assert.match(migration, /attempts integer NOT NULL DEFAULT 0/);
});

test("assignment publisher uses bounded skip-locked delivery", () => {
  assert.match(publisher, /skipLocked: true/);
  assert.match(publisher, /Math\.min\(batchSize, 500\)/);
  assert.match(publisher, /attempts: row\.attempts \+ 1/);
});

test("publication is secret-protected and targets private user rooms", () => {
  assert.match(route, /x-internal-secret/);
  assert.match(route, /quick-queue:user:/);
  assert.doesNotMatch(route, /broadcast/);
});
