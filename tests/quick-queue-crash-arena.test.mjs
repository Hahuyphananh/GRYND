import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { QUICK_QUEUE_GAME_KEYS } from "../src/lib/quickQueue.ts";

test("Crash Arena is a supported Quick Queue destination", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes("crash-arena"));
});

test("Crash Arena adapter preserves native table, seat, and transaction flow", () => {
  const adapter = readFileSync("src/lib/quickQueueCrashArena.ts", "utf8");
  const createRoute = readFileSync("src/app/api/crash-arena/create/route.ts", "utf8");
  const joinRoute = readFileSync("src/app/api/crash-arena/join/route.ts", "utf8");
  assert.match(adapter, /crashArenaTables/);
  assert.match(adapter, /crashArenaPlayers/);
  assert.match(adapter, /crashArenaTransactions/);
  assert.match(adapter, /status: "seated"/);
  assert.match(createRoute, /broadcastTableUpdate/);
  assert.match(joinRoute, /CRASH_MAX_BUYIN/);
});
