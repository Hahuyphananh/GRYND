import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const lobby = fs.readFileSync("src/components/lobby/PvpLobby.jsx", "utf8");

test("Ready UI shows the selected game summary", () => {
  assert.match(controller, /Monitoring \{preferredGames\.length\}/);
  assert.match(controller, /QUICK_QUEUE_GAME_OPTIONS\.filter/);
});

test("Ready cannot be enabled with no selected games", () => {
  assert.match(controller, /Select at least one game for Quick Queue/);
  assert.match(controller, /emptySelection: preferredGames\.length === 0/);
  assert.match(lobby, /quickQueue\.emptySelection/);
});
