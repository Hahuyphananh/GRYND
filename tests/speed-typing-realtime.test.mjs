/**
 * speed-typing-realtime.test.mjs
 *
 * Speed Typing's Socket.IO layer: the shared vocabulary, the opponent
 * projection, and the guarantees that keep the socket out of the trust path.
 *
 * The realtime server is a standalone service and cannot be booted inside a
 * unit test, so — exactly like tests/mini-golf-realtime.test.mjs and
 * tests/tower-arena-realtime.test.mjs — this file drives the PURE pieces for
 * real (room naming, the broadcast helper, the opponent projection) and pins the
 * standalone server's wiring by reading its source, the way
 * tests/match-lifecycle-relay.test.mjs does.
 *
 * The one idea under test: the socket is TRANSPORT. It carries projections of
 * state that the server derived from the canonical prompt — never a client's
 * claim, and never the opponent's raw typed text.
 *
 * Run:  node --import tsx --test tests/speed-typing-realtime.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  SPEED_TYPING_EVENTS,
  SPEED_TYPING_LOBBY_ROOM,
  SPEED_TYPING_MATCH_ROOM_PREFIX,
  broadcastMatchEvent,
  broadcastMatchUpdate,
  broadcastOpponentProgress,
  opponentProgressFor,
  relayMatchEvent,
  speedTypingMatchRoom,
} from "../src/lib/speed-typing/realtime.ts";
import {
  PROGRESS_MIN_ADVANCE,
  RACE_LIMIT_MS,
  SEAT,
} from "../src/lib/speed-typing/constants.ts";
import {
  createRaceState,
  emptySeatRace,
  evaluateCheckpoint,
  raceMetrics,
  verifyTypedText,
} from "../src/lib/speed-typing/rules.ts";
import { selectPassageForSeed } from "../src/lib/speed-typing/passages.ts";

const realtimeServer = fs.readFileSync("realtime-server/server.js", "utf8");

const GO = 1_700_000_000_000;
const TEXT = selectPassageForSeed({ seed: 987654 }).text;

const createOrJoinRoute = fs.readFileSync(
  "src/app/api/speed-typing/create-or-join/route.ts",
  "utf8",
);
const disconnectRoute = fs.readFileSync(
  "src/app/api/speed-typing/disconnect-forfeit/route.ts",
  "utf8",
);

/** Install a fake `globalThis.io`, run `fn`, and always restore. */
function withFakeIo(fn) {
  const previous = globalThis.io;
  const emitted = [];
  globalThis.io = {
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
  try {
    return { result: fn(), emitted };
  } finally {
    if (previous === undefined) delete globalThis.io;
    else globalThis.io = previous;
  }
}

/** An authoritative seat that has typed `chars` characters, optionally done. */
function seatAt(chars, { errors = 0, finished = false, finishedAtMs = null } = {}) {
  return {
    ...emptySeatRace(),
    charsTyped: chars,
    errors,
    finished,
    finishedAtMs,
    elapsedMs: finished ? 30_000 : null,
    wpm: null,
    accuracy: null,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 1. Event taxonomy + rooms
// ════════════════════════════════════════════════════════════════════════

test("realtime: the event vocabulary covers every spec'd event", () => {
  // The spec's events, mapped onto the shared vocabulary.
  const required = {
    ready: SPEED_TYPING_EVENTS.READY,
    countdown: SPEED_TYPING_EVENTS.COUNTDOWN,
    matchStarted: SPEED_TYPING_EVENTS.MATCH_STARTED,
    playerCompleted: SPEED_TYPING_EVENTS.PLAYER_COMPLETED,
    matchFinished: SPEED_TYPING_EVENTS.MATCH_FINISHED,
    opponentProgress: SPEED_TYPING_EVENTS.OPPONENT_PROGRESS,
    matchUpdated: SPEED_TYPING_EVENTS.MATCH_UPDATED,
  };
  for (const [label, value] of Object.entries(required)) {
    assert.equal(typeof value, "string", `${label} must be defined`);
    assert.ok(value.length > 0);
  }
  // Every dedicated event is namespaced, so it can never collide with another
  // game's channel on the shared socket.
  for (const value of Object.values(SPEED_TYPING_EVENTS)) {
    if (value === SPEED_TYPING_EVENTS.MATCH_UPDATED) continue;
    assert.match(value, /^speed-typing:/, `event is namespaced: ${value}`);
  }
  // …and the generic one is the shared string every PvP game relays.
  assert.equal(SPEED_TYPING_EVENTS.MATCH_UPDATED, "lobby:updated");
  assert.equal(SPEED_TYPING_EVENTS.READY, "speed-typing:ready");
});

test("realtime: one room per match, namespaced and never shared", () => {
  assert.equal(SPEED_TYPING_MATCH_ROOM_PREFIX, "speed-typing:match:");
  assert.equal(speedTypingMatchRoom("abc-123"), "speed-typing:match:abc-123");
  assert.notEqual(speedTypingMatchRoom("a"), speedTypingMatchRoom("b"));
  assert.notEqual(speedTypingMatchRoom("a"), SPEED_TYPING_LOBBY_ROOM);
});

// ════════════════════════════════════════════════════════════════════════
// 2. The broadcast helper must never break a request
// ════════════════════════════════════════════════════════════════════════

test("broadcast: silently no-ops with no io instance (split-process deploys)", () => {
  const previous = globalThis.io;
  delete globalThis.io;
  try {
    assert.equal(broadcastMatchEvent("m1", "speed-typing:ready", {}), false);
    assert.equal(broadcastMatchUpdate("m1", { status: "playing" }), false);
  } finally {
    if (previous !== undefined) globalThis.io = previous;
  }
});

test("broadcast: a throwing io can never bubble into the calling route", () => {
  const previous = globalThis.io;
  globalThis.io = {
    to() {
      throw new Error("socket exploded");
    },
  };
  try {
    assert.equal(broadcastMatchEvent("m1", "speed-typing:ready", {}), false);
  } finally {
    if (previous === undefined) delete globalThis.io;
    else globalThis.io = previous;
  }
});

test("broadcast: emits to the match room with the match id and a sentAt stamp", () => {
  const { result, emitted } = withFakeIo(() =>
    broadcastMatchEvent("match-1", SPEED_TYPING_EVENTS.MATCH_STARTED, { goAtMs: GO }),
  );
  assert.equal(result, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, "speed-typing:match:match-1");
  assert.equal(emitted[0].event, "speed-typing:match-started");
  assert.equal(emitted[0].payload.matchId, "match-1");
  assert.equal(emitted[0].payload.goAtMs, GO);
  assert.equal(typeof emitted[0].payload.sentAt, "string");
});

test("broadcast: the generic update uses the shared lobby:updated string", () => {
  const { emitted } = withFakeIo(() => broadcastMatchUpdate("m1", { status: "finished" }));
  assert.equal(emitted[0].event, "lobby:updated");
  assert.equal(emitted[0].payload.status, "finished");
});

test("broadcast: a malformed payload normalises to a stub, never throws", () => {
  const { result, emitted } = withFakeIo(() => broadcastMatchEvent("m1", "e", null));
  assert.equal(result, true);
  assert.equal(emitted[0].payload.matchId, "m1");
  assert.ok(!("0" in emitted[0].payload), "an array/null payload must not leak through");
});

// ════════════════════════════════════════════════════════════════════════
// 3. The opponent projection — server-derived, and text-free
// ════════════════════════════════════════════════════════════════════════

test("opponent: progress is the verified cursor as a percentage of the prompt", () => {
  const length = TEXT.length;
  const quarter = opponentProgressFor({
    seatKey: SEAT.PLAYER1,
    seat: seatAt(Math.floor(length / 4)),
    promptLength: length,
    nowMs: GO + 10_000,
    goAtMs: GO,
  });
  assert.equal(quarter.seatKey, "player1");
  assert.equal(quarter.progressPercent, 25);
  assert.equal(quarter.completed, false);

  // Reaching (or over-running) the end is 100%, never more.
  const full = opponentProgressFor({
    seatKey: SEAT.PLAYER2,
    seat: seatAt(length + 500),
    promptLength: length,
    nowMs: GO + 10_000,
    goAtMs: GO,
  });
  assert.equal(full.progressPercent, 100);

  // Nothing typed, and a degenerate prompt, are both 0% — never NaN.
  assert.equal(
    opponentProgressFor({ seatKey: SEAT.PLAYER1, seat: emptySeatRace(), promptLength: length, nowMs: GO, goAtMs: GO })
      .progressPercent,
    0,
  );
  assert.equal(
    opponentProgressFor({ seatKey: SEAT.PLAYER1, seat: seatAt(10), promptLength: 0, nowMs: GO, goAtMs: GO })
      .progressPercent,
    0,
  );
  assert.equal(
    opponentProgressFor({ seatKey: SEAT.PLAYER1, seat: null, promptLength: 10, nowMs: GO, goAtMs: GO })
      .progressPercent,
    0,
  );
});

test("opponent: completion is only ever the server's verified finish", () => {
  const inProgress = opponentProgressFor({
    seatKey: SEAT.PLAYER2,
    seat: seatAt(TEXT.length - 1),
    promptLength: TEXT.length,
    nowMs: GO + 10_000,
    goAtMs: GO,
  });
  assert.equal(inProgress.completed, false, "one character short is not done");

  const done = opponentProgressFor({
    seatKey: SEAT.PLAYER2,
    seat: seatAt(TEXT.length, { finished: true, finishedAtMs: GO + 30_000 }),
    promptLength: TEXT.length,
    nowMs: GO + 31_000,
    goAtMs: GO,
  });
  assert.equal(done.completed, true);
  assert.equal(done.progressPercent, 100);
});

test("opponent: wpm/accuracy come from the seat's server-derived metrics", () => {
  const seat = seatAt(100, { errors: 25, finished: true, finishedAtMs: GO + 60_000 });
  const payload = opponentProgressFor({
    seatKey: SEAT.PLAYER1,
    seat,
    promptLength: TEXT.length,
    nowMs: GO + 60_000,
    goAtMs: GO,
  });
  const expected = raceMetrics({ seat, goAtMs: GO, nowMs: GO + 60_000 });
  assert.equal(payload.wpm, expected.wpm);
  assert.equal(payload.accuracy, expected.accuracy);
  assert.equal(payload.accuracy, 75);
});

test("opponent: the payload is a closed shape — no typed text, no passage", () => {
  const payload = opponentProgressFor({
    seatKey: SEAT.PLAYER1,
    seat: seatAt(TEXT.length),
    promptLength: TEXT.length,
    nowMs: GO + 5_000,
    goAtMs: GO,
  });

  // Field-by-field construction means the key set is exact and stable.
  assert.deepEqual(Object.keys(payload).sort(), [
    "accuracy",
    "completed",
    "progressPercent",
    "seatKey",
    "wpm",
  ]);
  for (const forbidden of ["typedText", "text", "passage", "passageText", "errors", "finishedAtMs", "raw"]) {
    assert.equal(forbidden in payload, false, `${forbidden} must never reach the opponent`);
  }
  // And no VALUE may embed any of the prompt.
  const serialised = JSON.stringify(payload);
  const firstWords = TEXT.split(" ").slice(0, 6);
  for (const word of firstWords) {
    assert.equal(serialised.includes(word), false, `the prompt must not leak: ${word}`);
  }
});

test("opponent: the broadcast targets the match room with the projected payload only", () => {
  const seat = seatAt(50, { errors: 2 });
  const { result, emitted } = withFakeIo(() =>
    broadcastOpponentProgress({
      matchId: "match-9",
      seatKey: SEAT.PLAYER2,
      seat,
      promptLength: TEXT.length,
      nowMs: GO + 5_000,
      goAtMs: GO,
    }),
  );

  assert.equal(result, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, "speed-typing:match:match-9");
  assert.equal(emitted[0].event, "speed-typing:opponent-progress");
  assert.equal(emitted[0].payload.seatKey, "player2");
  assert.equal(emitted[0].payload.progressPercent, Math.round((50 / TEXT.length) * 100));
  assert.equal(emitted[0].payload.matchId, "match-9");
  // Nothing resembling the opponent's actual text was transmitted.
  assert.equal(typeof emitted[0].payload.typedText, "undefined");
  assert.equal(emitted[0].payload.accuracy, 96, "(50 - 2) / 50 = 96%");
});

// ════════════════════════════════════════════════════════════════════════
// 4. High-frequency typing must not touch the database
// ════════════════════════════════════════════════════════════════════════

test("throttle: a keystroke-rate stream collapses to a handful of persisted checkpoints", () => {
  // Drive one packet per character, exactly as a client's send loop would, and
  // count how many the store would actually WRITE. This is the property that
  // keeps a race out of the database write path.
  let state = createRaceState({ version: 1 });
  let persisted = 0;
  let packets = 0;
  let lastPosition = 0;

  for (let i = 1; i <= 300; i += 1) {
    packets += 1;
    const verification = verifyTypedText({ passageText: TEXT, typedText: TEXT.slice(0, i) });
    const decision = evaluateCheckpoint({
      state,
      seat: SEAT.PLAYER1,
      verification,
      nowMs: GO + i * 10,
      goAtMs: GO,
    });
    if (decision.accept) {
      persisted += 1;
      // The throttle is cleared by a real advance — or bypassed entirely by a
      // completed prompt, which must always be persisted.
      assert.ok(
        decision.seat.charsTyped - lastPosition >= PROGRESS_MIN_ADVANCE || verification.ok,
        "an accepted checkpoint must clear the throttle or complete the prompt",
      );
      lastPosition = decision.seat.charsTyped;
      state = { ...state, version: state.version + 1, seats: { ...state.seats, [SEAT.PLAYER1]: decision.seat } };
    }
  }

  assert.equal(packets, 300);
  // ~one write per PROGRESS_MIN_ADVANCE characters, not one per keystroke.
  assert.ok(persisted <= Math.ceil(300 / PROGRESS_MIN_ADVANCE) + 1, `too many writes: ${persisted}`);
  assert.ok(persisted < packets / 5, "a keystroke stream must not become a write stream");
  assert.equal(
    state.seats[SEAT.PLAYER1].charsTyped,
    Math.min(300, TEXT.length),
    "the authoritative position still advanced (capped at the prompt)",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 5. Reconnect / replay safety at the transport layer
// ════════════════════════════════════════════════════════════════════════

test("reconnect: the transport carries no authority, so a replay is harmless", () => {
  const seat = seatAt(120, { errors: 3, finished: true, finishedAtMs: GO + 40_000 });
  const input = { seatKey: SEAT.PLAYER1, seat, promptLength: TEXT.length, nowMs: GO + 41_000, goAtMs: GO };

  // The same authoritative state always projects to the same payload — a
  // duplicated or late push can never "advance" the opponent's view of truth.
  assert.deepEqual(opponentProgressFor(input), opponentProgressFor(input));

  // A replayed broadcast of an already-completed seat is still just a
  // projection: the client reconciles from the snapshot, and the store's own
  // idempotency (proven in speed-typing-store.test.mjs) is what stops a second
  // settlement — nothing in the transport path can settle anything.
  const { emitted } = withFakeIo(() =>
    broadcastOpponentProgress({ matchId: "m1", ...input }),
  );
  const { emitted: again } = withFakeIo(() =>
    broadcastOpponentProgress({ matchId: "m1", ...input }),
  );
  // `sentAt` is the broadcast INSTANT, not a projection of the state, so it is
  // deliberately outside the equality: comparing it made this assertion fail
  // whenever the two calls straddled a millisecond boundary. The stamp is still
  // required to be present, and everything derived from the state must match.
  const { sentAt: _firstStamp, ...firstPayload } = emitted[0].payload;
  const { sentAt: _secondStamp, ...secondPayload } = again[0].payload;
  assert.deepEqual(firstPayload, secondPayload);
  assert.equal(typeof emitted[0].payload.sentAt, "string");
});

test("reconnect: the room re-join cancels the disconnect forfeit (server wiring)", () => {
  // A re-joining socket must be able to reclaim its seat without the pending
  // forfeit firing — the timer is keyed per (match, user) and cancelled on join.
  const join = realtimeServer.slice(realtimeServer.indexOf("function trackSpeedTypingJoin("));
  const body = join.slice(0, join.indexOf("function trackSpeedTypingLeave("));
  assert.match(body, /cancelDisconnectGraceTimer\(`speed-typing:\$\{matchId\}:\$\{userId\}`\)/);
  // Participants are a Set, so a duplicate join can never create a duplicate
  // player (the "duplicate players" reconnect hazard).
  assert.match(body, /new Set\(\)/);
  assert.match(body, /\.add\(userId\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. The realtime server's Speed Typing wiring
// ════════════════════════════════════════════════════════════════════════

test("server: the ONE Socket.IO server tracks the speed-typing match room", () => {
  assert.match(realtimeServer, /const SPEED_TYPING_MATCH_ROOM_PREFIX = "speed-typing:match:";/);
  // Join and leave are wired into the shared handlers (a second server was
  // deliberately NOT created).
  const joinRoom = realtimeServer.slice(
    realtimeServer.indexOf('socket.on("join_room"'),
    realtimeServer.indexOf('socket.on("leave_room"'),
  );
  assert.match(joinRoom, /trackSpeedTypingJoin\(String\(roomId\), socket\.data\.userId\)/);
  const leaveRoom = realtimeServer.slice(
    realtimeServer.indexOf('socket.on("leave_room"'),
    realtimeServer.indexOf("const PRECISION_ARMING_EVENTS"),
  );
  assert.match(leaveRoom, /trackSpeedTypingLeave\(String\(roomId\), socket\.data\.userId\)/);
  // The admin room guard still stands: the generic join path cannot enter it.
  assert.match(joinRoom, /=== ADMIN_NOTIFICATIONS_ROOM/);
});

test("server: the ready poke rejects non-participants and relays a bare hint", () => {
  const start = realtimeServer.indexOf('socket.on("speed-typing:ready"');
  assert.ok(start > -1, "the speed-typing ready handler must exist");
  const handler = realtimeServer.slice(start, realtimeServer.indexOf('socket.on("crashArena:updated"', start));

  // The caller must be a tracked participant of THAT match.
  assert.match(handler, /speedTypingRoomParticipants\.get\(matchIdStr\)/);
  assert.match(handler, /!participants\.has\(socket\.data\.userId\)/);
  // The match id charset is constrained, so a malformed id cannot build a
  // surprising room name.
  assert.match(handler, /\^\[0-9a-fA-F-\]\{1,64\}\$/);
  // Relay goes to the OTHER seats only, and carries no game numbers at all.
  assert.match(handler, /socket\.to\(roomId\)\.emit\("lobby:updated"/);
  for (const forbidden of [/progressPercent/, /wpm/, /accuracy/, /typedText/, /winner/, /score/]) {
    assert.doesNotMatch(handler, forbidden, `the relay must not carry ${forbidden}`);
  }
});

test("server: a disconnect schedules the authoritative forfeit via the store route", () => {
  assert.match(realtimeServer, /\/api\/speed-typing\/disconnect-forfeit/);
  const block = realtimeServer.slice(
    realtimeServer.indexOf("const speedTypingMatchesForUser = []"),
    realtimeServer.indexOf("// For hex duel: arm a grace timer per game"),
  );
  assert.match(block, /scheduleDisconnectGraceTimer\(`speed-typing:\$\{mid\}:\$\{socket\.data\.userId\}`/);
  // A reconnect inside the window short-circuits the forfeit.
  assert.match(block, /if \(hasLiveSocketForUser\(socket\.data\.userId, roomId\)\) return false;/);
  // The token is the socket's own, so only the owner's match can be forfeited.
  assert.match(block, /token: socket\.data\.clerkToken/);
});

// ════════════════════════════════════════════════════════════════════════
// 7. The split-process relay (backend → realtime /emit)
// ════════════════════════════════════════════════════════════════════════

test("relay: posts to /emit with the match room, event and payload", async () => {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.NEXT_PUBLIC_SOCKET_URL;
  const realInternal = process.env.REALTIME_INTERNAL_URL;
  const realSecret = process.env.REALTIME_INTERNAL_SECRET;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ success: true }) };
  };
  process.env.NEXT_PUBLIC_SOCKET_URL = "https://rt.example/";
  delete process.env.REALTIME_INTERNAL_URL;
  process.env.REALTIME_INTERNAL_SECRET = "shh";

  try {
    const ok = await relayMatchEvent("match-7", SPEED_TYPING_EVENTS.MATCH_FINISHED, {
      result: "player1",
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://rt.example/emit");
    assert.equal(calls[0].body.room, "speed-typing:match:match-7");
    assert.equal(calls[0].body.event, "speed-typing:match-finished");
    assert.equal(calls[0].body.payload.matchId, "match-7");
    assert.equal(calls[0].body.payload.result, "player1");
    assert.equal(calls[0].init.headers["x-internal-secret"], "shh");
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.NEXT_PUBLIC_SOCKET_URL;
    else process.env.NEXT_PUBLIC_SOCKET_URL = realUrl;
    if (realInternal === undefined) delete process.env.REALTIME_INTERNAL_URL;
    else process.env.REALTIME_INTERNAL_URL = realInternal;
    if (realSecret === undefined) delete process.env.REALTIME_INTERNAL_SECRET;
    else process.env.REALTIME_INTERNAL_SECRET = realSecret;
  }
});

test("route: matchmaking broadcasts the countdown and start when it ARMS the race", () => {
  const route = createOrJoinRoute;
  // The emit sites exist for join / ready / countdown / start.
  assert.match(route, /broadcastMatchUpdate\(matchId/);
  assert.match(route, /SPEED_TYPING_EVENTS\.COUNTDOWN/);
  assert.match(route, /SPEED_TYPING_EVENTS\.MATCH_STARTED/);
  // The GO instant broadcast is the SERVER's, read back off the armed row — a
  // client can never supply the instant the race starts.
  assert.match(route, /new Date\(result\.match\.goAt\)\.getTime\(\)/);
  assert.match(route, /countdownMs: RACE_COUNTDOWN_MS/);
  // And the route still only returns the destination to navigate to.
  assert.match(route, /await createOrJoin\(\{ userId \}\)/);
  assert.match(route, /matchId: result\.match\.id/);
});

test("route: the disconnect endpoint re-verifies the socket token", () => {
  assert.match(disconnectRoute, /verifyToken\(token, \{ secretKey: CLERK_SECRET_KEY \}\)/);
  assert.match(disconnectRoute, /forfeitMatch\(\{ userId: clerkUserId, matchId \}\)/);
  assert.match(disconnectRoute, /broadcastMatchUpdate\(matchId/);
  // An unknown / foreign match is definitive, so the realtime retry loop stops.
  assert.match(disconnectRoute, /DEFINITIVE_STATUSES/);
});

test("relay: no configured realtime URL means no request, and no throw", async () => {
  const realUrl = process.env.NEXT_PUBLIC_SOCKET_URL;
  const realInternal = process.env.REALTIME_INTERNAL_URL;
  delete process.env.NEXT_PUBLIC_SOCKET_URL;
  delete process.env.REALTIME_INTERNAL_URL;
  try {
    assert.equal(await relayMatchEvent("m1", SPEED_TYPING_EVENTS.MATCH_STARTED, {}), false);
  } finally {
    if (realUrl !== undefined) process.env.NEXT_PUBLIC_SOCKET_URL = realUrl;
    if (realInternal !== undefined) process.env.REALTIME_INTERNAL_URL = realInternal;
  }
});

test("relay: a failing relay is swallowed, never surfaced to the route", async () => {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.NEXT_PUBLIC_SOCKET_URL;
  const realInternal = process.env.REALTIME_INTERNAL_URL;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  process.env.NEXT_PUBLIC_SOCKET_URL = "https://rt.example";
  delete process.env.REALTIME_INTERNAL_URL;
  try {
    assert.equal(await relayMatchEvent("m1", SPEED_TYPING_EVENTS.MATCH_FINISHED, {}), false);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.NEXT_PUBLIC_SOCKET_URL;
    else process.env.NEXT_PUBLIC_SOCKET_URL = realUrl;
    if (realInternal === undefined) delete process.env.REALTIME_INTERNAL_URL;
    else process.env.REALTIME_INTERNAL_URL = realInternal;
  }
});

// ════════════════════════════════════════════════════════════════════════
// 8. The countdown / started / finished payloads are server-clock facts
// ════════════════════════════════════════════════════════════════════════

test("lifecycle: countdown and started carry the server's absolute GO instant", () => {
  // The GO instant is what makes the race fair: both seats count down to one
  // server timestamp, never to their own clock.
  const { emitted } = withFakeIo(() => {
    broadcastMatchEvent("m1", SPEED_TYPING_EVENTS.COUNTDOWN, {
      goAtMs: GO,
      countdownMs: 3_000,
    });
    broadcastMatchEvent("m1", SPEED_TYPING_EVENTS.MATCH_STARTED, { goAtMs: GO });
  });
  assert.equal(emitted[0].payload.goAtMs, GO);
  assert.equal(emitted[0].payload.countdownMs, 3_000);
  assert.equal(emitted[1].payload.goAtMs, GO);
  // No event in the batch carries a client-supplied outcome.
  for (const item of emitted) {
    assert.ok(!("winner" in item.payload));
    assert.ok(!("result" in item.payload));
  }
});

test("lifecycle: the finished event carries the authoritative result only", () => {
  const { emitted } = withFakeIo(() =>
    broadcastMatchEvent("m1", SPEED_TYPING_EVENTS.MATCH_FINISHED, {
      status: "finished",
      result: "player1",
      resolutionReason: "finish",
      winnerSeat: "player1",
      resolvedAtMs: GO + 30_000,
    }),
  );
  const payload = emitted[0].payload;
  assert.equal(payload.result, "player1");
  assert.equal(payload.resolutionReason, "finish");
  assert.ok(payload.resolvedAtMs > 0, "the resolution instant is the server's");
  // The hard limit is a server constant, never a client window.
  assert.ok(RACE_LIMIT_MS > 0);
});
