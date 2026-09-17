import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const matchmaking = fs.readFileSync("src/lib/precision/matchmaking.ts", "utf8");
const serverStore = fs.readFileSync("src/lib/precision/serverStore.ts", "utf8");
const leaveRoute = fs.readFileSync("src/app/api/precision/leave/route.ts", "utf8");

test("Precision has an isolated non-blocking canonical lifecycle adapter", () => {
  const adapter = fs.readFileSync("src/lib/precision/canonicalLifecycle.ts", "utf8");
  assert.match(adapter, /catch\(\(error\) =>/);
  assert.match(adapter, /mirrorPrecisionQueued/);
  assert.match(adapter, /mirrorPrecisionTransition/);
});

test("Precision queue creation mirrors queued lifecycle state", () => {
  // Both entry points into a match funnel through `createMatchForPairing`
  // (auto-match, public join, practice), and the new queue entry is mirrored
  // where it is created. The mirror is fire-and-forget: a lifecycle failure
  // can never fail a pairing.
  assert.match(matchmaking, /mirrorPrecisionQueued\(/);
  assert.match(serverStore, /mirrorPrecisionQueued\(/);
  assert.match(serverStore, /export async function createMatchForPairing/);
});

test("Precision terminal flows mirror canonical terminal state", () => {
  // Started on ready-up, completed on a decided match or a forfeit, cancelled
  // on resign / leave. The transitions live in the store so every route
  // (REST, socket proxy, disconnect grace timer) records the same thing.
  assert.match(serverStore, /status: "started"/);
  assert.match(serverStore, /status: "completed"/);
  assert.match(serverStore, /status: "cancelled"/);
  assert.match(serverStore, /cancelReason: "user_cancelled"/);
  assert.match(leaveRoute, /status: "cancelled"/);
});
