import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const lobby = fs.readFileSync("src/components/lobby/PvpLobby.jsx", "utf8");
const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("shared lobby exposes a platform-wide Ready control", () => {
  assert.match(lobby, /quickQueue = null/);
  assert.match(lobby, /Platform Quick Queue/);
  assert.match(lobby, /I’m Ready/);
  assert.match(lobby, /aria-pressed/);
});

test("Ready controller uses the readiness API", () => {
  assert.match(controller, /\/api\/quick-queue\/readiness/);
  assert.match(controller, /method: ready \? "DELETE" : "POST"/);
});

test("manual open-lobby joining remains available", () => {
  assert.match(lobby, /Open Lobbies/);
  assert.match(lobby, /onJoin\(l\)/);
});
