import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuickQueueReadiness } from "../src/lib/quickQueueReadiness.ts";
import fs from "node:fs";

const route = fs.readFileSync("src/app/api/quick-queue/readiness/route.ts", "utf8");
const migration = fs.readFileSync("src/db/migrations/0110_platform_quick_queue_readiness.sql", "utf8");

test("normalizes platform readiness to supported unique games", () => {
  const readiness = normalizeQuickQueueReadiness({
    userId: " user-1 ",
    preferredGames: ["mines-pvp", "invalid", "mines-pvp"],
    preferredModes: [" pvp ", "pvp"],
    playerCount: 2,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.deepEqual(readiness.preferredGames, ["mines-pvp"]);
  assert.deepEqual(readiness.preferredModes, ["pvp"]);
  assert.equal(readiness.userId, "user-1");
});

test("rejects invalid platform readiness", () => {
  assert.throws(() => normalizeQuickQueueReadiness({ userId: "u", preferredGames: [], playerCount: 2 }));
  assert.throws(() => normalizeQuickQueueReadiness({ userId: "u", playerCount: 0 }));
  assert.throws(() => normalizeQuickQueueReadiness({ userId: "u", playerCount: 2, expiresAt: "yesterday" }));
});

test("readiness migration enforces one active record per user", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS quick_queue_readiness_active_user_idx/);
  assert.match(migration, /WHERE status = 'ready'/);
});

test("readiness API is authenticated and feature-flagged", () => {
  assert.match(route, /await auth\(\)/);
  assert.match(route, /QUICK_QUEUE_ENABLED/);
  assert.match(route, /export async function DELETE/);
});
