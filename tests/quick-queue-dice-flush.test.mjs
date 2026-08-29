import assert from "node:assert/strict";
import { test } from "node:test";
import { QUICK_QUEUE_GAME_KEYS } from "../src/lib/quickQueue.ts";
import { readFileSync } from "node:fs";

test("Dice Flush is a supported Quick Queue destination", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes("dice-flush"));
});

test("Dice Flush adapter uses native room tables and state APIs without changing routes", () => {
  const adapter = readFileSync("src/lib/quickQueueDiceFlush.ts", "utf8");
  const createRoute = readFileSync("src/app/api/dice-flush/create/route.js", "utf8");
  const joinRoute = readFileSync("src/app/api/dice-flush/join/route.js", "utf8");
  assert.match(adapter, /diceFlushRooms/);
  assert.match(adapter, /diceFlushPlayers/);
  assert.match(adapter, /initialState/);
  assert.match(createRoute, /diceFlushRooms/);
  assert.match(joinRoute, /diceFlushPlayers/);
});
