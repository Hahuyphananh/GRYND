import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Quick Queue status panel reads assignment status", () => {
  const panel = fs.readFileSync("src/components/lobby/QuickQueueStatus.jsx", "utf8");
  assert.match(panel, /\/api\/quick-queue\/status/);
  assert.match(panel, /destinationMatchId/);
  assert.match(panel, /Waiting across your selected games/);
});

test("Ready controller refreshes status after assignment", () => {
  const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
  assert.match(controller, /statusRefreshKey/);
  assert.match(controller, /QuickQueueStatus/);
});
