// tests/creator-mode-client.test.mjs
//
// Unit tests for the Creator Mode client transport
// (src/lib/creator-mode/client.ts).
//
// Regression guard for the "creator mode doesn't activate on a combined
// lobby + game route (Dice Flush)" bug: arming the mode from a toggle
// rendered on the SAME page must notify the mounted CreatorModeProvider,
// because that provider otherwise only reads the stored flag once on
// mount. setStoredCreatorMode therefore dispatches
// CREATOR_MODE_CHANGED_EVENT with the explicit enabled state.

import test from "node:test";
import assert from "node:assert/strict";

// ── Minimal browser stubs (installed before the module is imported) ──

const store = new Map();
const dispatched = [];

globalThis.window = {
  sessionStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  dispatchEvent: (event) => {
    dispatched.push(event);
    return true;
  },
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const {
  CREATOR_MODE_CHANGED_EVENT,
  getStoredCreatorMode,
  setStoredCreatorMode,
} = await import("../src/lib/creator-mode/client.ts");

const USER_ID = "user_123";

test("enabling creator mode persists the flag and notifies same-page providers", () => {
  dispatched.length = 0;
  setStoredCreatorMode(USER_ID, true);

  assert.equal(getStoredCreatorMode(USER_ID), true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, CREATOR_MODE_CHANGED_EVENT);
  assert.deepEqual(dispatched[0].detail, { enabled: true });
});

test("disabling creator mode clears the flag and reports enabled: false", () => {
  setStoredCreatorMode(USER_ID, true);

  dispatched.length = 0;
  setStoredCreatorMode(USER_ID, false);

  assert.equal(getStoredCreatorMode(USER_ID), false);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].detail, { enabled: false });
});

test("the flag is scoped per user and never written without a user id", () => {
  setStoredCreatorMode(USER_ID, true);
  assert.equal(getStoredCreatorMode("someone_else"), false);
  assert.equal(getStoredCreatorMode(null), false);

  dispatched.length = 0;
  setStoredCreatorMode(null, true);
  assert.equal(dispatched.length, 0);
  assert.equal(getStoredCreatorMode(USER_ID), true);
});
