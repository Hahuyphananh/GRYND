import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const relay = fs.readFileSync("src/lib/matchLifecycleRelay.ts", "utf8");
const realtime = fs.readFileSync("realtime-server/server.js", "utf8");

test("lifecycle relay targets a canonical match room", () => {
  assert.match(relay, /match:lifecycle:\$\{event\.matchId\}/);
  assert.match(relay, /event: "match:lifecycle"/);
  assert.match(relay, /AbortSignal\.timeout\(3000\)/);
});

test("lifecycle relay forwards stable event identity", () => {
  assert.match(relay, /event_id: event\.eventId/);
  assert.match(relay, /match_id: event\.matchId/);
  assert.match(relay, /event_type: event\.eventType/);
});

test("realtime server validates lifecycle room scope", () => {
  assert.match(realtime, /eventName === "match:lifecycle"/);
  assert.match(realtime, /match:lifecycle:/);
  assert.match(realtime, /REALTIME_INTERNAL_SECRET/);
});
