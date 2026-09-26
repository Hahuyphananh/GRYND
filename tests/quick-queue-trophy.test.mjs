/**
 * quick-queue-trophy.test.mjs
 *
 * Trophy-aware matchmaking (Phase: trophies feed quick queue).
 *
 * Trophies are the primary skill signal below the 10,000 cap, so the quick
 * queue prefers a partner whose per-game trophy count is close. The acceptable
 * gap WIDENS the longer a player waits, so nobody is starved by a thin ladder,
 * and a request with no trophy data (a brand-new player, or a game with no
 * trophy track) always falls back to the original preference + FIFO matching.
 *
 * Run:  node --import tsx --test tests/quick-queue-trophy.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TROPHY_MATCH_INITIAL_WINDOW,
  TROPHY_MATCH_MAX_WINDOW,
  findCompatibleQuickQueueCandidate,
  normalizeQuickQueueRequest,
  trophiesCompatible,
  trophyForGame,
  trophyMatchWindow,
} from "../src/lib/quickQueue.ts";

// `trophies` is attached AFTER normalize (the request validator only accepts
// the queue constraints) — exactly as the worker does at claim time.
const request = ({ trophies = null, ...overrides } = {}) => ({
  ...normalizeQuickQueueRequest({
    userId: "me",
    preferredGames: ["chess"],
    playerCount: 2,
    ...overrides,
  }),
  trophies,
});

const candidate = (overrides = {}) => ({
  userId: "opp",
  gameKey: "chess",
  mode: "pvp",
  playerCount: 2,
  queuedAt: 1_000_000,
  available: true,
  ...overrides,
});

test("trophyMatchWindow starts tight and widens with wait, then caps", () => {
  assert.equal(trophyMatchWindow(0), TROPHY_MATCH_INITIAL_WINDOW);
  assert.ok(trophyMatchWindow(10_000) > TROPHY_MATCH_INITIAL_WINDOW);
  assert.equal(trophyMatchWindow(999_999_99), TROPHY_MATCH_MAX_WINDOW);
});

test("trophyForGame is null for unknown/missing data and never negative", () => {
  assert.equal(trophyForGame(null, "chess"), null);
  assert.equal(trophyForGame({}, "chess"), null);
  assert.equal(trophyForGame({ chess: "abc" }, "chess"), null);
  assert.equal(trophyForGame({ chess: -50 }, "chess"), 0);
  assert.equal(trophyForGame({ chess: 1200 }, "chess"), 1200);
});

test("trophiesCompatible: missing data on either side always passes", () => {
  assert.equal(
    trophiesCompatible({ requester: null, candidate: { chess: 9000 }, gameKey: "chess", waitMs: 0 }),
    true,
  );
  assert.equal(
    trophiesCompatible({ requester: { chess: 10 }, candidate: null, gameKey: "chess", waitMs: 0 }),
    true,
  );
});

test("trophiesCompatible: close passes now, far only once the range has grown", () => {
  const near = trophiesCompatible({
    requester: { chess: 1000 },
    candidate: { chess: 1100 },
    gameKey: "chess",
    waitMs: 0,
  });
  assert.equal(near, true);

  const farNow = trophiesCompatible({
    requester: { chess: 0 },
    candidate: { chess: 5000 },
    gameKey: "chess",
    waitMs: 0,
  });
  assert.equal(farNow, false);

  const farLater = trophiesCompatible({
    requester: { chess: 0 },
    candidate: { chess: 5000 },
    gameKey: "chess",
    waitMs: 999_999_99,
  });
  assert.equal(farLater, true);
});

test("candidate matching filters a far-away opponent when trophies are known", () => {
  const me = request({ trophies: { chess: 100 } });
  const far = candidate({ trophies: { chess: 9000 } });
  assert.equal(findCompatibleQuickQueueCandidate(me, [far], 1_000_000), null);

  const near = candidate({ userId: "near", trophies: { chess: 150 } });
  const found = findCompatibleQuickQueueCandidate(me, [far, near], 1_000_000);
  assert.equal(found?.userId, "near");
});

test("a game with no trophy track is never filtered (FIFO fallback)", () => {
  // The worker only attaches real `player_trophies` keys, so a game with no
  // trophy track (e.g. uno) contributes no key — the opponent must still match.
  const me = request({ preferredGames: ["uno"], trophies: {} });
  const opp = candidate({ gameKey: "uno", trophies: {} });
  const found = findCompatibleQuickQueueCandidate(me, [opp], 1_000_000);
  assert.equal(found?.userId, "opp");
});
