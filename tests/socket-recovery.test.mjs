/**
 * tests/socket-recovery.test.mjs
 *
 * Phase 3B — recovery of the existing Socket.IO connection when the native app
 * resumes or the network returns.
 *
 * `createSocketRecovery` is driven with deterministic doubles (clock, socket,
 * token source, connection helper), so the decision rules can be checked
 * without a device, a browser or a server:
 *
 *   * a connected socket is never touched (no token fetch, no re-connect);
 *   * a disconnected one is revived with the existing helper and a fresh token;
 *   * foreground and network triggers behave identically, per the contract;
 *   * a burst of events costs ONE attempt;
 *   * no token means no attempt; a failure is reported, not thrown;
 *   * dispose() stops everything and drops late results.
 *
 * The wiring is checked structurally, because there is one of it and it lives
 * in the root provider: the recovery effect consumes the Phase 3A helpers (and
 * nothing else), adds no second socket, emits no event of its own, and is
 * cleaned up.
 *
 * What this file does NOT prove: real Android lifecycle delivery, Clerk token
 * freshness on a real device, or two-player reconnection. Those need an
 * emulator/device and a second client; see the report.
 *
 * Run:  node --import tsx --test tests/socket-recovery.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  RECOVERY_MIN_INTERVAL_MS,
  createSocketRecovery,
} from "../src/lib/native/socketRecovery.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Comments in these modules intentionally NAME the things they must not do
 * (`user:join`, the bridge, `.emit`), so the structural guards below run
 * against code only.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Harness: a controllable clock, one shared socket stand-in, and counters for
 * every collaborator the controller is allowed to touch. The socket is mutable
 * so a test can model Socket.IO healing (or dying) on its own.
 */
function makeHarness({
  connected = false,
  token = "clerk-token",
  createResult = "socket",
  createThrows = false,
  tokenThrows = false,
} = {}) {
  const state = {
    token,
    tokens: [],
    connects: [],
    errors: [],
    now: 1_000_000,
  };

  const socket = { connected, connectCalls: 0, auth: null };

  const controller = createSocketRecovery({
    getSocket: () => socket,
    getToken: async () => {
      if (tokenThrows) throw new Error("clerk unavailable");
      return state.token;
    },
    createConnection: async (received) => {
      state.tokens.push(received);
      if (createThrows) throw new Error("connect failed");
      if (createResult === null) return null;
      state.connects.push(received);
      // The real helper refreshes auth on the SAME instance and requests a
      // connect; it never builds a second client.
      socket.auth = { token: received };
      socket.connectCalls += 1;
      return socket;
    },
    minIntervalMs: RECOVERY_MIN_INTERVAL_MS,
    now: () => state.now,
    onError: (error) => state.errors.push(error),
  });

  return { controller, socket, state };
}

// ── Foreground ────────────────────────────────────────────────────────────

test("foreground with a healthy socket does nothing at all", async () => {
  const { controller, socket, state } = makeHarness({ connected: true });

  const outcome = await controller.recover("foreground");

  assert.equal(outcome, "connected");
  assert.equal(state.connects.length, 0, "a healthy socket must not be re-connected");
  assert.deepEqual(state.tokens, [], "no Clerk round-trip for a healthy socket");
  assert.equal(socket.connectCalls, 0, "connect() must not be called");
  assert.equal(controller.attemptCount(), 0);
});

test("foreground with a disconnected socket revives it with a fresh token", async () => {
  const { controller, socket, state } = makeHarness({
    connected: false,
    token: "fresh-clerk-token",
  });

  const outcome = await controller.recover("foreground");

  assert.equal(outcome, "recovered");
  assert.deepEqual(state.connects, ["fresh-clerk-token"]);
  assert.equal(socket.connectCalls, 1);
  assert.deepEqual(socket.auth, { token: "fresh-clerk-token" });
  assert.equal(controller.attemptCount(), 1);
});

test("a controller nobody asks cannot connect", async () => {
  // The provider triggers on the `isActive: true` / `connected: true` edges
  // only; containing the background and dropout edges is what keeps this from
  // racing Socket.IO's own backoff.
  const { controller, state } = makeHarness({ connected: false });
  await flush();
  assert.equal(state.connects.length, 0);
  assert.equal(controller.attemptCount(), 0);
});

