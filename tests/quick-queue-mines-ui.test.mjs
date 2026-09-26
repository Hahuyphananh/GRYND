import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const mines = fs.readFileSync("src/app/casino/mines-pvp/PageClient.tsx", "utf8");
const lobby = fs.readFileSync("src/components/lobby/PvpLobby.jsx", "utf8");
const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Mines lobby exposes Quick Queue mine controls", () => {
  // Stakes are retired — the queue no longer asks for a stake, only mines.
  assert.doesNotMatch(mines, /Quick Queue stake/);
  assert.match(mines, /Quick Queue mines/);
  assert.match(mines, /quickQueuePreferences/);
});

test("Mines lobby sends preferences to readiness", () => {
  assert.match(mines, /minesStakeAmount: 0/);
  assert.match(mines, /minesCount/);
  assert.match(lobby, /quickQueueReadinessBody/);
  assert.match(controller, /JSON\.stringify\(\{ \.\.\.readinessBody, preferredGames \}\)/);
});
