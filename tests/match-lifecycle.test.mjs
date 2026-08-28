import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionMatchLifecycle,
  calculateQueueWaitMs,
  createMatchLifecycleEvent,
} from "../src/lib/matchLifecycle.ts";

test("allows valid lifecycle transitions and rejects terminal transitions", () => {
  assert.equal(canTransitionMatchLifecycle("queued", "forming"), true);
  assert.equal(canTransitionMatchLifecycle("ready", "started"), true);
  assert.equal(canTransitionMatchLifecycle("completed", "started"), false);
  assert.equal(canTransitionMatchLifecycle("cancelled", "queued"), false);
});

test("calculates non-negative queue wait duration", () => {
  assert.equal(
    calculateQueueWaitMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.250Z"),
    1250,
  );
  assert.throws(() => calculateQueueWaitMs("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z"));
});

test("creates a canonical lifecycle event", () => {
  const event = createMatchLifecycleEvent(
    {
      status: "started",
      queued_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:01.000Z",
      ended_at: null,
      cancel_reason: null,
      player_count: 2,
      mode: "ranked",
      queue_wait_ms: 1000,
    },
    "match-1",
    "event-1",
    "2026-01-01T00:00:01.000Z",
  );

  assert.equal(event.event_type, "match.started");
  assert.equal(event.schema_version, 1);
  assert.equal(event.player_count, 2);
});
