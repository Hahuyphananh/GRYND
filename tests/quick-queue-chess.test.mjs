import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const adapter = fs.readFileSync("src/lib/quickQueueChess.ts", "utf8");
const createRoute = fs.readFileSync("src/app/api/chess/create-game/route.js", "utf8");
const joinRoute = fs.readFileSync("src/app/api/chess/join-game/route.js", "utf8");
const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");

test("Chess adapter preserves native two-seat and timer setup", () => {
  assert.match(adapter, /chessGames/);
  assert.match(adapter, /playerWhiteId/);
  assert.match(adapter, /playerBlackId/);
  assert.match(adapter, /initialTimeSeconds/);
  assert.match(adapter, /status: "in_progress"/);
  assert.match(createRoute, /playerWhiteId/);
  assert.match(joinRoute, /playerBlackId/);
});

test("Chess is registered without modifying native routes", () => {
  assert.match(queue, /"chess"/);
  assert.match(worker, /createOrJoinChessDestination/);
  assert.match(ui, /\["chess", "Chess"\]/);
  assert.match(ui, /casino\/chess-game/);
});
