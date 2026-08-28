import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/api/quick-queue/preview/route.ts", "utf8");

test("Quick Queue preview is authenticated and feature-flagged", () => {
  assert.match(source, /await auth\(\)/);
  assert.match(source, /QUICK_QUEUE_PREVIEW_ENABLED/);
  assert.match(source, /preview is disabled/);
});

test("Quick Queue preview is read-only", () => {
  assert.match(source, /\.select\(/);
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /transitionMatchLifecycle/);
  assert.match(source, /joined: false/);
});
