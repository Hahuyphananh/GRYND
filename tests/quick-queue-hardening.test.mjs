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
