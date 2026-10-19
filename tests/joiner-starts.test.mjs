// tests/joiner-starts.test.mjs
//
// WHO OPENS A PVP MATCH.
//
// Barrier Blitz established the product rule: the joining seat (player2 /
// purple / guest) opens. The seat-based board games now follow it:
//
//   • Hex Duel      — join route + quick queue write currentTurn: "player2"
//   • Four in a Row — ready transition + rematch write currentTurn: "guest"
//   • Dots & Boxes  — the join writes a guest-first opening gameState
//   • Chess         — the join swaps the seat columns so the joiner is White
//                     (White still moves first; it just belongs to the joiner)
//
// Games with their own opening rule are deliberately excluded:
//
//   • Mini-Golf alternates the tee by hole, so no seat owns the opening hole.
//   • Tic-Tac-Toe, Uno, Pool Masters, Tower Arena and Dice Flush already roll
//     the opening seat/colour.
//
// Run: node --import tsx --test tests/joiner-starts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("Hex Duel: both PvP entry points open with player2", () => {
  const join = read("src/app/api/hex-duel/multiplayer/join/route.ts");
  const quickQueue = read("src/lib/quickQueueHexDuel.ts");
  assert.match(join, /currentTurn: "player2"/);
  assert.doesNotMatch(join, /currentTurn: "player1"/);
  assert.match(quickQueue, /currentTurn: "player2"/);
  assert.doesNotMatch(quickQueue, /currentTurn: "player1"/);
});

test("Hex Duel: the spectator payload reads the authoritative turn, not the legacy status", () => {
  const spectate = read("src/app/api/hex-duel/multiplayer/spectate/route.ts");
  assert.match(spectate, /currentTurn: hexDuelGames\.currentTurn/);
  assert.match(spectate, /game\.currentTurn \?\?/);
});

test("Hex Duel: the local engine opens on the server's seat", async () => {
  const { makeInitialCore } = await import("../src/lib/hex-duel/rules.ts");
  assert.equal(makeInitialCore().currentTurn, "player1", "AI/local default is unchanged");
  assert.equal(makeInitialCore("player2").currentTurn, "player2");

  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");
  assert.match(page, /const openingTurn: DuelPlayer = isAiMatch \? "player1" : "player2";/);
  assert.match(page, /useHexDuel\(openingTurn\)/);
});

test("Four in a Row: a fresh match and a rematch both open with the guest", () => {
  const server = read("src/lib/fourInARowServer.js");
  const replay = read("src/app/api/four-in-a-row/replay-response/route.js");
  assert.match(server, /status: "in_progress",\s*\/\/[^]*?currentTurn: "guest"/);
  assert.match(replay, /status: "in_progress",\s*\/\/[^]*?currentTurn: "guest"/);
  assert.doesNotMatch(server, /currentTurn: "host"/);
  assert.doesNotMatch(replay, /currentTurn: "host"/);
});

test("Dots & Boxes: joining writes a guest-first opening position", () => {
  const join = read("src/app/api/dots-and-boxes/join-game/route.js");
  assert.match(join, /import \{ createInitialState \} from/);
  assert.match(
    join,
    /gameState: \{ \.\.\.createInitialState\(\), currentTurn: "guest" \}/,
  );
  // Practice still starts with the human (host).
  const ai = read("src/app/api/dots-and-boxes/create-ai/route.js");
  assert.match(ai, /gameState: createInitialState\(\)/);
});

test("Chess: joining swaps the seats so the joiner is White and moves first", () => {
  const join = read("src/app/api/chess/join-game/route.js");
  const quickQueue = read("src/lib/quickQueueChess.ts");

  assert.match(join, /playerWhiteId: userId/);
  assert.match(join, /playerBlackId: game\.playerWhiteId/);
  assert.doesNotMatch(join, /playerBlackId: userId/);

  assert.match(quickQueue, /playerWhiteId: userId/);
  assert.match(quickQueue, /playerBlackId: open\.playerWhiteId/);
  assert.doesNotMatch(quickQueue, /playerBlackId: userId/);
});

test("Barrier Blitz keeps the original purple-first constant", () => {
  const constants = read("src/lib/barricade/constants.ts");
  assert.match(constants, /export const STARTING_SEAT = "player2"/);
});
