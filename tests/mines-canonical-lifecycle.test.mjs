import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const store = fs.readFileSync("src/lib/mines-pvp/serverStore.js", "utf8");
const adapter = fs.readFileSync("src/lib/mines-pvp/canonicalLifecycle.js", "utf8");

test("Mines canonical adapter is non-blocking", () => {
  assert.match(adapter, /void promise\.catch/);
  assert.match(adapter, /gameKey: "mines-pvp"/);
});

test("Mines queue creation and joining mirror lifecycle state", () => {
  assert.match(store, /mirrorMinesQueued\(/);
  assert.match(store, /playerCount: 1/);
  assert.match(store, /playerCount: 2/);
});

test("Mines cancellation and completion mirror terminal states", () => {
  assert.match(store, /status: "cancelled"/);
  assert.match(store, /cancelReason: "user_cancelled"/);
  assert.match(store, /status: "completed"/);
});
