/**
 * tests/android-keyboard.test.mjs
 *
 * Phase 5B — native keyboard state inside the Android WebView.
 *
 * The important assertions here are about what the code REFUSES to do. The
 * resize is native (`windowSoftInputMode="adjustResize"` + the Keyboard
 * plugin's `resizeOnFullScreen` workaround), so this phase adds no scrolling,
 * no focus management and no layout shift — each of which would fight the OS
 * and produce exactly the jumps it is meant to remove. The tests therefore pin
 * the absence of those behaviours as hard as they pin the state contract.
 *
 *   * `startNativeKeyboardWatch` (behavioural, with doubles): show/hide state
 *     with a normalised height, Android's Will/Did pairs collapsing into ONE
 *     transition, repeated events not re-publishing, stop() detaching every
 *     handle, a handle that resolves after stop() detached immediately, and a
 *     broken callback not taking the others down.
 *   * the component (structural): native-only, lazily imported, state-only,
 *     with no keydown/focus/scroll engine and no gameplay coupling.
 *   * the native configuration: adjustResize on the activity, the documented
 *     Android resize workaround, and the untouched app identity.
 *
 * What this file cannot prove: how the IME behaves over a real board or chat
 * composer. That needs a device or emulator; see the report.
 *
 * Run:  node --import tsx --test tests/android-keyboard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  KEYBOARD_CLOSED,
  KEYBOARD_EVENTS,
  normalizeKeyboardHeight,
  startNativeKeyboardWatch,
} from "../src/lib/native/keyboard.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const LIB = "src/lib/native/keyboard.ts";
const COMPONENT = "src/components/native/NativeKeyboard.tsx";

/** Comments in these files name the things they must not do. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── Harness ───────────────────────────────────────────────────────────────

/** A deterministic `@capacitor/keyboard` double that records every listener. */
function makeKeyboard({ handleFails = false } = {}) {
  const listeners = new Map();
  const removed = [];
  const app = {
    listeners,
    removed,
    addListenerCalls: 0,
    async addListener(eventName, listener) {
      this.addListenerCalls += 1;
      if (handleFails) throw new Error("keyboard plugin unavailable");
      const set = listeners.get(eventName) ?? new Set();
      set.add(listener);
      listeners.set(eventName, set);
      return {
        remove: () => {
          removed.push(eventName);
          set.delete(listener);
        },
      };
    },
    /** Fire an event at whatever is registered for it. */
    fire(eventName, info) {
      for (const listener of listeners.get(eventName) ?? []) listener(info);
    },
    countFor(eventName) {
      return listeners.get(eventName)?.size ?? 0;
    },
  };
  return app;
}

async function watchHarness(options = {}) {
  const keyboard = makeKeyboard(options);
  const states = [];
  const errors = [];
  const stop = startNativeKeyboardWatch({
    keyboard,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });
  await flush();
  return { keyboard, states, errors, stop };
}

// ── Height normalisation ──────────────────────────────────────────────────

