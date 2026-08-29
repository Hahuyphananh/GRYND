import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("worker guards destination failures and duplicate assignments", () => {
  const worker = readFileSync("src/lib/quickQueueWorker.ts", "utf8");
  assert.match(worker, /destination creation failed/);
  assert.match(worker, /destination join failed/);
  assert.match(worker, /alreadyAssigned/);
  assert.match(worker, /destinationMatchId/);
});

test("Crash Arena Quick Queue uses its table route and leaves native routes intact", () => {
  const ui = readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
  const adapter = readFileSync("src/lib/quickQueueCrashArena.ts", "utf8");
  assert.match(ui, /crash-arena.*\/casino\/crash-arena\/table/);
  assert.match(adapter, /crashArenaTransactions/);
  assert.match(adapter, /isPrivate, false/);
});
