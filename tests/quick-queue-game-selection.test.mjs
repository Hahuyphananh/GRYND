import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const lobby = fs.readFileSync("src/components/lobby/PvpLobby.jsx", "utf8");

test("platform Ready exposes all supported game choices", () => {
  assert.match(controller, /QUICK_QUEUE_GAME_OPTIONS/);
  assert.match(controller, /Keno/);
  assert.match(controller, /Mines/);
  assert.match(controller, /Plinko/);
  assert.match(controller, /Blackjack/);
  assert.match(controller, /Roulette/);
  assert.match(controller, /Lane Rush/);
});

test("game choices are toggleable and sent to readiness", () => {
  assert.match(controller, /toggleGame/);
  assert.match(controller, /aria-pressed=\{selected\}/);
  assert.match(controller, /preferredGames/);
});

test("shared lobby renders Quick Queue preferences", () => {
  assert.match(lobby, /quickQueue\.preferences/);
});
