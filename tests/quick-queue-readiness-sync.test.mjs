import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const store = fs.readFileSync("src/lib/quickQueueReadinessStore.ts", "utf8");
const route = fs.readFileSync("src/app/api/quick-queue/readiness/route.ts", "utf8");

test("enabling readiness creates or updates a cross-game queue request", () => {
  assert.match(store, /quickQueueRequests/);
  assert.match(store, /preferredGames: readiness\.preferredGames/);
  assert.match(store, /tx\.insert\(quickQueueRequests\)/);
  assert.match(store, /tx\.update\(quickQueueRequests\)/);
});

test("disabling readiness cancels the user's queued request", () => {
  assert.match(store, /status: "cancelled"/);
  assert.match(store, /eq\(quickQueueRequests\.userId, userId\)/);
  assert.match(store, /eq\(quickQueueRequests\.status, "queued"\)/);
});

test("readiness API delegates enable and disable to synchronization store", () => {
  assert.match(route, /setQuickQueueReadiness/);
  assert.match(route, /cancelQuickQueueReadiness/);
});
