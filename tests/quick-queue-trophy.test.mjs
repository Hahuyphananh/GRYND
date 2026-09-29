/**
 * quick-queue-trophy.test.mjs
 *
 * Trophy + Elo matchmaking (Phase: trophies feed quick queue).
 *
 * Trophies are unbounded and are one of TWO skill signals; per-game Elo is the
 * other. The quick queue prefers a partner whose per-game trophy count AND
 * rating are both close. Each acceptable gap WIDENS the longer a player waits,
 * so nobody is starved by a thin ladder, and a request with no data for a
 * signal falls back to the original preference + FIFO matching for it.
 *
 * Run:  node --import tsx --test tests/quick-queue-trophy.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TROPHY_MATCH_INITIAL_WINDOW,
  TROPHY_MATCH_MAX_WINDOW,
  ELO_MATCH_INITIAL_WINDOW,
  ELO_MATCH_MAX_WINDOW,
  findCompatibleQuickQueueCandidate,
  normalizeQuickQueueRequest,
  playersCompatible,
  trophyForGame,
  eloForGame,
  trophyMatchWindow,
  eloMatchWindow,
} from "../src/lib/quickQueue.ts";

// `trophies` / `ratings` are attached AFTER normalize (the request validator
// only accepts the queue constraints) — exactly as the worker does at claim
// time.
const request = ({ trophies = null, ratings = null, ...overrides } = {}) => ({
  ...normalizeQuickQueueRequest({
    userId: "me",
    preferredGames: ["chess"],
    playerCount: 2,
    ...overrides,
  }),
  trophies,
  ratings,
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

test("eloMatchWindow starts tight and widens with wait, then caps", () => {
  assert.equal(eloMatchWindow(0), ELO_MATCH_INITIAL_WINDOW);
  assert.ok(eloMatchWindow(10_000) > ELO_MATCH_INITIAL_WINDOW);
  assert.equal(eloMatchWindow(999_999_99), ELO_MATCH_MAX_WINDOW);
});

test("trophyForGame / eloForGame are null for unknown data", () => {
  assert.equal(trophyForGame(null, "chess"), null);
  assert.equal(trophyForGame({}, "chess"), null);
  assert.equal(trophyForGame({ chess: "abc" }, "chess"), null);
  assert.equal(trophyForGame({ chess: -50 }, "chess"), 0);
  assert.equal(trophyForGame({ chess: 1200 }, "chess"), 1200);

  assert.equal(eloForGame(null, "chess"), null);
  assert.equal(eloForGame({ chess: "abc" }, "chess"), null);
  assert.equal(eloForGame({ chess: 1450 }, "chess"), 1450);
});

test("playersCompatible: missing data on either side always passes", () => {
  assert.equal(
    playersCompatible({
      requester: null,
      candidate: { chess: 9000 },
      gameKey: "chess",
      waitMs: 0,
    }),
    true,
  );
  assert.equal(
    playersCompatible({
      requester: { chess: 10 },
      candidate: null,
      gameKey: "chess",
      waitMs: 0,
    }),
    true,
  );
});

test("playersCompatible: close trophies pass now, far only once the range has grown", () => {
  const near = playersCompatible({
    requester: { chess: 1000 },
    candidate: { chess: 1100 },
    gameKey: "chess",
    waitMs: 0,
  });
  assert.equal(near, true);

  const farNow = playersCompatible({
    requester: { chess: 0 },
    candidate: { chess: 5000 },
    gameKey: "chess",
    waitMs: 0,
  });
  assert.equal(farNow, false);

  const farLater = playersCompatible({
    requester: { chess: 0 },
    candidate: { chess: 5000 },
    gameKey: "chess",
    waitMs: 999_999_99,
  });
  assert.equal(farLater, true);
});

test("playersCompatible: EITHER signal being too far apart blocks the pair", () => {
  // Trophies close, but Elo far apart → blocked, then allowed once the Elo
  // window has widened.
  assert.equal(
    playersCompatible({
      requester: { chess: 100 },
      candidate: { chess: 150 },
      requesterRatings: { chess: 1000 },
      candidateRatings: { chess: 3000 },
      gameKey: "chess",
      waitMs: 0,
    }),
    false,
  );
  assert.equal(
    playersCompatible({
      requester: { chess: 100 },
      candidate: { chess: 150 },
      requesterRatings: { chess: 1000 },
      candidateRatings: { chess: 3000 },
      gameKey: "chess",
      waitMs: 999_999_99,
    }),
    true,
  );

  // Elo close, but trophies far apart → blocked too.
  assert.equal(
    playersCompatible({
      requester: { chess: 0 },
      candidate: { chess: 9000 },
      requesterRatings: { chess: 1200 },
      candidateRatings: { chess: 1210 },
      gameKey: "chess",
      waitMs: 0,
    }),
    false,
  );
});

test("candidate matching filters a far-away opponent when trophies are known", () => {
  const me = request({ trophies: { chess: 100 } });
  const far = candidate({ trophies: { chess: 9000 } });
  assert.equal(findCompatibleQuickQueueCandidate(me, [far], 1_000_000), null);

  const near = candidate({ userId: "near", trophies: { chess: 150 } });
  const found = findCompatibleQuickQueueCandidate(me, [far, near], 1_000_000);
  assert.equal(found?.userId, "near");
});

test("candidate matching filters a far-away opponent by Elo too", () => {
  const me = request({
    trophies: { chess: 500 },
    ratings: { chess: 1000 },
  });
  const far = candidate({
    userId: "far",
    trophies: { chess: 520 },
    ratings: { chess: 3000 },
  });
  assert.equal(findCompatibleQuickQueueCandidate(me, [far], 1_000_000), null);

  const near = candidate({
    userId: "near",
    trophies: { chess: 520 },
    ratings: { chess: 1000 + ELO_MATCH_INITIAL_WINDOW - 10 },
  });
  const found = findCompatibleQuickQueueCandidate(me, [far, near], 1_000_000);
  assert.equal(found?.userId, "near");
});

test("a game with no data on either signal is never filtered (FIFO fallback)", () => {
  // The worker only attaches real `player_trophies` / `player_ratings` keys, so
  // a game with no data contributes no key — the opponent must still match.
  const me = request({ preferredGames: ["uno"], trophies: {}, ratings: {} });
  const opp = candidate({ gameKey: "uno", trophies: {}, ratings: {} });
  const found = findCompatibleQuickQueueCandidate(me, [opp], 1_000_000);
  assert.equal(found?.userId, "opp");
});
