/**
 * quick-queue-speed-typing.test.mjs
 *
 * Speed Typing's quick-queue wiring. Speed Typing is a LOBBY-STYLE destination
 * (`createOrJoin` returns the same waiting-lobby id for both paired players),
 * so the adapter is the store function itself — there is no separate
 * quickQueueSpeedTyping module to keep in sync, exactly like Mini Golf.
 *
 * This file proves the three things "quick queue accepts speed-typing" means:
 *   1. the KEY is in the platform's one queue key list,
 *   2. the MATCHER actually pairs two speed-typing requests (behavioural, not
 *      a source grep),
 *   3. the worker can CREATE the destination — unstaked, with no wager path.
 *
 * Run:  node --import tsx --test tests/quick-queue-speed-typing.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  QUICK_QUEUE_GAME_KEYS,
  findCompatibleQuickQueuePair,
  normalizeQuickQueueRequest,
} from "../src/lib/quickQueue.ts";
import { normalizeQuickQueueReadiness } from "../src/lib/quickQueueReadiness.ts";
import { quickQueueGameRoute } from "../src/components/lobby/PlatformQuickQueue.jsx";

const KEY = "speed-typing";

const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
const queue = fs.readFileSync("src/lib/quickQueue.ts", "utf8");
const ui = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const store = fs.readFileSync("src/lib/speed-typing/serverStore.ts", "utf8");

// ── 1. The key is registered ─────────────────────────────────────────────

test("speed-typing is a supported quick-queue game key", () => {
  assert.ok(QUICK_QUEUE_GAME_KEYS.includes(KEY));
  // The list is the ONLY queue key list — the game must not add a second.
  assert.match(queue, /"speed-typing",/);
  assert.equal(QUICK_QUEUE_GAME_KEYS.filter((key) => key === KEY).length, 1);
});

test("readiness accepts a speed-typing-only selection", () => {
  const readiness = normalizeQuickQueueReadiness({
    userId: "user_1",
    preferredGames: [KEY],
  });
  assert.deepEqual(readiness.preferredGames, [KEY]);
  // And a request naming it normalizes through unchanged.
  const request = normalizeQuickQueueRequest({
    userId: "user_1",
    preferredGames: [KEY],
    playerCount: 2,
  });
  assert.deepEqual(request.preferredGames, [KEY]);
});

// ── 2. The matcher actually pairs two speed-typing requests ──────────────

/** A queue entry shaped exactly as `claimQuickQueueAssignment` builds them. */
function queued({ requestId, userId, queuedAt, trophies = null, ratings = null }) {
  return {
    ...normalizeQuickQueueRequest({
      userId,
      preferredGames: [KEY],
      playerCount: 2,
    }),
    requestId,
    queuedAt,
    trophies,
    ratings,
    row: {},
  };
}

test("matcher: two players queued for speed-typing are paired", () => {
  const now = 1_700_000_000_000;
  const pair = findCompatibleQuickQueuePair(
    [
      queued({ requestId: "a", userId: "user_a", queuedAt: now - 4_000 }),
      queued({ requestId: "b", userId: "user_b", queuedAt: now - 2_000 }),
    ],
    now,
  );

  assert.ok(pair, "the queue must be able to pair a speed-typing request");
  assert.equal(pair.candidate.gameKey, KEY);
  assert.deepEqual(
    [pair.source.userId, pair.partner.userId].sort(),
    ["user_a", "user_b"],
  );
});

test("matcher: a speed-typing request never pairs with another game", () => {
  const now = 1_700_000_000_000;
  const other = {
    ...normalizeQuickQueueRequest({
      userId: "user_b",
      preferredGames: ["chess"],
      playerCount: 2,
    }),
    requestId: "b",
    queuedAt: now - 2_000,
    trophies: null,
    ratings: null,
    row: {},
  };

  const pair = findCompatibleQuickQueuePair(
    [queued({ requestId: "a", userId: "user_a", queuedAt: now - 4_000 }), other],
    now,
  );
  assert.equal(pair, null, "the games' key lists must both have to contain the key");
});

