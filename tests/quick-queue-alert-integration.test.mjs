import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const publisher = fs.readFileSync("src/lib/quickQueueAssignmentEvents.ts", "utf8");
const route = fs.readFileSync("src/app/api/quick-queue/publish/route.ts", "utf8");

test("assignment publishing claims deduplicated availability deliveries", () => {
  assert.match(publisher, /availabilityAlertDeliveries/);
  assert.match(publisher, /onConflictDoNothing/);
  assert.match(publisher, /quick-queue:\$\{event\.assignmentId\}/);
});

test("assignment publishing emits a user-facing availability event", () => {
  assert.match(route, /onAssignmentAlert/);
  assert.match(route, /quick-queue:availability/);
  assert.match(route, /A compatible game is ready/);
  assert.match(route, /quick-queue:user:/);
});
