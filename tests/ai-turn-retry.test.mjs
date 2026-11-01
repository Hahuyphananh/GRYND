/**
 * Bounded bot-turn retries — the policy every server-backed vs-AI board shares.
 *
 * WHAT THIS PROVES
 * ----------------
 * One failed bot turn can never become an unbounded request loop (the bug the
 * chess board shipped: 27 requests in 6 s, board stuck on "AI is thinking…"),
 * and a request that never answers cannot leave the board waiting with no error.
 *
 * The policy itself is tested against the real module; the wiring is pinned per
 * page, because the failure mode was a page that asked again with no bound and
 * each glance includes a DIFFERENT key (a turn number, a disc count, a FEN).
 *
 * Run: node --import tsx --test tests/ai-turn-retry.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AI_TURN_MAX_ATTEMPTS,
  AI_TURN_RETRY_BASE_MS,
  AI_TURN_TIMEOUT_MS,
  AiTurnTimeoutError,
  createAiTurnGuard,
  fetchAiTurn,
} from "../src/lib/aiTurnRetry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("one bot turn may be requested at most AI_TURN_MAX_ATTEMPTS times", () => {
  const guard = createAiTurnGuard();
  assert.equal(guard.begin("turn-1"), true);

  const delays = [];
  for (let attempt = 0; attempt < AI_TURN_MAX_ATTEMPTS + 3; attempt += 1) {
    delays.push(guard.fail());
  }

  assert.deepEqual(delays, [
    AI_TURN_RETRY_BASE_MS,
    AI_TURN_RETRY_BASE_MS * 2,
    null,
    null,
    null,
    null,
  ]);
  assert.equal(guard.gaveUp(), true);
});

test("a turn that gave up is never asked again", () => {
  const guard = createAiTurnGuard();
  guard.begin("turn-1");
  for (let attempt = 0; attempt < AI_TURN_MAX_ATTEMPTS; attempt += 1) guard.fail();

  assert.equal(guard.begin("turn-1"), false);
});

test("a new turn starts from a clean slate", () => {
  const guard = createAiTurnGuard();
  guard.begin("turn-1");
  for (let attempt = 0; attempt < AI_TURN_MAX_ATTEMPTS; attempt += 1) guard.fail();

  assert.equal(guard.begin("turn-2"), true);
  assert.equal(guard.attempts(), 0);
  assert.equal(guard.gaveUp(), false);
});

test("a successful answer forgets the turn", () => {
  const guard = createAiTurnGuard();
  guard.begin("turn-1");
  guard.fail();
  guard.succeed();

  assert.equal(guard.currentKey(), null);
  assert.equal(guard.begin("turn-1"), true);
  assert.equal(guard.attempts(), 0);
});

test("the player's reset clears a give-up mark", () => {
  const guard = createAiTurnGuard();
  guard.begin("turn-1");
  for (let attempt = 0; attempt < AI_TURN_MAX_ATTEMPTS; attempt += 1) guard.fail();
  assert.equal(guard.begin("turn-1"), false);

  guard.reset();
  assert.equal(guard.begin("turn-1"), true);
});

test("a request that never answers is abandoned at the deadline", async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(
    () => fetchAiTurn("/api/example/ai-turn", {}, { timeoutMs: 20, fetchImpl: never }),
    (error) => {
      assert.ok(error instanceof AiTurnTimeoutError);
      assert.match(error.message, /20ms/);
      return true;
    },
  );
});

test("an answered request is returned untouched", async () => {
  const response = new Response(JSON.stringify({ success: true }), { status: 200 });
  const answered = await fetchAiTurn("/api/example/ai-turn", {}, {
    timeoutMs: 50,
    fetchImpl: async () => response,
  });
  assert.equal(answered, response);
});

test("the shipped deadline is long enough for a slow engine and still finite", () => {
  assert.ok(AI_TURN_TIMEOUT_MS >= 10_000, "a booting engine must not be cut off");
  assert.ok(Number.isFinite(AI_TURN_TIMEOUT_MS));
  assert.ok(AI_TURN_MAX_ATTEMPTS >= 2, "one flaky answer is worth one more try");
});

test("every server-backed vs-AI board asks for the bot's turn through the shared bounds", () => {
  const pages = [
    "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
    "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
    "src/app/casino/uno/game/[gameId]/PageClient.jsx",
    "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
    "src/app/casino/dice-flush/PageClient.tsx",
  ];

  for (const page of pages) {
    const body = read(page);
    assert.match(body, /lib\/aiTurnRetry/, `${page} imports the shared bounds`);
    assert.match(body, /createAiTurnGuard/, `${page} bounds its attempts`);
    assert.match(body, /fetchAiTurn\(/, `${page} puts a deadline on the request`);
    // The unbounded shape the chess board shipped: a failure simply clears the
    // "already asked" flag, so the next render asks again, forever.
    assert.doesNotMatch(
      body,
      /if \(!res\.ok\) ai(MoveKeyRef|FiredForEdges)\.current = null;/,
      `${page} does not re-arm an unbounded retry`,
    );
  }
});
