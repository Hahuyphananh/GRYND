// tests/last-run-realtime.test.mjs
//
// The registry is LAST RUN's authority: it owns the queue, the seed, the start
// instant, the inputs and the single finalisation. These tests drive it with
// explicit clocks (every function takes `now`) so the whole lifecycle —
// pairing, input acceptance, abandonment, duplicate results — is deterministic
// and needs no database, network or browser.

import test from "node:test";
import assert from "node:assert/strict";

import { COUNTDOWN_MS, DISCONNECT_GRACE_MS, MAX_INPUTS_PER_SECOND } from "../src/lib/last-run/constants.ts";
import {
  __resetLastRunRegistryForTests,
  forfeitMatch,
  getBroadcastSnapshot,
  getSnapshot,
  joinQueue,
  leaveQueue,
  peekMatch,
  queueStatus,
  sanitizeName,
  submitInput,
} from "../src/lib/last-run/matchRegistry.ts";
import {
  LAST_RUN_SNAPSHOT_EVENT,
  isMatchBroadcast,
  lastRunMatchRoom,
  snapshotForSeat,
} from "../src/lib/last-run/broadcast.ts";
import { pushLastRunSnapshot } from "../src/lib/last-run/realtime.ts";

const T0 = 1_700_000_000_000;

function pair() {
  __resetLastRunRegistryForTests();
  const first = joinQueue({ userId: "u1", name: "Ada", now: T0 });
  assert.equal(first.status, "queued");
  const second = joinQueue({ userId: "u2", name: "Bo", now: T0 + 10 });
  assert.equal(second.status, "matched");
  const match = peekMatch(second.matchId);
  assert.ok(match);
  return { matchId: second.matchId, match, startsAt: match.startsAt };
}

// ── Pairing ─────────────────────────────────────────────────────────────

test("queue: two players pair into exactly one match and a third cannot join it", () => {
  const { matchId, match } = pair();

  const third = joinQueue({ userId: "u3", name: "Cy", now: T0 + 20 });
  assert.equal(third.status, "queued", "a third player waits for their own match");

  assert.equal(match.players.player1.userId, "u1");
  assert.equal(match.players.player2.userId, "u2");
  assert.equal(match.players.player1.userId, match.players.player2.userId ? "u1" : "u1");
  assert.notEqual(match.players.player1.userId, match.players.player2.userId);

  // Knowing the id is not membership: a snapshot for u3 is refused.
  assert.equal(getSnapshot({ matchId, userId: "u3", now: T0 + 30 }), null);
});

test("queue: duplicate joins are idempotent — same match, no second pairing", () => {
  const { matchId } = pair();

  const again = joinQueue({ userId: "u1", name: "Ada", now: T0 + 40 });
  assert.equal(again.status, "matched");
  assert.equal(again.matchId, matchId);
  assert.equal(queueStatus("u1", T0 + 40).status, "matched");
});

test("queue: cancel removes the entry, is safe twice, and status returns to idle", () => {
  __resetLastRunRegistryForTests();
  joinQueue({ userId: "solo", name: "Solo", now: T0 });
  assert.equal(queueStatus("solo", T0 + 5).status, "queued");
  assert.equal(leaveQueue("solo"), true);
  assert.equal(leaveQueue("solo"), false);
  assert.equal(queueStatus("solo", T0 + 6).status, "idle");
});

// ── Seed + configuration ────────────────────────────────────────────────

test("seed: both seats see the SAME seed and the same obstacle list", () => {
  const { matchId, startsAt } = pair();
  const now = startsAt + 100;
  const one = getSnapshot({ matchId, userId: "u1", now });
  const two = getSnapshot({ matchId, userId: "u2", now });

  assert.ok(one && two);
  assert.equal(one.seed, two.seed);
  assert.deepEqual(one.course.obstacles, two.course.obstacles);
  assert.equal(one.course.duration, two.course.duration);
  assert.equal(one.you.seat, "player1");
  assert.equal(two.you.seat, "player2");
  assert.equal(one.opponent.seat, "player2");
});

test("clock: the pre-match phase is server-stamped, and both clients agree", () => {
  const { matchId, startsAt } = pair();
  const early = getSnapshot({ matchId, userId: "u1", now: startsAt - COUNTDOWN_MS + 5 });
  assert.equal(early.phase, "countdown");
  assert.equal(early.tick, 0);
  assert.equal(early.elapsedMs, 0);
  assert.ok(early.startsAt === startsAt);
});

// ── Inputs ──────────────────────────────────────────────────────────────

test("input: rejected during the countdown, accepted only as booleans, by members only", () => {
  const { matchId, startsAt } = pair();

  const tooEarly = submitInput({
    matchId,
    userId: "u1",
    payload: { jump: true, duck: false },
    now: startsAt - 50,
  });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.status, 409);

  const malformed = submitInput({
    matchId,
    userId: "u1",
    payload: { jump: "yes", duck: false },
    now: startsAt + 100,
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 400);

  const outsider = submitInput({
    matchId,
    userId: "u3",
    payload: { jump: true, duck: false },
    now: startsAt + 100,
  });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.status, 403);

  const accepted = submitInput({
    matchId,
    userId: "u1",
    payload: { jump: true, duck: false },
    now: startsAt + 100,
  });
  assert.equal(accepted.ok, true);
  // Received-at + the fixed lead: never a tick the server already simulated.
  assert.ok(accepted.tick >= 6);
});

test("input: a spam burst hits the per-second ceiling instead of buying simulation", () => {
  const { matchId, startsAt } = pair();
  let rejected = 0;
  for (let index = 0; index < MAX_INPUTS_PER_SECOND + 8; index += 1) {
    const result = submitInput({
      matchId,
      userId: "u1",
      payload: { jump: index % 2 === 0, duck: false },
      now: startsAt + 120,
    });
    if (!result.ok && result.status === 429) rejected += 1;
  }
  assert.ok(rejected > 0, "a burst must be rate limited");
});