// ── Network restoration ───────────────────────────────────────────────────

test("network restoration with a disconnected socket revives it", async () => {
  const { controller, state } = makeHarness({ connected: false });

  const outcome = await controller.recover("network");

  assert.equal(outcome, "recovered");
  assert.equal(state.connects.length, 1);
  assert.equal(controller.attemptCount(), 1);
});

test("network restoration with a healthy socket does nothing", async () => {
  const { controller, state } = makeHarness({ connected: true });

  assert.equal(await controller.recover("network"), "connected");
  assert.equal(state.connects.length, 0);
  assert.deepEqual(state.tokens, []);
});

// ── Duplicates and races ──────────────────────────────────────────────────

test("a burst of foreground and network events costs one attempt", async () => {
  const { controller, state } = makeHarness({ connected: false });

  const outcomes = await Promise.all([
    controller.recover("foreground"),
    controller.recover("network"),
    controller.recover("foreground"),
    controller.recover("foreground"),
    controller.recover("network"),
  ]);

  assert.equal(state.connects.length, 1, "exactly one connection attempt");
  assert.equal(controller.attemptCount(), 1);
  assert.ok(outcomes.every((outcome) => outcome === "recovered"), outcomes.join(","));
});

test("a slow in-flight recovery is joined, not restarted", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const controller = createSocketRecovery({
    getSocket: () => ({ connected: false }),
    getToken: async () => "token",
    createConnection: async (token) => {
      calls.push(token);
      await gate;
      return { connected: true };
    },
  });

  const first = controller.recover("foreground");
  const second = controller.recover("network");
  assert.equal(first, second, "the second call must receive the same promise");

  release();
  assert.equal(await first, "recovered");
  assert.equal(await second, "recovered");
  assert.deepEqual(calls, ["token"]);
  assert.equal(controller.attemptCount(), 1);
});

test("sequential events inside the quiet window are throttled, then allowed", async () => {
  const { controller, state } = makeHarness({ connected: false });

  assert.equal(await controller.recover("foreground"), "recovered");

  state.now += RECOVERY_MIN_INTERVAL_MS - 1;
  assert.equal(await controller.recover("network"), "throttled");
  assert.equal(state.connects.length, 1);
  assert.equal(controller.attemptCount(), 1);

  state.now += 1; // exactly at the boundary
  assert.equal(await controller.recover("network"), "recovered");
  assert.equal(state.connects.length, 2);
});

test("a socket that healed on its own wins over a pending attempt", async () => {
  const { controller, socket, state } = makeHarness({ connected: false });

  // Socket.IO's own backoff succeeded before the quiet window elapsed.
  socket.connected = true;

  assert.equal(await controller.recover("foreground"), "connected");
  assert.equal(state.connects.length, 0);
});

test("repeat recovery reuses the one client instead of building another", async () => {
  const { controller, socket, state } = makeHarness({ connected: false });

  await controller.recover("foreground");
  state.now += RECOVERY_MIN_INTERVAL_MS;
  const second = await controller.recover("network");

  assert.equal(second, "recovered");
  // The helper returned the SAME object both times. That is what makes
  // coexisting with Socket.IO's own retry loop safe: `Socket#connect()` is a
  // no-op while the manager is reconnecting, and creates no second client.
  assert.equal(state.connects.length, 2);
  assert.equal(socket.connectCalls, 2);
});

// ── Authentication ────────────────────────────────────────────────────────

test("no token means no attempt, and signing in later can still recover", async () => {
  const { controller, state } = makeHarness({ connected: false, token: null });

  assert.equal(await controller.recover("foreground"), "signed-out");
  assert.equal(state.connects.length, 0);
  assert.equal(controller.attemptCount(), 0);

  // A signed-out probe must not consume the quiet window.
  state.token = "signed-in-now";
  assert.equal(await controller.recover("foreground"), "recovered");
  assert.deepEqual(state.connects, ["signed-in-now"]);
});

