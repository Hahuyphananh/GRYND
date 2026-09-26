/**
 * Mini Golf — realtime room/broadcast contract tests.
 *
 * The realtime layer is deliberately thin: room naming, the shared
 * `"lobby:updated"` event string, and a broadcast helper that must never throw
 * into an API route. A typo in a room name would silently break the live
 * channel, so the exact strings are pinned here.
 *
 * Run:  node --import tsx --test tests/mini-golf-realtime.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MINI_GOLF_MATCH_ROOM_PREFIX,
  MINI_GOLF_MATCH_UPDATED,
  MINI_GOLF_READY,
  broadcastMatchUpdate,
  miniGolfMatchRoom,
} from "../src/lib/mini-golf/rooms.ts";

/** Install a fake `globalThis.io` and restore it after `fn`. */
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
    return { result: fn(), emitted, previous };
  } finally {
    if (previous === undefined) delete globalThis.io;
    else globalThis.io = previous;
  }
}

test("the mini-golf match room is namespaced per match", () => {
  assert.equal(MINI_GOLF_MATCH_ROOM_PREFIX, "mini-golf:match:");
  assert.equal(miniGolfMatchRoom("abc-123"), "mini-golf:match:abc-123");
  // Distinct matches never share a room.
  assert.notEqual(miniGolfMatchRoom("a"), miniGolfMatchRoom("b"));
});

test("the broadcast event uses the shared lobby:updated string", () => {
  assert.equal(MINI_GOLF_MATCH_UPDATED, "lobby:updated");
  assert.equal(MINI_GOLF_READY, "mini-golf:ready");
});

test("broadcastMatchUpdate silently no-ops without an io instance", () => {
  const previous = globalThis.io;
  delete globalThis.io;
  try {
    // The standard split-process deployment: Next.js has no socket handle.
    assert.equal(broadcastMatchUpdate("m1", { status: "playing" }), false);
  } finally {
    if (previous !== undefined) globalThis.io = previous;
  }
});

test("broadcastMatchUpdate pushes the authoritative summary to the match room", () => {
  const { result, emitted } = withFakeIo(() =>
    broadcastMatchUpdate("match-1", {
      status: "playing",
      version: 4,
      currentTurn: "player2",
      holeCompleted: false,
      matchCompleted: false,
      stages: ["SHOT_RESOLVING", "BALL_SETTLED", "NEXT_PLAYER_TURN"],
    }),
  );

  assert.equal(result, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, "mini-golf:match:match-1");
  assert.equal(emitted[0].event, "lobby:updated");
  assert.equal(emitted[0].payload.matchId, "match-1");
  assert.equal(emitted[0].payload.status, "playing");
  assert.equal(emitted[0].payload.version, 4);
  assert.equal(emitted[0].payload.currentTurn, "player2");
  assert.ok(emitted[0].payload.stages.includes("BALL_SETTLED"));
  assert.equal(typeof emitted[0].payload.sentAt, "string");
});

test("a broadcast must never throw into the calling API route", () => {
  const previous = globalThis.io;
  globalThis.io = {
    to() {
      throw new Error("socket exploded");
    },
  };
  try {
    assert.equal(broadcastMatchUpdate("m1", { status: "playing" }), false);
  } finally {
    if (previous === undefined) delete globalThis.io;
    else globalThis.io = previous;
  }
});

test("a malformed payload is normalised to an empty object", () => {
  const { emitted } = withFakeIo(() => broadcastMatchUpdate("m1", null));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.matchId, "m1");
  assert.ok(!("0" in emitted[0].payload));
});
