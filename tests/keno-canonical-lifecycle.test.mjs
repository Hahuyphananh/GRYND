import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const store = fs.readFileSync("src/lib/keno-pvp/serverStore.js", "utf8");
const adapter = fs.readFileSync("src/lib/keno-pvp/canonicalLifecycle.js", "utf8");

test("Keno lifecycle adapter is non-blocking", () => {
  assert.match(adapter, /void promise\.catch/);
  assert.match(adapter, /gameKey: "keno-pvp"/);
});

test("Keno queue creation and joining mirror canonical queue state", () => {
  assert.match(store, /mirrorKenoQueued\(/);
  assert.match(store, /playerCount: 1/);
  assert.match(store, /playerCount: 2/);
});

test("Keno cancellation and completion mirror terminal state", () => {
  assert.match(store, /status: "cancelled"/);
  assert.match(store, /cancelReason: "user_cancelled"/);
  assert.match(store, /status: "completed"/);
});
