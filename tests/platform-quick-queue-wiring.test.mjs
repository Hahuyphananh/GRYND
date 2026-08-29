import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const lobby = fs.readFileSync("src/components/lobby/PvpLobby.jsx", "utf8");

test("shared lobby page wires platform Quick Queue readiness", () => {
  assert.match(lobby, /usePlatformQuickQueue/);
  assert.match(lobby, /const quickQueue = usePlatformQuickQueue\(\)/);
  assert.match(lobby, /quickQueue=\{props\.quickQueue \?\? quickQueue\}/);
});

test("manual lobby content is still rendered", () => {
  assert.match(lobby, /<PvpLobby \{\.\.\.props\}/);
  assert.match(lobby, /Open Lobbies/);
  assert.match(lobby, /onJoin\(l\)/);
});
