/**
 * quick-queue-tic-tac-toe.test.mjs
 *
 * Tic-Tac-Toe Duel's platform Quick Queue wiring.
 *
 * Tic-Tac-Toe is a lobby-style destination (`createOrJoin` returns the SAME
 * waiting-lobby id for both paired players), so the adapter is the store
 * function itself — there is no separate `quickQueueTicTacToe` module to keep
 * in sync, exactly like Mini Golf and Speed Typing. Unlike those two it plays
 * for coins, so the queue's normalized stake IS handed down: both paired seats
 * are matched at it and escrowed when the second one joins.
 *
 * Run:  npm run test:tic-tac-toe
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { QUICK_QUEUE_GAME_KEYS } from "../src/lib/quickQueue.ts";
import { normalizeQuickQueueReadiness } from "../src/lib/quickQueueReadiness.ts";
import { quickQueueGameRoute } from "../src/components/lobby/PlatformQuickQueue.jsx";

const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const store = fs.readFileSync("src/lib/tic-tac-toe/serverStore.ts", "utf8");

test("tic-tac-toe is a supported quick-queue game key, exactly once", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes("tic-tac-toe"));
  assert.match(queue, /"tic-tac-toe"/);
  assert.equal(
    QUICK_QUEUE_GAME_KEYS.filter((key) => key === "tic-tac-toe").length,
    1,
    "the key must not be duplicated in the queue vocabulary",
  );
});

test("the worker registers the tic-tac-toe destination and matches it at the queue's stake", () => {
  assert.match(worker, /createOrJoinTicTacToeMatch/);
  assert.match(worker, /from "\.\/tic-tac-toe\/serverStore"/);
  // Staked: the destination is created at the queue's normalized stake, so the
  // pair plays for coins like every other ranked duel.
  assert.match(
    worker,
    /"tic-tac-toe": \(userId\) =>\s*\n?\s*createOrJoinTicTacToeMatch\(\{ userId, stakeAmount: sourceStake \}\)/,
  );
});

test("the destination is Tic-Tac-Toe's own create-or-join lobby", () => {
  assert.match(store, /export async function createOrJoin\(\{\s*\n?\s*userId,\s*\n?\s*stakeAmount,/);
  // Both paired players must land on the SAME destination id, which is what the
  // worker asserts; createOrJoin joins the oldest waiting lobby AT THE STAKE
  // ASKED FOR (the caller's stake is part of the candidate match).
  assert.match(store, /isNull\(ticTacToeMatches\.player2Id\)/);
  assert.match(store, /eq\(ticTacToeMatches\.stakeAmount, stakeAmount\.toFixed\(2\)\)/);
  assert.match(store, /return await joinExistingMatch\(tx, open\.id, userId, stakeAmount\)/);
});

test("the queue UI offers Tic-Tac-Toe and routes to its match page", () => {
  assert.match(ui, /\["tic-tac-toe", "Ultimate Tic-Tac-Toe"\]/);
  assert.match(ui, /"tic-tac-toe": "\/casino\/tic-tac-toe"/);
  assert.equal(quickQueueGameRoute("tic-tac-toe", "abc-123"), "/casino/tic-tac-toe/abc-123");
  assert.equal(quickQueueGameRoute("tic-tac-toe", ""), null);
});

test("readiness accepts a tic-tac-toe-only selection", () => {
  const readiness = normalizeQuickQueueReadiness({
    userId: "user_1",
    preferredGames: ["tic-tac-toe"],
  });
  assert.deepEqual(readiness.preferredGames, ["tic-tac-toe"]);
});
