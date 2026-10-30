/**
 * tests/native-lifecycle-events.test.mjs
 *
 * Phase 3A — the native lifecycle / network event contract.
 *
 * The plugin-facing logic lives in `startNativeLifecycleWatch` so it can be
 * driven with deterministic doubles instead of a device:
 *
 *   * both initial states are READ and published (never assumed);
 *   * foreground/background and wifi/cellular/none/unknown transitions are
 *     published with exactly the documented payload;
 *   * `stop()` detaches both handles, suppresses later emissions, and removes a
 *     handle that arrives after unmount (the mid-initialisation leak);
 *   * one broken plugin does not take the other down;
 *   * the emitters are silent where there is no DOM (server rendering).
 *
 * The DOM-facing component is checked structurally: it must be client-only,
 * native-only, dynamically import the plugins, register once from the root
 * layout, and add no browser visibility/online listeners of its own.
 *
 * What this file does NOT prove: how Android actually delivers these events.
 * That needs a device or emulator; see the report.
 *
 * Run:  node --import tsx --test tests/native-lifecycle-events.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  APP_STATE_CHANGE_EVENT,
  NETWORK_STATUS_CHANGE_EVENT,
  emitAppStateChange,
  emitNetworkStatusChange,
  normalizeConnectionType,
  startNativeLifecycleWatch,
  subscribeToAppStateChange,
  subscribeToNetworkStatusChange,
} from "../src/lib/native/appLifecycle.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A minimal EventTarget that records events and lets the test fire them. */
function makeTarget() {
  const listeners = new Map();
  const events = [];
  return {
    events,
    dispatchEvent(event) {
      events.push(event);
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

// ── Payloads ──────────────────────────────────────────────────────────────

test("lifecycle events use the documented names and payloads", () => {
  const target = makeTarget();

  emitAppStateChange({ isActive: true }, target);
  emitAppStateChange({ isActive: false }, target);

  assert.equal(APP_STATE_CHANGE_EVENT, "grynd:app-state-change");
  assert.equal(target.events.length, 2);
  assert.ok(target.events[0] instanceof CustomEvent);
  assert.equal(target.events[0].type, APP_STATE_CHANGE_EVENT);
  assert.deepEqual(target.events[0].detail, { isActive: true });
  assert.deepEqual(Object.keys(target.events[0].detail), ["isActive"]);
  assert.deepEqual(target.events[1].detail, { isActive: false });
});

test("network events use the documented names and payloads", () => {
  const target = makeTarget();

  emitNetworkStatusChange({ connected: true, connectionType: "wifi" }, target);
  emitNetworkStatusChange({ connected: true, connectionType: "cellular" }, target);
  emitNetworkStatusChange({ connected: false, connectionType: "none" }, target);

  assert.equal(NETWORK_STATUS_CHANGE_EVENT, "grynd:network-status-change");
  assert.deepEqual(
    target.events.map((event) => event.detail),
    [
      { connected: true, connectionType: "wifi" },
      { connected: true, connectionType: "cellular" },
      { connected: false, connectionType: "none" },
    ],
  );
  assert.ok(target.events.every((event) => event.type === NETWORK_STATUS_CHANGE_EVENT));
});

test("connection types outside the union degrade to unknown", () => {
  assert.equal(normalizeConnectionType("wifi"), "wifi");
  assert.equal(normalizeConnectionType("cellular"), "cellular");
  assert.equal(normalizeConnectionType("none"), "none");
  assert.equal(normalizeConnectionType("unknown"), "unknown");
  // Anything a native bridge could hand over that is not one of ours.
  assert.equal(normalizeConnectionType("ethernet"), "unknown");
  assert.equal(normalizeConnectionType(""), "unknown");
  assert.equal(normalizeConnectionType(undefined), "unknown");
  assert.equal(normalizeConnectionType(null), "unknown");
  assert.equal(normalizeConnectionType(3), "unknown");

  const target = makeTarget();
  emitNetworkStatusChange({ connected: true, connectionType: "ethernet" }, target);
  assert.deepEqual(target.events[0].detail, {
    connected: true,
    connectionType: "unknown",
  });
});

test("emitting without a DOM is a silent no-op (server rendering)", () => {
  // Node has no `window`; the emitters must not throw during SSR.
  assert.equal(typeof globalThis.window, "undefined");
  assert.doesNotThrow(() => emitAppStateChange({ isActive: true }));
  assert.doesNotThrow(() => emitNetworkStatusChange({ connected: false, connectionType: "none" }));
  assert.doesNotThrow(() => subscribeToAppStateChange(() => {})());
});

// ── Subscriptions ─────────────────────────────────────────────────────────

test("subscribers receive typed payloads and unsubscribe cleanly", () => {
  const target = makeTarget();
  const appCalls = [];
  const networkCalls = [];

  const offApp = subscribeToAppStateChange((detail) => appCalls.push(detail), target);
  const offNetwork = subscribeToNetworkStatusChange(
    (detail) => networkCalls.push(detail),
    target,
  );

  emitAppStateChange({ isActive: true }, target);
  emitAppStateChange({ isActive: false }, target);
  emitNetworkStatusChange({ connected: true, connectionType: "wifi" }, target);

  assert.deepEqual(appCalls, [{ isActive: true }, { isActive: false }]);
  assert.deepEqual(networkCalls, [{ connected: true, connectionType: "wifi" }]);

  offApp();
  offNetwork();
  assert.equal(target.listenerCount(APP_STATE_CHANGE_EVENT), 0);
  assert.equal(target.listenerCount(NETWORK_STATUS_CHANGE_EVENT), 0);

  emitAppStateChange({ isActive: true }, target);
  emitNetworkStatusChange({ connected: false, connectionType: "none" }, target);
  assert.deepEqual(appCalls, [{ isActive: true }, { isActive: false }]);
  assert.equal(networkCalls.length, 1);
});

test("a malformed event detail is ignored, not treated as a transition", () => {
  const target = makeTarget();
  const calls = [];
  const off = subscribeToAppStateChange((detail) => calls.push(detail), target);

  target.dispatchEvent(new CustomEvent(APP_STATE_CHANGE_EVENT, { detail: null }));
  target.dispatchEvent(new CustomEvent(APP_STATE_CHANGE_EVENT, {}));
  assert.deepEqual(calls, []);

  off();
});

// ── Plugin binding ────────────────────────────────────────────────────────

/** A deterministic `@capacitor/app` double. */
function makeApp({ state = { isActive: true } } = {}) {
  const calls = { getState: 0, addListener: 0 };
  const listeners = [];
  const removed = [];
  return {
    calls,
    listeners,
    removed,
    async getState() {
      calls.getState += 1;
      return state;
    },
    async addListener(eventName, listener) {
      calls.addListener += 1;
      listeners.push({ eventName, listener });
      return {
        remove() {
          removed.push(eventName);
        },
      };
    },
  };
}

/** A deterministic `@capacitor/network` double. */
function makeNetwork({
  status = { connected: true, connectionType: "wifi" },
} = {}) {
  const calls = { getStatus: 0, addListener: 0 };
  const listeners = [];
  const removed = [];
  return {
    calls,
    listeners,
    removed,
    async getStatus() {
      calls.getStatus += 1;
      return status;
    },
    async addListener(eventName, listener) {
      calls.addListener += 1;
      listeners.push({ eventName, listener });
      return {
        remove() {
          removed.push(eventName);
        },
      };
    },
  };
}

function watchHarness({ app = makeApp(), network = makeNetwork(), onError } = {}) {
  const appStates = [];
  const networkStates = [];
  const stop = startNativeLifecycleWatch({
    app,
    network,
    emitAppState: (detail) => appStates.push(detail),
    emitNetworkStatus: (detail) => networkStates.push(detail),
    onError,
  });
  return { app, network, appStates, networkStates, stop };
}

test("initial states are read and published for both plugins", async () => {
  const { app, network, appStates, networkStates, stop } = watchHarness({
    app: makeApp({ state: { isActive: true } }),
    network: makeNetwork({ status: { connected: true, connectionType: "wifi" } }),
  });
  await flush();

  assert.equal(app.calls.getState, 1);
  assert.equal(network.calls.getStatus, 1);
  assert.deepEqual(appStates, [{ isActive: true }]);
  assert.deepEqual(networkStates, [{ connected: true, connectionType: "wifi" }]);

  stop();
});

test("background and disconnected transitions are published with the documented payload", async () => {
  const { app, network, appStates, networkStates, stop } = watchHarness();
  await flush();

  assert.equal(app.listeners.length, 1);
  assert.equal(network.listeners.length, 1);
  assert.equal(app.listeners[0].eventName, "appStateChange");
  assert.equal(network.listeners[0].eventName, "networkStatusChange");

  // Foreground → background → foreground.
  app.listeners[0].listener({ isActive: false });
  app.listeners[0].listener({ isActive: true });
  assert.deepEqual(appStates, [
    { isActive: true }, // initial read
    { isActive: false },
    { isActive: true },
  ]);

  // Wi-Fi → cellular → no connection → unknown.
  network.listeners[0].listener({ connected: true, connectionType: "cellular" });
  network.listeners[0].listener({ connected: false, connectionType: "none" });
  network.listeners[0].listener({ connected: true, connectionType: "vpn" });
  assert.deepEqual(networkStates, [
    { connected: true, connectionType: "wifi" },
    { connected: true, connectionType: "cellular" },
    { connected: false, connectionType: "none" },
    { connected: true, connectionType: "unknown" },
  ]);

  stop();
});

test("a backgrounded cold start is reported as inactive, not assumed active", async () => {
  const { appStates, networkStates, stop } = watchHarness({
    app: makeApp({ state: { isActive: false } }),
    network: makeNetwork({ status: { connected: false, connectionType: "none" } }),
  });
  await flush();

  assert.deepEqual(appStates, [{ isActive: false }]);
  assert.deepEqual(networkStates, [{ connected: false, connectionType: "none" }]);

  stop();
});

test("stop detaches both listeners and suppresses later emissions", async () => {
  const { app, network, appStates, networkStates, stop } = watchHarness();
  await flush();

  const appListener = app.listeners[0].listener;
  const networkListener = network.listeners[0].listener;

  stop();
  assert.deepEqual(app.removed, ["appStateChange"]);
  assert.deepEqual(network.removed, ["networkStatusChange"]);

  // A native event that races the unmount must not reach the app.
  appListener({ isActive: false });
  networkListener({ connected: false, connectionType: "none" });
  assert.deepEqual(appStates, [{ isActive: true }]);
  assert.deepEqual(networkStates, [{ connected: true, connectionType: "wifi" }]);

  // stop() is idempotent.
  assert.doesNotThrow(() => stop());
});

test("unmounting during initialisation registers nothing", async () => {
  let releaseState;
  const gate = new Promise((resolve) => {
    releaseState = resolve;
  });
  const app = {
    getState: () => gate,
    addListenerCalls: 0,
    async addListener() {
      this.addListenerCalls += 1;
      return { remove() {} };
    },
  };
  const network = makeNetwork();

  const appStates = [];
  const networkStates = [];
  const stop = startNativeLifecycleWatch({
    app,
    network,
    emitAppState: (detail) => appStates.push(detail),
    emitNetworkStatus: (detail) => networkStates.push(detail),
  });

  // Unmount while `getState()` is still pending.
  stop();
  releaseState({ isActive: true });
  await flush();

  assert.equal(app.addListenerCalls, 0, "no listener may be attached after stop()");
  assert.deepEqual(appStates, [], "no state may be published after stop()");
  assert.equal(network.calls.addListener, 0);
  assert.deepEqual(networkStates, []);
});

test("a handle that resolves after unmount is detached immediately", async () => {
  let releaseHandle;
  const handleGate = new Promise((resolve) => {
    releaseHandle = resolve;
  });
  const app = {
    async getState() {
      return { isActive: true };
    },
    async addListener() {
      return handleGate;
    },
  };
  const removed = [];
  const network = makeNetwork();

  const stop = startNativeLifecycleWatch({
    app,
    network,
    emitAppState: () => {},
    emitNetworkStatus: () => {},
  });

  await flush(); // getState resolved, addListener still pending
  stop();
  releaseHandle({ remove: () => removed.push("appStateChange") });
  await flush();

  assert.deepEqual(removed, ["appStateChange"], "the late handle must be removed");
});

test("one failing plugin does not disable the other", async () => {
  const app = {
    async getState() {
      throw new Error("app plugin unavailable");
    },
    async addListener() {
      throw new Error("app plugin unavailable");
    },
  };
  const network = makeNetwork();
  const errors = [];

  const appStates = [];
  const networkStates = [];
  const stop = startNativeLifecycleWatch({
    app,
    network,
    emitAppState: (detail) => appStates.push(detail),
    emitNetworkStatus: (detail) => networkStates.push(detail),
    onError: (error) => errors.push(error),
  });
  await flush();

  assert.deepEqual(appStates, []);
  assert.deepEqual(networkStates, [{ connected: true, connectionType: "wifi" }]);
  assert.ok(errors.length >= 1, "the failure is reported through onError");
  assert.match(String(errors[0]), /app plugin unavailable/);

  stop();
});

test("a throwing onError callback cannot break the bridge", async () => {
  const app = makeApp();
  const network = makeNetwork();
  const appStates = [];
  const networkStates = [];

  const stop = startNativeLifecycleWatch({
    app: {
      getState: async () => {
        throw new Error("nope");
      },
      addListener: app.addListener.bind(app),
    },
    network,
    emitAppState: (detail) => appStates.push(detail),
    emitNetworkStatus: (detail) => networkStates.push(detail),
    onError: () => {
      throw new Error("broken diagnostics");
    },
  });

  await flush();
  assert.deepEqual(networkStates, [{ connected: true, connectionType: "wifi" }]);
  stop();
});

// ── Mount point and browser safety ────────────────────────────────────────

test("the bridge is client-only, native-only, and adds no browser listeners", () => {
  const bridge = read("src/components/native/NativeLifecycleBridge.tsx");

  assert.match(bridge, /^"use client";/m);
  assert.match(bridge, /typeof window === "undefined"/);
  assert.match(bridge, /Capacitor\.isNativePlatform\(\)/);
  assert.match(bridge, /import\("@capacitor\/app"\)/);
  assert.match(bridge, /import\("@capacitor\/network"\)/);
  assert.match(bridge, /return null;/);
  assert.match(bridge, /stopWatch\?\.\(\)/);

  // Browsers keep their existing mechanisms. The bridge must register NO
  // browser listener of its own — the only listeners it creates are the
  // native plugin ones. (Comments are allowed to name the web mechanisms; the
  // assertions therefore look for wiring, not for words.)
  assert.ok(!/addEventListener\s*\(/.test(bridge));
  assert.ok(!/visibilitychange/.test(bridge));
  assert.ok(!/document\./.test(bridge));
  assert.ok(!/window\.addEventListener/.test(bridge));
});

test("the bridge is mounted exactly once, from the root layout", () => {
  const layout = read("src/app/layout.tsx");
  const mounts = layout.match(/<NativeLifecycleBridge\s*\/>/g) ?? [];

  assert.equal(mounts.length, 1);
  assert.match(
    layout,
    /import NativeLifecycleBridge from "\.\.\/components\/native\/NativeLifecycleBridge"/,
  );
  // Mounted alongside the other render-nothing root effects, not inside a
  // route, so client-side navigation cannot remount it.
  assert.match(layout, /<MatchEntryGuard \/>[\s\S]{0,400}<NativeLifecycleBridge \/>/);
});

test("Socket.IO behaviour and configuration are untouched", () => {
  const socket = read("src/lib/socket.ts");

  // Phase 3B owns reconnection. Nothing native may leak into the socket module.
  assert.ok(!/@capacitor/.test(socket));
  assert.ok(!/grynd:app-state-change|grynd:network-status-change/.test(socket));
  assert.match(socket, /reconnectionAttempts: 10/);
  assert.match(socket, /reconnectionDelayMax: 4000/);
  assert.match(socket, /transports: \["websocket", "polling"\]/);
  assert.match(socket, /auth: \{\s*token,?\s*\}/);
});
