// tests/precision-stop-transport.test.mjs
//
// Regression tests for the Precision STOP transport.
//
// Reported bug: pressing STOP showed
//     "Network timeout — server didn't ACK within 4000ms. Please try again."
// and the round was lost.
//
// Why it happened: `emitStop` used `socket.timeout(4000)` and treated a missing
// ACK as a dead end. But `socket.timeout()` only proves the SOCKET answered,
// not that the stop reached the server. Socket.IO buffers emits while the
// transport is down and replays them on reconnect, so a blip at the wrong
// instant produced the error AND (later) a packet graded against an elapsed
// time that had nothing to do with the click. The player's stop was simply
// gone.
//
// The fix: an ACK timeout re-submits the SAME stop (same roundId + nonce) over
// HTTPS via `submitStopOverHttp`, which needs no socket. The server keeps one
// stop per seat per round, so a stop that did land comes back as
// `alreadySubmitted` and is reported as success — never double-counted, never
// shown as an error.
//
// Also pinned here: the client's ACK window must sit ABOVE the realtime
// server's own forward bound, so the proxy's richer error wins the race instead
// of the client giving up first.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  emitStop,
  submitStopOverHttp,
  STOP_ACK_TIMEOUT_MS,
  STOP_HTTP_TIMEOUT_MS,
} from "../src/lib/precision/multiplayer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Minimal Socket.IO client double: records the emit and hands the test the
 *  ACK callback so it can decide whether (and when) the server answers. */
function fakeSocket() {
  const socket = {
    emitted: [],
    timeoutMs: null,
    ackCallback: null,
    timeout(ms) {
      socket.timeoutMs = ms;
      return socket;
    },
    emit(event, payload, callback) {
      socket.emitted.push({ event, payload });
      socket.ackCallback = callback ?? null;
      return socket;
    },
  };
  return socket;
}

/** Stub `fetch` and record every call. */
function withFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { json: async () => handler(String(url), options) };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function stopAck(socket) {
  return new Promise((resolve) => {
    // Argument order: (socket, matchId, roundId, nonce, elapsedMs, onAck). The
    // frozen-elapsed hint was inserted before the ACK callback, so the callback
    // has to be passed in the LAST slot — passing it fifth made `onAck`
    // undefined and every ACK-path test below blow up on a dead socket double.
    emitStop(socket, "match-1", "round-1", "nonce-1", null, resolve);
  });
}

test("a healthy ACK never touches the HTTP fallback", async () => {
  const socket = fakeSocket();
  const pending = stopAck(socket);
  const net = withFetch(() => {
    throw new Error("the fallback must not run");
  });
  try {
    socket.ackCallback(null, { success: true });
    assert.deepEqual(await pending, { success: true });
    assert.equal(net.calls.length, 0);
    assert.equal(socket.timeoutMs, STOP_ACK_TIMEOUT_MS);
    assert.equal(socket.emitted[0].event, "precision:stop");
    // The stop packet carries the replay envelope and nothing else.
    assert.deepEqual(socket.emitted[0].payload, {
      matchId: "match-1",
      roundId: "round-1",
      nonce: "nonce-1",
    });
  } finally {
    net.restore();
  }
});

test("a missing ACK re-submits the stop over HTTPS instead of dropping it", async () => {
  const socket = fakeSocket();
  const pending = stopAck(socket);
  const net = withFetch(() => ({ success: true, bothStopped: false }));
  try {
    socket.ackCallback(new Error("operation has timed out"), undefined);
    assert.deepEqual(await pending, { success: true });
    assert.equal(net.calls.length, 1);
    assert.match(net.calls[0].url, /\/api\/precision\/round-stop$/);
    // Same envelope, so the server's replay protection treats a double
    // delivery as a duplicate rather than a second stop.
    assert.deepEqual(JSON.parse(net.calls[0].options.body), {
      matchId: "match-1",
      roundId: "round-1",
      nonce: "nonce-1",
    });
  } finally {
    net.restore();
  }
});

test("a stop that already landed is reported as success, not as an error", async () => {
  const socket = fakeSocket();
  const pending = stopAck(socket);
  const net = withFetch(() => ({
    success: false,
    alreadySubmitted: true,
    error: "A stop packet has already been submitted for this round.",
  }));
  try {
    socket.ackCallback(new Error("timeout"), undefined);
    // The click DID reach the server (the ACK is what got lost).
    assert.deepEqual(await pending, { success: true });
  } finally {
    net.restore();
  }
});

test("when both transports fail the player gets a real, retryable error", async () => {
  const socket = fakeSocket();
  const pending = stopAck(socket);
  const net = withFetch(() => ({ success: false, error: "Match is not active (phase=finished)." }));
  try {
    socket.ackCallback(new Error("timeout"), undefined);
    const ack = await pending;
    assert.equal(ack.success, false);
    assert.equal(ack.error, "Match is not active (phase=finished).");
  } finally {
    net.restore();
  }
});

