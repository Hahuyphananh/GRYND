import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const schema = fs.readFileSync("src/db/schema.ts", "utf8");
const migration = fs.readFileSync("src/db/migrations/0104_match_lifecycle.sql", "utf8");
const outboxMigration = fs.readFileSync("src/db/migrations/0105_match_lifecycle_events.sql", "utf8");

for (const field of [
  "queued_at",
  "started_at",
  "ended_at",
  "status",
  "cancel_reason",
  "player_count",
  "mode",
  "queue_wait_ms",
]) {
  test(`persists canonical lifecycle field ${field}`, () => {
    assert.match(migration, new RegExp(`\\b${field}\\b`));
  });
}

test("defines the Drizzle match lifecycle table", () => {
  assert.match(schema, /export const matchLifecycle = pgTable\(/);
  assert.match(schema, /"match_lifecycle"/);
});

test("defines the durable lifecycle event outbox", () => {
  assert.match(outboxMigration, /CREATE TABLE IF NOT EXISTS match_lifecycle_events/);
  assert.match(outboxMigration, /event_id uuid PRIMARY KEY/);
  assert.match(outboxMigration, /published_at timestamp/);
  assert.match(outboxMigration, /attempts integer NOT NULL DEFAULT 0/);
});

test("protects lifecycle timing and numeric invariants", () => {
  assert.match(migration, /player_count_nonnegative/);
  assert.match(migration, /queue_wait_nonnegative/);
  assert.match(migration, /match_lifecycle_time_order/);
});
