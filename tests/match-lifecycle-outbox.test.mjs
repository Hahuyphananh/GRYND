import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/lib/matchLifecycleOutbox.ts", "utf8");

test("outbox publisher claims a bounded batch with skip-locked rows", () => {
  assert.match(source, /limit\(batchSize\)/);
  assert.match(source, /for\("update", \{ skipLocked: true \}\)/);
  assert.match(source, /Math\.min\(options\.batchSize \?\? 50, 500\)/);
});

test("outbox publisher marks success and increments attempts", () => {
  assert.match(source, /publishedAt: now, attempts: row\.attempts \+ 1/);
  assert.match(source, /set\(\{ attempts: row\.attempts \+ 1 \}\)/);
});

test("outbox publisher is explicitly at-least-once", () => {
  assert.match(source, /at-least-once/);
  assert.match(source, /handler\(.*eventId/s);
});