test("a plugin height is treated as untrusted input", () => {
  assert.equal(normalizeKeyboardHeight(312), 312);
  assert.equal(normalizeKeyboardHeight(312.6), 313);
  assert.equal(normalizeKeyboardHeight(0), 0);
  // Anything a native bridge could hand over that is not a usable length.
  assert.equal(normalizeKeyboardHeight(undefined), 0);
  assert.equal(normalizeKeyboardHeight(null), 0);
  assert.equal(normalizeKeyboardHeight("312"), 0);
  assert.equal(normalizeKeyboardHeight(Number.NaN), 0);
  assert.equal(normalizeKeyboardHeight(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeKeyboardHeight(-40), 0);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

test("show and hide publish the documented state", async () => {
  const { keyboard, states, stop } = await watchHarness();

  keyboard.fire("keyboardDidShow", { keyboardHeight: 300 });
  assert.deepEqual(states, [{ open: true, height: 300 }]);

  keyboard.fire("keyboardDidHide");
  assert.deepEqual(states, [
    { open: true, height: 300 },
    { open: false, height: 0 },
  ]);

  stop();
});

test("Android's Will/Did pair collapses into one transition", async () => {
  // Capacitor documents that keyboardWillShow and keyboardDidShow fire almost
  // together on Android. Two listeners, ONE transition — otherwise every fixed
  // element that reacts would animate twice.
  const { keyboard, states, stop } = await watchHarness();

  keyboard.fire("keyboardWillShow", { keyboardHeight: 300 });
  keyboard.fire("keyboardDidShow", { keyboardHeight: 300 });
  assert.equal(states.length, 1);

  keyboard.fire("keyboardWillHide");
  keyboard.fire("keyboardDidHide");
  assert.equal(states.length, 2);

  stop();
});

test("a height change while open is a real transition", async () => {
  // The suggestion strip appears/disappears without the IME closing.
  const { keyboard, states, stop } = await watchHarness();

  keyboard.fire("keyboardDidShow", { keyboardHeight: 300 });
  keyboard.fire("keyboardDidShow", { keyboardHeight: 360 });
  assert.deepEqual(states, [
    { open: true, height: 300 },
    { open: true, height: 360 },
  ]);

  stop();
});

test("a missing height is opened-not-measured, never NaN in CSS", async () => {
  const { keyboard, states, stop } = await watchHarness();

  keyboard.fire("keyboardDidShow");
  assert.deepEqual(states, [{ open: true, height: 0 }]);

  stop();
});

test("repeated show/hide cycles do not accumulate or stick", async () => {
  const { keyboard, states, stop } = await watchHarness();

  for (let i = 0; i < 5; i += 1) {
    keyboard.fire("keyboardDidShow", { keyboardHeight: 300 });
    keyboard.fire("keyboardDidHide");
  }

  // Five clean pairs, not ten duplicates.
  assert.equal(states.length, 10);
  assert.equal(states.at(-1).open, false);
  assert.deepEqual(states.at(-1), KEYBOARD_CLOSED);
  // A single listener set throughout: no duplicate registration.
  for (const eventName of KEYBOARD_EVENTS) {
    assert.equal(keyboard.countFor(eventName), 1, `${eventName} registered once`);
  }
  assert.equal(keyboard.addListenerCalls, 4, "exactly one listener per event");

  stop();
});

// ── Cleanup ───────────────────────────────────────────────────────────────

test("stop detaches every listener and silences later events", async () => {
  const { keyboard, states, stop } = await watchHarness();

  keyboard.fire("keyboardDidShow", { keyboardHeight: 250 });
  stop();

  assert.deepEqual(
    keyboard.removed.sort(),
    [...KEYBOARD_EVENTS].sort(),
    "all four handles are removed",
  );
  keyboard.fire("keyboardDidHide");
  keyboard.fire("keyboardDidShow", { keyboardHeight: 400 });
  assert.equal(states.length, 1, "no state after stop");

  // Idempotent.
  assert.doesNotThrow(() => stop());
  assert.equal(keyboard.removed.length, 4);
});

test("unmounting mid-registration leaves nothing attached", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const removed = [];
  const keyboard = {
    async addListener() {
      return gate;
    },
  };

  const states = [];
  const stop = startNativeKeyboardWatch({
    keyboard,
    onState: (state) => states.push(state),
  });

  stop();
  release({ remove: () => removed.push("keyboardDidShow") });
  await flush();

  assert.ok(removed.length >= 1, "a handle arriving after stop() is detached");
  assert.deepEqual(states, []);
});

test("a plugin that refuses every listener is reported, never thrown", async () => {
  const { errors, stop } = await watchHarness({ handleFails: true });

  assert.equal(errors.length, 4, "one report per refused listener");
  assert.match(String(errors[0]), /keyboard plugin unavailable/);
  assert.doesNotThrow(() => stop());
});

test("a throwing onState cannot break the remaining listeners", async () => {
  const keyboard = makeKeyboard();
  const states = [];
  const errors = [];
  const stop = startNativeKeyboardWatch({
    keyboard,
    onState: (state) => {
      states.push(state);
      throw new Error("consumer exploded");
    },
    onError: (error) => errors.push(error),
  });
  await flush();

  assert.doesNotThrow(() => keyboard.fire("keyboardDidShow", { keyboardHeight: 200 }));
  assert.equal(states.length, 1);
  assert.equal(errors.length, 1);

  // The other listeners still work.
  keyboard.fire("keyboardDidHide");
  assert.equal(states.length, 2);

  stop();
});

// ── Native-only, state-only ───────────────────────────────────────────────

test("the component is client-only, native-only and loads the plugin lazily", () => {
  const component = read(COMPONENT);

  assert.match(component, /^"use client";/m);
  assert.match(component, /typeof window === "undefined"/);
  assert.match(component, /Capacitor\.isNativePlatform\(\)/);
  assert.match(component, /import\("@capacitor\/keyboard"\)/);
  assert.match(component, /return null;/);
});

test("browsers see nothing: no plugin, no listeners, no DOM writes", () => {
  const code = stripComments(read(COMPONENT));

  assert.ok(!/addEventListener\s*\(/.test(code), "no browser listener");
  assert.ok(!/removeEventListener/.test(code));
  assert.ok(!/keydown|keyup|keypress/.test(code));
  assert.ok(!/visualViewport/.test(code));
  // The only DOM touch is the two document-level state signals, both behind the
  // native guard above.
  assert.match(code, /document\.documentElement/);
});

test("it publishes state and never moves, scrolls or focuses the page", () => {
  const code = stripComments(read(COMPONENT) + read(LIB));

  assert.ok(!/scrollIntoView/.test(code), "no scroll engine: the OS already resized");
  assert.ok(!/\.focus\s*\(/.test(code), "never opens or steals the keyboard");
  assert.ok(!/scrollTo|scrollBy|scrollTop/.test(code));
  assert.ok(!/style\.transform|translateY|marginBottom|paddingBottom/.test(code));
  // No layout consumer was invented: the variable is declared, not applied.
  assert.ok(!/var\(--keyboard-height/.test(code));
});

test("keyboard lifecycle cannot trigger a game action", () => {
  const code = stripComments(read(COMPONENT) + read(LIB));

  assert.ok(!/\.emit\s*\(/.test(code), "no socket event");
  assert.ok(!/fetch\s*\(/.test(code), "no request");
  // Gameplay identifiers, not the substring "turn" (which every `return`
  // contains). These are the actions a keyboard event must never be wired to.
  assert.ok(!/\bsocket\b|roomId|matchId|join_room/.test(code));
  assert.ok(!/\bturn\b|resign|forfeit|submitMove|submitTurn/i.test(code));
  assert.ok(!/isTyping|sendMessage|\bsubmit\b/i.test(code));
});

test("it is mounted exactly once, from the root layout", () => {
  const layout = read("src/app/layout.tsx");

  assert.equal((layout.match(/<NativeKeyboard\s*\/>/g) ?? []).length, 1);
  assert.match(layout, /import NativeKeyboard from "\.\.\/components\/native\/NativeKeyboard"/);
  // After the other native mounts, whose order the earlier phases pin.
  assert.match(layout, /<NativeSystemBars \/>[\s\S]{0,160}<NativeKeyboard \/>/);
});

test("the two document signals are the documented ones", () => {
  const component = read(COMPONENT);
  const css = read("src/app/globals.css");

  assert.match(component, /root\.dataset\.keyboard = "open"/);
  assert.match(component, /delete root\.dataset\.keyboard/);
  assert.match(component, /--keyboard-height/);
  assert.match(css, /--keyboard-height:\s*0px/);
});

// ── Native configuration ──────────────────────────────────────────────────

test("Android resizes the WebView rather than panning it", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");

  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  // Identity untouched.
  assert.match(manifest, /android:name="\.MainActivity"/);
  assert.match(manifest, /android:theme="@style\/AppTheme\.NoActionBarLaunch"/);
});

test("the documented Android resize workaround is enabled, and nothing else", () => {
  const config = read("capacitor.config.ts");

  assert.match(config, /Keyboard:\s*\{/);
  assert.match(config, /resizeOnFullScreen:\s*true/);
  // The `resize` mode is iOS-only, so Android has nothing else to set here.
  assert.ok(!/\bresize:\s*['"]/.test(config));
  // Hosting and identity unchanged.
  assert.match(config, /appId:\s*'com\.grynd\.app'/);
  assert.match(config, /url:\s*'https:\/\/www\.grynd\.dedyn\.io\/'/);
});

// ── Games that type ───────────────────────────────────────────────────────

test("Speed Typing's own keyboard handling is untouched", () => {
  const page = read("src/app/casino/speed-typing/[matchId]/PageClient.tsx");

  // Its textarea, its Enter guard, its caret scroll and its focus-to-type
  // effect all remain exactly as they were.
  assert.match(page, /<textarea/);
  assert.match(page, /enterKeyHint="done"/);
  assert.match(page, /if \(event\.key === "Enter"\) event\.preventDefault\(\);/);
  assert.match(page, /caretRef\.current\?\.scrollIntoView\(\{ block: "nearest" \}\);/);
  assert.match(page, /inputRef\.current\?\.focus\(\)/);

  // And the keyboard phase never reaches into it.
  const code = stripComments(read(COMPONENT) + read(LIB));
  assert.ok(!/speed-typing|PageClient/.test(code));
});

test("no global focus handler was added anywhere in the native layer", () => {
  const files = [
    COMPONENT,
    LIB,
    "src/components/native/NativeBackButton.tsx",
    "src/components/native/NativeSystemBars.tsx",
    "src/lib/native/backButton.ts",
  ];

  for (const file of files) {
    const code = stripComments(read(file));
    assert.ok(!/focusin|focusout/.test(code), `${file} adds no focus handler`);
    assert.ok(!/autofocus|autoFocus/.test(code), `${file} never auto-focuses`);
  }
});