test("a Clerk failure is reported, not thrown, and does not connect", async () => {
  const { controller, state } = makeHarness({ connected: false, tokenThrows: true });

  assert.equal(await controller.recover("foreground"), "failed");
  assert.equal(state.connects.length, 0);
  assert.equal(state.errors.length, 1);
  assert.match(String(state.errors[0]), /clerk unavailable/);
});

test("the token is passed through unchanged, with no second auth mechanism", async () => {
  const { controller, state } = makeHarness({
    connected: false,
    token: "eyJhbGciOi.payload.signature",
  });

  await controller.recover("foreground");
  assert.deepEqual(state.tokens, ["eyJhbGciOi.payload.signature"]);

  const source = read("src/lib/native/socketRecovery.ts");
  assert.ok(!/localStorage|sessionStorage/.test(source), "the token is never stored");
  assert.ok(!/document\.cookie/.test(source), "the token is never read from a cookie");
  assert.ok(!/Authorization/i.test(source), "no ad-hoc auth header");
  assert.ok(!/console\.(log|info|warn|error)/.test(source), "the token is never logged");
  assert.match(source, /getToken\(\)/, "recovery uses the existing Clerk accessor");
});

// ── Failures ──────────────────────────────────────────────────────────────

test("an unavailable realtime configuration reports unavailable", async () => {
  const { controller, state } = makeHarness({ connected: false, createResult: null });

  assert.equal(await controller.recover("foreground"), "unavailable");
  assert.equal(state.errors.length, 0, "a missing socket URL is not an error");
});

test("a throwing connection helper is reported, not thrown", async () => {
  const { controller, state } = makeHarness({ connected: false, createThrows: true });

  assert.equal(await controller.recover("foreground"), "failed");
  assert.equal(state.errors.length, 1);
});

test("a throwing onError callback cannot break recovery", async () => {
  const controller = createSocketRecovery({
    getSocket: () => ({ connected: false }),
    getToken: async () => {
      throw new Error("nope");
    },
    createConnection: async () => ({ connected: true }),
    onError: () => {
      throw new Error("broken diagnostics");
    },
  });

  assert.equal(await controller.recover("foreground"), "failed");
});

// ── Cleanup ───────────────────────────────────────────────────────────────

test("dispose stops every future attempt and drops a late result", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const connects = [];
  const controller = createSocketRecovery({
    getSocket: () => ({ connected: false }),
    getToken: async () => "token",
    createConnection: async (token) => {
      connects.push(token);
      await gate;
      return { connected: true };
    },
  });

  const pending = controller.recover("foreground");
  await flush(); // token resolved, createConnection now awaiting the gate
  controller.dispose();
  release();

  assert.equal(await pending, "disposed", "an unmounted component gets no result to act on");
  assert.equal(connects.length, 1, "the attempt already under way is the only one");
  assert.equal(controller.isDisposed(), true);
  assert.equal(await controller.recover("foreground"), "disposed");
  assert.equal(connects.length, 1, "no attempt is started after dispose");
});

// ── Wiring ────────────────────────────────────────────────────────────────

test("the provider consumes the Phase 3A events and adds no second bridge", () => {
  const provider = read("src/context/SocketProvider.tsx");

  assert.match(provider, /subscribeToAppStateChange/);
  assert.match(provider, /subscribeToNetworkStatusChange/);
  assert.match(provider, /createSocketRecovery/);
  assert.match(provider, /controller\.recover\("foreground"\)/);
  assert.match(provider, /controller\.recover\("network"\)/);

  // One provider, one socket module: no duplicate client can be created.
  assert.equal((provider.match(/export function SocketProvider/g) ?? []).length, 1);
  assert.match(provider, /createSocketConnection/);
  assert.ok(!/new SocketProvider|SocketProvider2/.test(provider));
  assert.ok(!/@capacitor/.test(provider), "the provider never touches native plugins");
  assert.ok(
    !/<NativeLifecycleBridge/.test(stripComments(provider)),
    "the bridge stays mounted once in the root layout, not inside the provider",
  );
  // The single shared instance, never a page-local one.
  assert.match(provider, /getSocket,/);
});

