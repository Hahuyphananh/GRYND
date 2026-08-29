import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuickQueueReadiness } from "../src/lib/quickQueueReadiness.ts";
import fs from "node:fs";

const store = fs.readFileSync("src/lib/quickQueueReadinessStore.ts", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const migration = fs.readFileSync("src/db/migrations/0112_quick_queue_mines_preferences.sql", "utf8");

test("normalizes valid Mines Quick Queue preferences", () => {
  const result = normalizeQuickQueueReadiness({ userId: "u", preferredGames: ["mines-pvp"], minesStakeAmount: 25, minesCount: 5 });
  assert.equal(result.minesStakeAmount, 25);
  assert.equal(result.minesCount, 5);
});

test("rejects invalid Mines preferences", () => {
  assert.throws(() => normalizeQuickQueueReadiness({ userId: "u", preferredGames: ["mines-pvp"], minesStakeAmount: 0 }));
  assert.throws(() => normalizeQuickQueueReadiness({ userId: "u", preferredGames: ["mines-pvp"], minesCount: 25 }));
});

test("persists Mines preferences and uses them for destination creation", () => {
  assert.match(migration, /mines_stake_amount/);
  assert.match(migration, /mines_count/);
  assert.match(store, /minesStakeAmount/);
  assert.match(worker, /pair\.source\.row\?\.minesStakeAmount/);
  assert.match(worker, /pair\.source\.row\?\.minesCount/);
});