// ── Finalisation ────────────────────────────────────────────────────────

test("result: leaving forfeits, and every retry returns the SAME result", () => {
  const { matchId, startsAt } = pair();

  const first = forfeitMatch({ matchId, userId: "u1", now: startsAt + 200 });
  assert.ok(first);
  assert.equal(first.result, "player2");

  const retry = forfeitMatch({ matchId, userId: "u1", now: startsAt + 300 });
  assert.deepEqual(retry, first, "a retried submission cannot settle twice");

  // The winner forfeiting afterwards must not flip the recorded result.
  const flip = forfeitMatch({ matchId, userId: "u2", now: startsAt + 400 });
  assert.equal(flip.result, "player2");
  assert.equal(flip.reason, first.reason);
});

test("result: a seat silent past the grace window forfeits instead of vanishing", () => {
  const { matchId, startsAt } = pair();

  // u1 keeps polling; u2 has not been seen since pairing. The grace window is
  // measured from the START of the race (see the next test), so this read has
  // to be past the window relative to tick 0.
  const snapshot = getSnapshot({
    matchId,
    userId: "u1",
    now: startsAt + DISCONNECT_GRACE_MS + 100,
  });
  assert.ok(snapshot);
  assert.equal(snapshot.phase, "finished");
  assert.equal(snapshot.final.result, "player1");
  assert.equal(snapshot.final.reason, "abandon");
});

test("forfeit clock: the grace window starts at tick 0, not at pairing", () => {
  const { matchId, startsAt } = pair();

  // 8 s into the race is 11 s after pairing: a page that is slow to load (or a
  // tab throttled during the countdown) must not hand the match to whoever
  // polled first. With the old pairing-anchored clock this read forfeited u2.
  const snapshot = getSnapshot({ matchId, userId: "u1", now: startsAt + 8_000 });
  assert.ok(snapshot);
  assert.equal(snapshot.phase, "finished");
  assert.notEqual(snapshot.final.reason, "abandon", "a slow first load is not abandonment");
});

test("result: a finished match keeps its outcome on every later read", () => {
  const { matchId, startsAt } = pair();
  forfeitMatch({ matchId, userId: "u1", now: startsAt + 100 });

  const later = getSnapshot({ matchId, userId: "u2", now: startsAt + 5000 });
  assert.ok(later);
  assert.equal(later.phase, "finished");
  assert.equal(later.final.result, "player2");
  assert.equal(later.final.reason, "left");
});

// ── The pushed snapshot ─────────────────────────────────────────────────
//
// The push sends ONE viewer-neutral build per match and each seat reads its own
// side out of it, so the socket path and the HTTP path hand the page the same
// object. These tests pin that equivalence and the refusal of malformed frames.

test("push: the frame is viewer-neutral and each seat reads its own side", () => {
  const { matchId, startsAt } = pair();
  const broadcast = getBroadcastSnapshot(matchId, startsAt + 500);
  assert.ok(broadcast);

  assert.equal("you" in broadcast, false, "a pushed frame is not addressed to a seat");
  assert.equal("opponent" in broadcast, false);

  const one = snapshotForSeat(broadcast, "player1");
  const two = snapshotForSeat(broadcast, "player2");
  assert.equal(one.you.seat, "player1");
  assert.equal(one.opponent.seat, "player2");
  assert.equal(two.you.seat, "player2");
  assert.equal(two.opponent.seat, "player1");
  assert.equal(one.seed, two.seed);
  assert.deepEqual(one.course.obstacles, two.course.obstacles);
  // Identical to the seat's own HTTP read — one rendering branch, not two.
  assert.deepEqual(one, getSnapshot({ matchId, userId: "u1", now: startsAt + 500 }));
});

test("push: a malformed or foreign frame is refused instead of drawn", () => {
  const { matchId, startsAt } = pair();
  const good = getBroadcastSnapshot(matchId, startsAt + 100);
  assert.ok(good);

  assert.equal(isMatchBroadcast(good), true);
  assert.equal(isMatchBroadcast(null), false);
  assert.equal(isMatchBroadcast({}), false);
  assert.equal(isMatchBroadcast({ ...good, phase: "tampered" }), false);
  assert.equal(isMatchBroadcast({ ...good, seats: { player1: {}, player2: {} } }), false);
});

test("push: one frame goes to the match room under the snapshot event", async () => {
  const { matchId, startsAt } = pair();
  const previousIo = globalThis.io;
  const frames = [];
  globalThis.io = {
    to: (room) => ({ emit: (event, payload) => frames.push({ room, event, payload }) }),
  };

  try {
    const sent = await pushLastRunSnapshot(matchId, startsAt + 700);
    assert.equal(sent, true);
    assert.equal(frames.length, 1, "exactly one frame per push");
    assert.equal(frames[0].room, lastRunMatchRoom(matchId));
    assert.equal(frames[0].event, LAST_RUN_SNAPSHOT_EVENT);
    assert.equal(frames[0].payload.matchId, matchId);
    assert.ok(frames[0].payload.tick > 0, "the frame is advanced, not stale");
  } finally {
    if (previousIo === undefined) delete globalThis.io;
    else globalThis.io = previousIo;
  }
});

// ── Names ───────────────────────────────────────────────────────────────

test("names: display-only, sanitised, never an authorisation input", () => {
  assert.equal(sanitizeName("  Ada\u0000\n"), "Ada");
  assert.equal(sanitizeName(""), "Runner");
  assert.equal(sanitizeName(42), "Runner");
  assert.equal(sanitizeName("x".repeat(80)).length, 24);
});
