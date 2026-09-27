/**
 * quick-queue-mini-golf.test.mjs
 *
 * Mini Golf's quick-queue wiring. Mini Golf is a lobby-style destination
 * (`createOrJoin` returns the same waiting-lobby id for both paired players),
 * so the adapter is the store function itself — there is no separate
 * quickQueueMiniGolf module to keep in sync.
 *
 * Run:  node --import tsx --test tests/quick-queue-mini-golf.test.mjs
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
const store = fs.readFileSync("src/lib/mini-golf/serverStore.ts", "utf8");

test("mini-golf is a supported quick-queue game key", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes("mini-golf"));
  assert.match(queue, /"mini-golf"/);
});

test("the worker registers the mini-golf destination and creates it unstaked", () => {
  assert.match(worker, /createOrJoinMiniGolfMatch/);
  assert.match(worker, /from "\.\/mini-golf\/serverStore"/);
  assert.match(worker, /"mini-golf": \(userId\) => createOrJoinMiniGolfMatch\(\{ userId \}\)/);
  // Mini Golf moves no tokens, so the queue's normalized stake is never passed.
  assert.doesNotMatch(worker, /createOrJoinMiniGolfMatch\(\{[^}]*stake/);
});

test("the destination is Mini Golf's own create-or-join lobby", () => {
  assert.match(store, /export async function createOrJoin\(\{ userId \}/);
  // Both paired players must land on the SAME destination id, which is what
  // the worker asserts; createOrJoin joins the oldest waiting lobby.
  assert.match(store, /isNull\(miniGolfMatches\.player2Id\)/);
  assert.match(store, /return await joinExistingMatch\(tx, open\.id, userId\)/);
});

test("the queue UI offers Mini Golf and routes to its match page", () => {
  assert.match(ui, /\["mini-golf", "Mini Golf"\]/);
  assert.match(ui, /"mini-golf": "\/casino\/mini-golf"/);
  assert.equal(quickQueueGameRoute("mini-golf", "abc-123"), "/casino/mini-golf/abc-123");
  assert.equal(quickQueueGameRoute("mini-golf", ""), null);
});

test("readiness accepts a mini-golf-only selection", () => {
  const readiness = normalizeQuickQueueReadiness({
    userId: "user_1",
    preferredGames: ["mini-golf"],
  });
  assert.deepEqual(readiness.preferredGames, ["mini-golf"]);
});