test("recovery never replays a join, a move, a bet or a matchmaking request", () => {
  const source = stripComments(read("src/lib/native/socketRecovery.ts"));

  assert.ok(!/\.emit\s*\(/.test(source), "recovery emits nothing at all");
  assert.ok(!/user:join|join_room|leave_room|room_event/.test(source));
  assert.ok(!/fetch\s*\(/.test(source), "recovery makes no HTTP request");
  assert.ok(!/roomId|matchId/.test(source), "recovery knows nothing about rooms or matches");
});

test("`user:join` is still emitted exactly once, from the connect handler", () => {
  const provider = read("src/context/SocketProvider.tsx");

  const emitted = provider.match(/emit\("user:join"\)/g) ?? [];
  assert.equal(emitted.length, 1, "no second unconditional user:join emitter");
  assert.match(provider, /const joinUserRoom = \(\) => socket\.emit\("user:join"\);/);
  assert.match(provider, /joinUserRoom\(\);[\s\S]{0,80}socket\.on\("connect", joinUserRoom\);/);
});

test("the recovery effect cleans up both listeners and the controller", () => {
  const provider = read("src/context/SocketProvider.tsx");

  assert.match(provider, /const offAppState = subscribeToAppStateChange/);
  assert.match(provider, /const offNetwork = subscribeToNetworkStatusChange/);
  assert.match(
    provider,
    /return \(\) => \{\s*offAppState\(\);\s*offNetwork\(\);\s*controller\.dispose\(\);\s*\};/,
  );
  // Subscribed only with a session, so a signed-out visitor never fetches.
  assert.match(provider, /if \(!isLoaded \|\| !isSignedIn\) return undefined;/);

  // The provider is not allowed to read env directly (Clerk supplies the
  // token); `tests/speed-typing-deployment.test.mjs` enforces this too.
  assert.ok(
    !/process\.env/.test(stripComments(provider)),
    "the provider must read no env directly",
  );
});

test("the existing Socket.IO configuration is preserved", () => {
  const socket = read("src/lib/socket.ts");

  assert.match(socket, /reconnectionAttempts: 10/);
  assert.match(socket, /reconnectionDelay: 1000/);
  assert.match(socket, /reconnectionDelayMax: 4000/);
  assert.match(socket, /transports: \["websocket", "polling"\]/);
  assert.match(socket, /auth: \{\s*token,?\s*\}/);

  // The revive path recovery depends on: same instance, refreshed auth.
  assert.match(socket, /if \(socketInstance\?\.connected\) \{[\s\S]{0,40}return socketInstance;/);
  assert.match(
    socket,
    /if \(socketInstance && !socketInstance\.connected\) \{[\s\S]{0,120}socketInstance\.auth = \{ token \};[\s\S]{0,80}socketInstance\.connect\(\);/,
  );
  // A new client is only ever built when there is none.
  assert.equal((socket.match(/io\(socketUrl/g) ?? []).length, 1);
  assert.ok(!/localStorage|sessionStorage/.test(socket));
});

test("every game that owns a room re-joins it on the socket's own connect event", () => {
  // This is the established recovery protocol recovery relies on: the server
  // does not restore rooms, the client re-emits the join on `connect`. If a
  // page stopped doing this, a revived socket would come back with no room.
  const pages = [
    "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
    "src/app/casino/odds/game/[matchId]/PageClient.tsx",
    "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
    "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
    "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx",
  ];

  for (const page of pages) {
    assert.match(
      read(page),
      /socket\.on\("connect",/,
      `${page} must re-join its room when the socket reconnects`,
    );
  }
});

test("the reusable connection indicator is not duplicated by this phase", () => {
  // `useSocketConnected` (src/hooks/useVisiblePoll.ts) is already the reactive
  // socket-state primitive a future mobile banner should read, so no second
  // one is introduced here.
  const source = read("src/hooks/useVisiblePoll.ts");
  assert.match(source, /export function useSocketConnected/);

  const recovery = read("src/lib/native/socketRecovery.ts");
  assert.ok(!/useState|useEffect|createContext/.test(recovery), "no UI state in the controller");
});