test("matcher: skill windows apply to speed-typing like every other game", () => {
  const now = 1_700_000_000_000;
  // A 5,000-trophy gap (and a 400-Elo gap) is far outside the opening window,
  // so the pair must be refused while both are fresh in the queue…
  const far = findCompatibleQuickQueuePair(
    [
      queued({
        requestId: "a",
        userId: "user_a",
        queuedAt: now - 1_000,
        trophies: { [KEY]: 0 },
        ratings: { [KEY]: 1000 },
      }),
      queued({
        requestId: "b",
        userId: "user_b",
        queuedAt: now - 1_000,
        trophies: { [KEY]: 5_000 },
        ratings: { [KEY]: 1400 },
      }),
    ],
    now,
  );
  assert.equal(far, null);

  // …and accepted once the window has widened with waiting time, so nobody is
  // starved by a thin ladder. (Trophy window: 200 + 60/s; Elo: 100 + 30/s.)
  const waited = findCompatibleQuickQueuePair(
    [
      queued({
        requestId: "a",
        userId: "user_a",
        queuedAt: now - 180_000,
        trophies: { [KEY]: 0 },
        ratings: { [KEY]: 1000 },
      }),
      queued({
        requestId: "b",
        userId: "user_b",
        queuedAt: now - 180_000,
        trophies: { [KEY]: 5_000 },
        ratings: { [KEY]: 1400 },
      }),
    ],
    now,
  );
  assert.ok(waited, "a long wait must widen the window for speed-typing too");
  assert.equal(waited.candidate.gameKey, KEY);
});

// ── 3. The worker can create the destination ─────────────────────────────

test("the worker registers the speed-typing destination and creates it unstaked", () => {
  assert.match(worker, /createOrJoinSpeedTypingMatch/);
  assert.match(worker, /from "\.\/speed-typing\/serverStore"/);
  assert.match(
    worker,
    /"speed-typing": \(userId\) => createOrJoinSpeedTypingMatch\(\{ userId \}\)/,
  );
  // Speed Typing moves no tokens, so the queue's normalized stake is never
  // passed — and therefore can never be debited or paid out.
  assert.doesNotMatch(worker, /createOrJoinSpeedTypingMatch\(\{[^}]*stake/);
  assert.doesNotMatch(worker, /createOrJoinSpeedTypingMatch\(\{[^}]*wager/);
});

test("the destination is Speed Typing's own create-or-join lobby", () => {
  assert.match(store, /export async function createOrJoin\(\{ userId \}/);
  // The same row is returned for both seats: A finds nothing open and creates
  // the waiting lobby, B joins it. The worker asserts the two ids match.
  assert.match(store, /isNull\(speedTypingMatches\.player2Id\)/);
  assert.match(store, /return await joinExistingMatch\(tx, open\.id, userId\)/);
  assert.match(store, /if \(open\.player1Id === userId\) return \{ match: open, joined: false \}/);
});

test("the destination feeds the canonical queue lifecycle like every queue game", () => {
  assert.match(store, /canonicalQueueLifecycle/);
  assert.match(store, /gameKey: GAME_KEY,/);
  assert.match(store, /mirrorQueueCreated\(\{/);
  assert.match(store, /mirrorQueueTransition\(\{/);
  assert.match(store, /GAME_KEY/);
});

// ── 4. The queue UI offers it and routes to its match page ───────────────

test("the queue UI offers Speed Typing and routes to its match page", () => {
  assert.match(ui, /\["speed-typing", "Speed Typing"\]/);
  assert.match(ui, /"speed-typing": "\/casino\/speed-typing"/);
  assert.equal(
    quickQueueGameRoute(KEY, "11111111-1111-4111-8111-111111111111"),
    "/casino/speed-typing/11111111-1111-4111-8111-111111111111",
  );
  assert.equal(quickQueueGameRoute(KEY, ""), null);
});

test("the queue UI's option list and the key list stay the same shape", () => {
  // Every option the UI offers must be a real queue key, so the UI can never
  // advertise a game the queue does not recognize (or vice versa).
  const options = [...ui.matchAll(/^\s*\["([a-z0-9-]+)", "/gm)].map((m) => m[1]);
  assert.ok(options.includes(KEY));
  for (const option of options) {
    assert.ok(
      QUICK_QUEUE_GAME_KEYS.includes(option),
      `the quick-queue UI offers "${option}", which is not in QUICK_QUEUE_GAME_KEYS`,
    );
  }
});
