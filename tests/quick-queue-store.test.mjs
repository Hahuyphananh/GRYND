import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const store = fs.readFileSync("src/lib/quickQueueStore.ts", "utf8");
const route = fs.readFileSync("src/app/api/quick-queue/route.ts", "utf8");
const migration = fs.readFileSync("src/db/migrations/0107_quick_queue_requests.sql", "utf8");

test("Quick Queue persistence has active and cancellation state", () => {
  assert.match(migration, /status varchar\(20\) NOT NULL DEFAULT 'queued'/);
  assert.match(migration, /cancelled_at timestamp/);
  assert.match(migration, /quick_queue_requests_active_idx/);
});

test("Quick Queue store prevents duplicate active requests", () => {
  assert.match(store, /eq\(quickQueueRequests\.status, "queued"\)/);
  assert.match(store, /if \(existing\) return existing/);
});

test("Quick Queue cancellation is ownership-scoped", () => {
  assert.match(store, /eq\(quickQueueRequests\.id, requestId\)/);
  assert.match(store, /eq\(quickQueueRequests\.userId, userId\)/);
  assert.match(store, /status: "cancelled"/);
});

test("Quick Queue APIs are authenticated and feature-flagged", () => {
  assert.match(route, /await auth\(\)/);
  assert.match(route, /QUICK_QUEUE_ENABLED/);
  assert.match(route, /export async function DELETE/);
});
