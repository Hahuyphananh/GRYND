// Precision — the match page's pure view-model derivations.
//
// `src/lib/precision/matchView.ts` is what the per-round reveal, the arming
// recap board, the scoreboard badges and the end-of-match popup all read from.
// These tests pin the two things that used to be bugs:
//
//   * the reveal is keyed on the DECISION, never on `targetMs` (which flips
//     null -> T when the NEXT round opens, which re-showed the finished round
//     on top of the live one), and
//   * a snapshot that arrives out of order cannot roll the page back, because
//     the version guard is the only gate every state path goes through.
//
// A half-written payload (the public GET is untrusted input) must degrade to
// "nothing to show", never throw: a throw in the page's own render body is the
// blank-page failure mode the render-error boundary cannot catch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRaceLanes,
  buildRoundResultReveal,
  buildRoundStops,
  decisionKeyOf,
  isStaleSnapshot,
  liveTargetMsOf,
  readStoredLocalSeat,
} from "../src/lib/precision/matchView.ts";

const PLAYERS = [
  { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
  { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
];

const STOP1 = { stopInstant: 6_100, elapsedMs: 3_100, diffMs: 100, userId: "human" };
const STOP2 = { stopInstant: 6_300, elapsedMs: 3_300, diffMs: 300, userId: "AI_BOT" };

const state = (overrides = {}) => ({
  matchId: "m1",
  phase: "arming",
  wager: 0,
  isAiGame: true,
  aiStop: null,
  players: PLAYERS,
  turn: 1,
  score: { seat1: 1, seat2: 0 },
  currentRound: 2,
  roundSequence: 2,
  roundId: "m1-r-2",
  roundNonce: "nonce-2",
  targetMs: null,
  winnerSeat: null,
  lastRoundWinnerSeat: 1,
  armingStartedAt: 5_000,
  countdownEndsAt: 10_000,
  roundGoInstant: null,
  lastRoundStops: { seat1: STOP1, seat2: STOP2 },
  lastRoundTargetMs: 3_000,
  version: 5,
  ...overrides,
});

test("decisionKeyOf is derived only from the decided round's telemetry", () => {
  // Nothing decided yet.
  assert.equal(decisionKeyOf(null), null);
  assert.equal(decisionKeyOf(state({ lastRoundStops: null })), null);
  // A half-written decision (the other seat's stop missing) is not a decision.
  assert.equal(decisionKeyOf(state({ lastRoundStops: { seat1: STOP1, seat2: null } })), null);

  const key = decisionKeyOf(state());
  assert.equal(key, "6100|3100|6300|3300|1");
  // The same decision, re-delivered (broadcast + poll tick, with a newer
  // version and a live target now revealed) keeps the SAME key — that is what
  // debounces the reveal to one showing.
  assert.equal(decisionKeyOf(state({ version: 9, phase: "active", targetMs: 3_000 })), key);
  // A tie is encoded explicitly rather than by omitting the seat.
  assert.equal(decisionKeyOf(state({ lastRoundWinnerSeat: null })), "6100|3100|6300|3300|tie");
  // A NEW decision changes the key.
  assert.notEqual(
    decisionKeyOf(
      state({
        lastRoundStops: {
          seat1: STOP1,
          seat2: { ...STOP2, stopInstant: 6_400, elapsedMs: 3_400, diffMs: 400 },
        },
      })
    ),
    key
  );
});

test("buildRoundResultReveal reads the server-stamped decision target", () => {
  const reveal = buildRoundResultReveal(state());
  assert.equal(reveal.targetMs, 3_000);
  assert.equal(reveal.seat1ElapsedMs, 3_100);
  assert.equal(reveal.seat1DiffMs, 100);
  assert.equal(reveal.seat2ElapsedMs, 3_300);
  assert.equal(reveal.seat2DiffMs, 300);
  assert.equal(reveal.roundWinnerSeat, 1);
  assert.equal(reveal.signature, "6100|3100|6300|3300|1");
});

test("a fresh client still gets the reveal with a null live target", () => {
  // Fresh mount / reload straight into a decided round: `targetMs` is already
  // null, so only the decision's own target can carry the reveal.
  const reveal = buildRoundResultReveal(
    state({ phase: "active", targetMs: null, lastRoundTargetMs: 4_200 })
  );
  assert.equal(reveal.targetMs, 4_200);
});

test("the live target is only a fallback for snapshots without a decision target", () => {
  assert.equal(
    buildRoundResultReveal(state({ lastRoundTargetMs: null, targetMs: 7_000 })).targetMs,
    7_000
  );
  // Neither present -> nothing to show (nan/undefined never leak to the UI).
  assert.equal(buildRoundResultReveal(state({ lastRoundTargetMs: null })), null);
  assert.equal(buildRoundResultReveal(state({ lastRoundTargetMs: undefined })), null);
  // A malformed payload degrades to "no reveal" instead of throwing.
  assert.equal(buildRoundResultReveal(state({ lastRoundStops: {} })), null);
  assert.equal(buildRoundResultReveal(undefined), null);
});

test("buildRoundStops only summarises a decision when BOTH seats stopped", () => {
  assert.deepEqual(buildRoundStops(state()), {
    seat1: { elapsedMs: 3_100, diffMs: 100 },
    seat2: { elapsedMs: 3_300, diffMs: 300 },
  });
  assert.equal(buildRoundStops(state({ lastRoundStops: null })), null);
  assert.equal(buildRoundStops(state({ lastRoundStops: { seat1: STOP1 } })), null);
});

test("buildRaceLanes recaps the decided round from server telemetry", () => {
  const lanes = buildRaceLanes({
    recap: true,
    state: state(),
    players: PLAYERS,
    localSeat: 1,
    selfFrozenElapsedMs: null,
    seat1Fallback: "Alpha",
    seat2Fallback: "Bravo",
  });
  assert.deepEqual(
    lanes.map((l) => [l.seat, l.name, l.isSelf, l.frozenElapsedMs]),
    [
      [1, "You", true, 3_100],
      [2, "GRYND AI", false, 3_300],
    ]
  );
  // No decision to recap yet -> both lanes unfrozen.
  const noDecision = buildRaceLanes({
    recap: true,
    state: state({ lastRoundStops: null }),
    players: PLAYERS,
    localSeat: 1,
    selfFrozenElapsedMs: 111,
    seat1Fallback: "Alpha",
    seat2Fallback: "Bravo",
  });
  assert.equal(noDecision[0].frozenElapsedMs, null);
  assert.equal(noDecision[1].frozenElapsedMs, null);
});

test("buildRaceLanes freezes only what is public during a live round", () => {
  const live = buildRaceLanes({
    recap: false,
    state: state({
      phase: "active",
      targetMs: 3_000,
      aiStop: { stopInstant: 6_000, elapsedMs: 2_900 },
    }),
    players: PLAYERS,
    localSeat: 1,
    selfFrozenElapsedMs: 2_750,
    seat1Fallback: "Alpha",
    seat2Fallback: "Bravo",
  });
  // Self parks at the click; the bot at its published stop.
  assert.equal(live[0].frozenElapsedMs, 2_750);
  assert.equal(live[1].frozenElapsedMs, 2_900);
  // A human opponent's stop must stay hidden until the round resolves.
  const pvp = buildRaceLanes({
    recap: false,
    state: state({ isAiGame: false, aiStop: { stopInstant: 6_000, elapsedMs: 2_900 } }),
    players: PLAYERS,
    localSeat: 1,
    selfFrozenElapsedMs: null,
    seat1Fallback: "Alpha",
    seat2Fallback: "Bravo",
  });
  assert.equal(pvp[0].frozenElapsedMs, null);
  assert.equal(pvp[1].frozenElapsedMs, null);
});

test("buildRaceLanes puts the local seat in its own lane and falls back to seat labels", () => {
  const lanes = buildRaceLanes({
    recap: false,
    state: state({ players: [], aiStop: null }),
    players: [],
    localSeat: 2,
    selfFrozenElapsedMs: 10,
    seat1Fallback: "ALPHA",
    seat2Fallback: "BRAVO",
  });
  assert.equal(lanes[0].name, "ALPHA");
  assert.equal(lanes[1].name, "BRAVO");
  assert.equal(lanes[0].isSelf, false);
  assert.equal(lanes[1].isSelf, true);
  // Lane 2 is "self", so the freeze lands there, not on seat 1.
  assert.equal(lanes[0].frozenElapsedMs, null);
  assert.equal(lanes[1].frozenElapsedMs, 10);
});

test("liveTargetMsOf treats an undefined target as absent (never NaN in the UI)", () => {
  assert.equal(liveTargetMsOf(null), null);
  assert.equal(liveTargetMsOf(state({ targetMs: null })), null);
  assert.equal(liveTargetMsOf(state({ targetMs: undefined })), null);
  assert.equal(liveTargetMsOf(state({ targetMs: "3000" })), null);
  assert.equal(liveTargetMsOf(state({ targetMs: 0 })), 0);
});

test("isStaleSnapshot drops older snapshots and keeps everything else", () => {
  const held = state({ version: 7 });
  assert.equal(isStaleSnapshot(held, state({ version: 6 })), true);
  assert.equal(isStaleSnapshot(held, state({ version: 7 })), false);
  assert.equal(isStaleSnapshot(held, state({ version: 8 })), false);
  // Nothing on screen yet -> nothing to be stale against.
  assert.equal(isStaleSnapshot(null, state({ version: 1 })), false);
  // A snapshot for a DIFFERENT match is not "stale", it is simply not ours;
  // `applySnapshot` rejects it before this is consulted.
  assert.equal(isStaleSnapshot(held, state({ matchId: "other", version: 1 })), false);
  // A payload without a version reads as 0 (or as "no information"), which
  // must never roll the page back over a versioned snapshot.
  assert.equal(isStaleSnapshot(held, state({ version: undefined })), true);
  assert.equal(isStaleSnapshot(state({ version: undefined }), held), false);
});

test("readStoredLocalSeat reads the lobby's seat, defaulting to seat 1", () => {
  const original = globalThis.window;
  try {
    assert.equal(readStoredLocalSeat(), 1, "no window (SSR) -> seat 1");

    globalThis.window = { sessionStorage: { getItem: () => "2" } };
    assert.equal(readStoredLocalSeat(), 2);
    globalThis.window = { sessionStorage: { getItem: () => "1" } };
    assert.equal(readStoredLocalSeat(), 1);
    globalThis.window = {
      sessionStorage: {
        getItem() {
          throw new Error("storage blocked");
        },
      },
    };
    assert.equal(readStoredLocalSeat(), 1, "blocked storage -> seat 1");
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
