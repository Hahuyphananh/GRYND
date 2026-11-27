/**
 * native-keyboard.test.mjs
 *
 * The keyboard contract the mobile shell depends on. The bridge observes the
 * native keyboard and publishes ONE deduped state; the OS already resized the
 * WebView (`adjustResize`), so the app must not scroll, focus or shift anything
 * a second time.
 *
 * These exercise the real module (it has no DOM dependency) rather than
 * grepping for strings — the dangerous regressions are behavioural: a second
 * publish for the same state, a publish after unmount, a listener left behind.
 *
 * Run:  node --import tsx --test tests/native-keyboard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  KEYBOARD_CLOSED,
  normalizeKeyboardHeight,
  startNativeKeyboardWatch,
} from "../src/lib/native/keyboard.ts";

const stripComments = (src) =>
  src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A fake plugin that records listeners so they can be fired by hand. */
function fakeKeyboard() {
  const listeners = new Map();
  const removed = [];
  return {
    removed,
    fire(event, info) {
      for (const fn of listeners.get(event) || []) fn(info);
    },
    plugin: {
      addListener: async (event, fn) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return { remove: async () => removed.push(event) };
      },
    },
  };
}

test("normalizeKeyboardHeight treats the bridge value as untrusted", () => {
  assert.equal(normalizeKeyboardHeight(undefined), 0);
  assert.equal(normalizeKeyboardHeight("320"), 0);
  assert.equal(normalizeKeyboardHeight(Number.NaN), 0);
  assert.equal(normalizeKeyboardHeight(-1), 0);
  assert.equal(normalizeKeyboardHeight(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeKeyboardHeight(287.6), 288);
});

test("Will/Did pairs collapse into one state and hide resets it", async () => {
  const kb = fakeKeyboard();
  const states = [];
  const stop = startNativeKeyboardWatch({ keyboard: kb.plugin, onState: (s) => states.push(s) });
  await new Promise((r) => setTimeout(r, 0));

  kb.fire("keyboardWillShow", { keyboardHeight: 300 });
  kb.fire("keyboardDidShow", { keyboardHeight: 300 });
  kb.fire("keyboardWillHide");
  kb.fire("keyboardDidHide");

  assert.deepEqual(states, [
    { open: true, height: 300 },
    KEYBOARD_CLOSED,
  ]);
  stop();
});

test("stop() detaches every listener and suppresses later publishes", async () => {
  const kb = fakeKeyboard();
  const states = [];
  const stop = startNativeKeyboardWatch({ keyboard: kb.plugin, onState: (s) => states.push(s) });
  await new Promise((r) => setTimeout(r, 0));
  stop();
  stop(); // idempotent

  assert.deepEqual(kb.removed.sort(), [
    "keyboardDidHide",
    "keyboardDidShow",
    "keyboardWillHide",
    "keyboardWillShow",
  ]);
  kb.fire("keyboardWillShow", { keyboardHeight: 300 });
  assert.deepEqual(states, []);
});

test("a failing listener registration is reported, not thrown, and the rest still attach", async () => {
  const errors = [];
  const attached = [];
  const plugin = {
    addListener: async (event) => {
      if (event === "keyboardWillShow") throw new Error("bridge down");
      attached.push(event);
      return { remove: async () => {} };
    },
  };
  const stop = startNativeKeyboardWatch({
    keyboard: plugin,
    onState: () => {},
    onError: (e) => errors.push(e),
  });
  await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.equal(errors.length, 1);
  assert.deepEqual(attached, ["keyboardDidShow", "keyboardWillHide", "keyboardDidHide"]);
});

test("the keyboard module itself never focuses or scrolls the page", () => {
  const code = stripComments(fs.readFileSync("src/lib/native/keyboard.ts", "utf8"));
  assert.doesNotMatch(code, /\.focus\(/);
  assert.doesNotMatch(code, /scrollIntoView\(/);
  assert.doesNotMatch(code, /window\.scroll(To)?\(/);
});

test("the game board never reads the keyboard contract", () => {
  const board = fs.readFileSync("src/components/solitaire-duel/SolitaireBoard.tsx", "utf8");
  assert.doesNotMatch(board, /--keyboard-height/);
  assert.doesNotMatch(board, /data-keyboard/);
});