test("a rejected backup request still surfaces a timeout the player can retry", async () => {
  const socket = fakeSocket();
  const pending = stopAck(socket);
  const net = withFetch(() => {
    throw new Error("network down");
  });
  try {
    socket.ackCallback(new Error("timeout"), undefined);
    const ack = await pending;
    assert.equal(ack.success, false);
    assert.match(ack.error, /Please try again\.$/);
    assert.equal(ack.error.includes("didn't ACK within"), true);
  } finally {
    net.restore();
  }
});

test("an explicit refusal from the server is authoritative and is not retried", async () => {
  const socket = fakeSocket();
  const pending = stopAck(socket);
  const net = withFetch(() => {
    throw new Error("must not re-submit behind the player's back");
  });
  try {
    // err === null means the realtime server DID answer — it just said no
    // (stale roundId/nonce, duplicate, not a participant, its own proxy
    // timeout). That verdict stands.
    socket.ackCallback(null, {
      success: false,
      error: "Nonce mismatch. Stop packet rejected (possible replay).",
    });
    const ack = await pending;
    assert.equal(ack.success, false);
    assert.equal(ack.error, "Nonce mismatch. Stop packet rejected (possible replay).");
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("the frozen elapsed rides along with the stop (the server's only timing hint)", () => {
  // The click is measured on the client's server-aligned clock and shipped with
  // the stop, because the packet needs one delivery to reach the server. The
  // server clamps it against its own measurement (see `resolveStopElapsedMs`),
  // so this value must survive transport verbatim — rounded to a whole ms.
  const socket = fakeSocket();
  emitStop(socket, "match-1", "round-1", "nonce-1", 7_050.4, () => {});
  assert.deepEqual(socket.emitted[0].payload, {
    matchId: "match-1",
    roundId: "round-1",
    nonce: "nonce-1",
    elapsedMs: 7050,
  });
});

test("a fire-and-forget stop stays a plain emit", () => {
  const socket = fakeSocket();
  emitStop(socket, "match-1", "round-1", "nonce-1");
  assert.equal(socket.timeoutMs, null);
  assert.equal(socket.emitted.length, 1);
  assert.equal(socket.emitted[0].event, "precision:stop");
});

test("submitStopOverHttp is session-authenticated and carries no client timing", async () => {
  const net = withFetch(() => ({ success: true }));
  try {
    await submitStopOverHttp("match-9", "round-9", "nonce-9");
    assert.equal(net.calls.length, 1);
    const call = net.calls[0];
    assert.match(call.url, /\/api\/precision\/round-stop$/);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.credentials, "include");
    const body = JSON.parse(call.options.body);
    assert.deepEqual(body, {
      matchId: "match-9",
      roundId: "round-9",
      nonce: "nonce-9",
    });
    // The route resolves the caller from the Clerk session; a client-supplied
    // userId or stopMs would be an invitation to spoof the round.
    assert.equal("userId" in body, false);
    assert.equal("stopMs" in body, false);
  } finally {
    net.restore();
  }
});

test("the HTTP fallback is bounded so the STOP button can never hang", () => {
  assert.ok(STOP_HTTP_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(STOP_HTTP_TIMEOUT_MS));
  const source = readFileSync(join(root, "src/lib/precision/multiplayer.ts"), "utf8");
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\.abort\(\)/);
});

test("the client waits longer than the realtime server's own forward bound", () => {
  // realtime-server/server.js aborts its Next.js proxy after this many ms and
  // then ACKs its own error. If the client gave up first, that verdict would
  // never reach the player and every slow round would look like a dead socket.
  const server = readFileSync(join(root, "realtime-server/server.js"), "utf8");
  const precisionStop = server.slice(server.indexOf('socket.on("precision:stop"'));
  const forwardBound = Number(
    precisionStop.match(/setTimeout\(\s*\(\)\s*=>\s*forwardController\.abort\(\),\s*(\d+)/)?.[1],
  );
  assert.ok(
    Number.isFinite(forwardBound) && forwardBound > 0,
    "could not read the realtime server's precision:stop forward bound",
  );
  assert.ok(
    STOP_ACK_TIMEOUT_MS > forwardBound,
    `client ACK window (${STOP_ACK_TIMEOUT_MS}ms) must exceed the server forward bound (${forwardBound}ms)`,
  );
});

test("the round-stop route reports alreadySubmitted on the refusal path too", () => {
  // Without this the HTTPS fallback cannot tell "your stop is already recorded"
  // from "your stop was rejected", and a lost ACK would show the player an
  // error for a round the server had accepted.
  const route = readFileSync(join(root, "src/app/api/precision/round-stop/route.ts"), "utf8");
  assert.match(route, /alreadySubmitted: result\.alreadySubmitted/);
});
