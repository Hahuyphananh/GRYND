import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const matchmaking = fs.readFileSync("src/lib/precision/matchmaking.ts", "utf8");
const serverStore = fs.readFileSync("src/lib/precision/serverStore.ts", "utf8");
const joinRoute = fs.readFileSync("src/app/api/precision/join-lobby/route.ts", "utf8");
const resignRoute = fs.readFileSync("src/app/api/precision/resign/route.ts", "utf8");

test("Precision has an isolated non-blocking canonical lifecycle adapter", () => {
  const adapter = fs.readFileSync("src/lib/precision/canonicalLifecycle.ts", "utf8");
  assert.match(adapter, /catch\(\(error\) =>/);
  assert.match(adapter, /mirrorPrecisionQueued/);
  assert.match(adapter, /mirrorPrecisionTransition/);
});

test("Precision queue creation mirrors queued lifecycle state", () => {
  assert.match(matchmaking, /mirrorPrecisionQueued\(/);
  assert.match(joinRoute, /mirrorPrecisionQueued\(/);
});

test("Precision terminal flows mirror canonical terminal state", () => {
  assert.match(serverStore, /status: "completed"/);
  assert.match(resignRoute, /status: "cancelled"/);
  assert.match(resignRoute, /cancelReason: "user_cancelled"/);
});
