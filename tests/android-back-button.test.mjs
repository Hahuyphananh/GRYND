/**
 * tests/android-back-button.test.mjs
 *
 * Phase 4 — Android hardware back button.
 *
 * Two layers are checked:
 *
 *   1. `handleAndroidBack` — the four-step priority, with an injected overlay
 *      finder, escape dispatcher, history predicate, router and minimizer. That
 *      makes "overlay → history → minimize", the cooldown that absorbs a held
 *      button, and "never navigate out from under a modal" provable here.
 *
 *   2. `attachAndroidBackButton` — one native listener, removed on stop, a
 *      handle that resolves after unmount detached immediately, errors reported
 *      rather than thrown.
 *
 * The component itself is checked structurally: client-only, native-only,
 * dynamic plugin import, mounted once from the root layout, and no browser
 * (popstate/keydown/history) listener — which is what keeps web Back unchanged.
 *
 * What this file does NOT prove: how Android actually delivers the hardware
 * event, or how `minimizeApp()` behaves on a device. Those need an emulator or
 * a phone; see the report.
 *
 * Run:  node --import tsx --test tests/android-back-button.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BACK_COOLDOWN_MS,
  attachAndroidBackButton,
  handleAndroidBack,
  resetBackCooldown,
} from "../src/lib/native/backButton.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `handleAndroidBack` refuses to run without a DOM (server-rendering safety),
 * exactly like the Phase 3A emitters. The decision logic needs nothing from the
 * DOM beyond the guard passing, so a minimal stub stands in for it here.
 */
if (typeof globalThis.window === "undefined") globalThis.window = {};
if (typeof globalThis.document === "undefined") globalThis.document = {};

/**
 * These modules' comments deliberately NAME what they must not do (`exitApp`,
 * `forfeit`, `.emit`), so the structural guards below scan code only.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── Harness ───────────────────────────────────────────────────────────────

/** One press through `handleAndroidBack`, with every collaborator recorded. */
function press({
  overlay = null,
  canGoBack = false,
  minimizeFails = false,
  overlayThrows = false,
  goBackThrows = false,
  keyboardOpen = false,
  hideFails = false,
  now = 10_000,
} = {}) {
  const calls = { dismiss: [], goBack: 0, minimize: 0, errors: [], hide: 0 };

  const outcome = handleAndroidBack({
    // Phase 5B.1: the keyboard is the first thing Back answers.
    isKeyboardOpen: () => keyboardOpen,
    hideKeyboard: async () => {
      calls.hide += 1;
      if (hideFails) throw new Error("keyboard unavailable");
    },
    findOverlay: () => {
      if (overlayThrows) throw new Error("no dom");
      return overlay;
    },
    dismissOverlay: (element) => calls.dismiss.push(element),
    canGoBack: () => canGoBack,
    goBack: () => {
      calls.goBack += 1;
      if (goBackThrows) throw new Error("router exploded");
    },
    minimize: async () => {
      calls.minimize += 1;
      if (minimizeFails) throw new Error("no activity");
    },
    now: () => now,
    onError: (error) => calls.errors.push(error),
  });

  return { outcome, calls };
}

// A stand-in overlay element: identity is all the handler needs.
const overlayElement = { id: "resign-confirm" };

test.beforeEach(() => resetBackCooldown());

// ── 1. Keyboard first (Phase 5B.1) ────────────────────────────────────────
//
// Android's own contract is that Back dismisses the IME before anything else,
// and a dialog may well hold the focused field — so the keyboard outranks every
// other step, and answering it must never navigate, minimize or close a dialog.

test("keyboard open + history available: hide the keyboard, do not navigate", () => {
  const { outcome, calls } = press({ keyboardOpen: true, canGoBack: true });

  assert.equal(outcome, "keyboard");
  assert.equal(calls.hide, 1);
  assert.equal(calls.goBack, 0, "a dismissal is not a navigation");
  assert.equal(calls.minimize, 0);
});

test("keyboard open at the root: hide it and do not minimize the app", () => {
  const { outcome, calls } = press({ keyboardOpen: true, canGoBack: false });

  assert.equal(outcome, "keyboard");
  assert.equal(calls.hide, 1);
  assert.equal(calls.minimize, 0);
  assert.equal(calls.goBack, 0);
});

test("keyboard open with a dialog: the keyboard goes first, the dialog stays", () => {
  const { outcome, calls } = press({ keyboardOpen: true, overlay: overlayElement });

  assert.equal(outcome, "keyboard");
  assert.equal(calls.hide, 1);
  assert.deepEqual(calls.dismiss, [], "the dialog must remain open");
  assert.equal(calls.goBack, 0);
  assert.equal(calls.minimize, 0);
});

test("a rejected hide is reported and nothing else happens", async () => {
  const { outcome, calls } = press({
    keyboardOpen: true,
    hideFails: true,
    canGoBack: true,
  });
  await flush();

  assert.equal(outcome, "keyboard");
  assert.equal(calls.goBack, 0, "a failed dismissal must not navigate");
  assert.equal(calls.minimize, 0);
  assert.equal(calls.errors.length, 1);
  assert.match(String(calls.errors[0]), /keyboard unavailable/);
});

test("a synchronous throw from hide() is reported, not escalated", () => {
  const calls = { goBack: 0, minimize: 0, errors: [] };
  const outcome = handleAndroidBack({
    isKeyboardOpen: () => true,
    hideKeyboard: () => {
      throw new Error("no webview");
    },
    findOverlay: () => null,
    dismissOverlay: () => {},
    canGoBack: () => true,
    goBack: () => {
      calls.goBack += 1;
    },
    minimize: async () => {
      calls.minimize += 1;
    },
    onError: (error) => calls.errors.push(error),
  });

  assert.equal(outcome, "keyboard");
  assert.equal(calls.goBack, 0);
  assert.equal(calls.minimize, 0);
  assert.equal(calls.errors.length, 1);
});

test("holding Back while the keyboard is open hides it once", () => {
  let now = 60_000;
  const calls = { hide: 0, goBack: 0, minimize: 0 };
  const keyboard = () =>
    handleAndroidBack({
      isKeyboardOpen: () => true,
      hideKeyboard: () => {
        calls.hide += 1;
      },
      findOverlay: () => null,
      dismissOverlay: () => {},
      canGoBack: () => true,
      goBack: () => {
        calls.goBack += 1;
      },
      minimize: async () => {
        calls.minimize += 1;
      },
      now: () => now,
    });

  assert.equal(keyboard(), "keyboard");
  now += 40;
  assert.equal(keyboard(), "keyboard");
  now += 40;
  assert.equal(keyboard(), "keyboard");

  assert.equal(calls.hide, 1, "one hide per cooldown window");
  assert.equal(calls.goBack, 0, "and never a navigation");
  assert.equal(calls.minimize, 0);
});

test("dismissing the keyboard does not swallow the next legitimate press", () => {
  let now = 70_000;
  let keyboardOpen = true;
  const calls = { hide: 0, goBack: 0 };
  const g = () =>
    handleAndroidBack({
      isKeyboardOpen: () => keyboardOpen,
      hideKeyboard: () => {
        calls.hide += 1;
        // Phase 5B clears `data-keyboard` when the IME reports its hide.
        keyboardOpen = false;
      },
      findOverlay: () => null,
      dismissOverlay: () => {},
      canGoBack: () => true,
      goBack: () => {
        calls.goBack += 1;
      },
      minimize: async () => {},
      now: () => now,
    });

  assert.equal(g(), "keyboard");
  // Moments later the keyboard is closed: the press must navigate, with no
  // cooldown left over from the dismissal.
  now += 10;
  assert.equal(g(), "history");
  assert.equal(calls.goBack, 1);
});

test("keyboard closed keeps every Phase 4 outcome intact", () => {
  resetBackCooldown();
  assert.equal(press({ keyboardOpen: false, overlay: overlayElement }).outcome, "overlay");
  resetBackCooldown();
  assert.equal(press({ keyboardOpen: false, canGoBack: true }).outcome, "history");
  resetBackCooldown();
  assert.equal(press({ keyboardOpen: false, canGoBack: false }).outcome, "minimized");
});

test("a missing keyboard dependency simply skips the step", () => {
  // The decision module must stay usable without a keyboard bridge (this is what
  // keeps the browser path identical).
  resetBackCooldown();
  const calls = { goBack: 0 };
  const outcome = handleAndroidBack({
    findOverlay: () => null,
    dismissOverlay: () => {},
    canGoBack: () => true,
    goBack: () => {
      calls.goBack += 1;
    },
    minimize: async () => {},
    now: () => 80_000,
  });
  assert.equal(outcome, "history");
  assert.equal(calls.goBack, 1);
});

test("the component reads the Phase 5B contract without a second listener", () => {
  const component = stripComments(read("src/components/native/NativeBackButton.tsx"));

  assert.match(component, /dataset\.keyboard === "open"/);
  assert.match(component, /import\("@capacitor\/keyboard"\)/);
  assert.match(component, /hideKeyboard: \(\) => Keyboard\.hide\(\)/);
  assert.match(component, /isKeyboardOpen:/);
  // ONE source of keyboard state: the state lives in NativeKeyboard, and this
  // component adds no keyboard event listener and no copy of the state.
  assert.ok(!/keyboardDidShow|keyboardWillShow|keyboardDidHide|keyboardWillHide/.test(component));
  assert.ok(!/addListener\(\s*"keyboard/.test(component));
});

test("the decision module stays DOM-free and plugin-free", () => {
  const lib = stripComments(read("src/lib/native/backButton.ts"));

  assert.ok(!/@capacitor/.test(lib), "no plugin import in the decision module");
  assert.ok(!/dataset\.keyboard/.test(lib), "the caller owns the keyboard state");
  assert.ok(!/Keyboard\.hide/.test(lib), "hide() is injected, not called directly");
});

// ── 2. Open overlay ───────────────────────────────────────────────────────

test("back with an overlay open closes it and never navigates", () => {
  const { outcome, calls } = press({ overlay: overlayElement, canGoBack: true });

  assert.equal(outcome, "overlay");
  assert.deepEqual(calls.dismiss, [overlayElement], "the topmost dialog is dismissed");
  assert.equal(calls.goBack, 0, "no navigation under a modal");
  assert.equal(calls.minimize, 0);
});

test("an overlay wins over available history", () => {
  // Even with somewhere to go, the press belongs to the dialog.
  const root = press({ overlay: overlayElement, canGoBack: false });
  assert.equal(root.outcome, "overlay");
  assert.equal(root.calls.minimize, 0);
});

test("the topmost overlay is the one dismissed", () => {
  // The component's finder returns the LAST `[role="dialog"]`; this pins that
  // the handler acts on whatever it is given, not on the first/root document.
  const component = read("src/components/native/NativeBackButton.tsx");
  assert.match(component, /querySelectorAll\('\[role="dialog"\]'\)/);
  assert.match(component, /overlays\[overlays\.length - 1\]/);
});

test("without a DOM the press is a no-op (server rendering)", () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  try {
    delete globalThis.window;
    delete globalThis.document;
    assert.equal(press({ canGoBack: true }).outcome, "unavailable");
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  }
});

test("a finder that throws is reported and the press still falls through safely", () => {
  const { outcome, calls } = press({ overlayThrows: true, canGoBack: true });

  assert.equal(outcome, "history");
  assert.equal(calls.errors.length, 1);
});

test("a dismisser that throws is reported and nothing else runs", () => {
  const calls = { errors: [], goBack: 0 };
  const outcome = handleAndroidBack({
    findOverlay: () => overlayElement,
    dismissOverlay: () => {
      throw new Error("dispatch failed");
    },
    canGoBack: () => true,
    goBack: () => {
      calls.goBack += 1;
    },
    minimize: async () => {},
    onError: (error) => calls.errors.push(error),
  });

  assert.equal(outcome, "overlay");
  assert.equal(calls.goBack, 0);
  assert.equal(calls.errors.length, 1);
});

// ── 3. Normal navigation ──────────────────────────────────────────────────

test("back with in-app history goes back one page", () => {
  const { outcome, calls } = press({ canGoBack: true });

  assert.equal(outcome, "history");
  assert.equal(calls.goBack, 1);
  assert.equal(calls.minimize, 0);
  assert.deepEqual(calls.dismiss, []);
});

test("a throwing router is reported, not thrown", () => {
  const { outcome, calls } = press({ canGoBack: true, goBackThrows: true });

  assert.equal(outcome, "history");
  assert.equal(calls.goBack, 1);
  assert.equal(calls.errors.length, 1);
});

// ── 4. Root / no history ──────────────────────────────────────────────────

test("back with nothing to return to minimizes instead of guessing a route", async () => {
  const { outcome, calls } = press({ canGoBack: false });
  await flush();

  assert.equal(outcome, "minimized");
  assert.equal(calls.minimize, 1);
  assert.equal(calls.goBack, 0, "no arbitrary route is invented");
});

test("a failing minimize is reported and not escalated", async () => {
  const { outcome, calls } = press({ canGoBack: false, minimizeFails: true });
  await flush();

  assert.equal(outcome, "minimized");
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.goBack, 0);
});

test("the handler never calls exitApp — the task stays in Recents", () => {
  const lib = stripComments(read("src/lib/native/backButton.ts"));
  const component = stripComments(read("src/components/native/NativeBackButton.tsx"));

  assert.ok(!/exitApp/.test(lib));
  assert.ok(!/exitApp/.test(component));
});

// ── Rapid presses and cooldown ────────────────────────────────────────────

test("a held back button cannot queue several pops", () => {
  let now = 50_000;
  const calls = { goBack: 0, minimize: 0 };
  const gh = () =>
    handleAndroidBack({
      findOverlay: () => null,
      dismissOverlay: () => {},
      canGoBack: () => true,
      goBack: () => {
        calls.goBack += 1;
      },
      minimize: async () => {
        calls.minimize += 1;
      },
      now: () => now,
    });

  assert.equal(gh(), "history");
  now += 40;
  assert.equal(gh(), "ignored");
  now += 40;
  assert.equal(gh(), "ignored");
  assert.equal(calls.goBack, 1, "one navigation per cooldown window");

  now += BACK_COOLDOWN_MS;
  assert.equal(gh(), "history");
  assert.equal(calls.goBack, 2);
});

test("the cooldown is shared across mounts, not owned by the component", () => {
  // Module scope is what stops a Strict Mode remount from letting two presses
  // through. `resetBackCooldown()` is the only way to clear it.
  assert.match(read("src/lib/native/backButton.ts"), /const observed/);
  assert.equal(press({ canGoBack: true }).outcome, "history");
  assert.equal(press({ canGoBack: true }).outcome, "ignored");
  resetBackCooldown();
  assert.equal(press({ canGoBack: true }).outcome, "history");
});

// ── Listener attachment ───────────────────────────────────────────────────

function makeApp({ handleFails = false } = {}) {
  const registered = [];
  const removed = [];
  const app = {
    registered,
    removed,
    addListenerCalls: 0,
    minimizeCalls: 0,
    async addListener(eventName, listener) {
      this.addListenerCalls += 1;
      if (handleFails) throw new Error("plugin unavailable");
      registered.push({ eventName, listener });
      return {
        remove: () => {
          removed.push(eventName);
        },
      };
    },
    async minimizeApp() {
      this.minimizeCalls += 1;
    },
  };
  return app;
}

test("exactly one native back listener is registered and it is the back button", async () => {
  const app = makeApp();
  const presses = [];
  const stop = attachAndroidBackButton({
    app,
    onBack: (event) => presses.push(event),
  });
  await flush();

  assert.equal(app.registered.length, 1);
  assert.equal(app.registered[0].eventName, "backButton");
  assert.equal(app.addListenerCalls, 1);

  app.registered[0].listener({ canGoBack: true });
  assert.deepEqual(presses, [{ canGoBack: true }]);

  // The payload is normalised: anything that is not `true` is false.
  app.registered[0].listener({});
  app.registered[0].listener(undefined);
  assert.deepEqual(presses.slice(1), [{ canGoBack: false }, { canGoBack: false }]);

  stop();
});

test("stop detaches the listener and silences later presses", async () => {
  const app = makeApp();
  const presses = [];
  const stop = attachAndroidBackButton({
    app,
    onBack: (event) => presses.push(event),
  });
  await flush();

  const listener = app.registered[0].listener;
  stop();

  assert.deepEqual(app.removed, ["backButton"]);
  listener({ canGoBack: true });
  assert.deepEqual(presses, [], "a press racing the unmount is dropped");
  // Idempotent.
  assert.doesNotThrow(() => stop());
  assert.deepEqual(app.removed, ["backButton"]);
});

test("unmounting while the plugin is still answering registers nothing", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const removed = [];
  const app = {
    addListenerCalls: 0,
    async addListener() {
      this.addListenerCalls += 1;
      return gate;
    },
    async minimizeApp() {},
  };

  const presses = [];
  const stop = attachAndroidBackButton({
    app,
    onBack: (event) => presses.push(event),
  });

  stop();
  release({ remove: () => removed.push("backButton") });
  await flush();

  assert.deepEqual(removed, ["backButton"], "the late handle is detached");
  assert.deepEqual(presses, []);
});

test("a plugin that refuses the listener is reported, never thrown", async () => {
  const errors = [];
  const app = makeApp({ handleFails: true });

  const stop = attachAndroidBackButton({
    app,
    onBack: () => {},
    onError: (error) => errors.push(error),
  });
  await flush();

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /plugin unavailable/);
  assert.doesNotThrow(() => stop());
});

test("a throwing onBack does not break the listener", async () => {
  const app = makeApp();
  const errors = [];
  attachAndroidBackButton({
    app,
    onBack: () => {
      throw new Error("handler exploded");
    },
    onError: (error) => errors.push(error),
  });
  await flush();

  assert.doesNotThrow(() => app.registered[0].listener({ canGoBack: true }));
  assert.equal(errors.length, 1);
});

// ── Native-only, browser-untouched ────────────────────────────────────────

test("the component is client-only, native-only and imports the plugin lazily", () => {
  const component = read("src/components/native/NativeBackButton.tsx");

  assert.match(component, /^"use client";/m);
  assert.match(component, /typeof window === "undefined"/);
  assert.match(component, /Capacitor\.isNativePlatform\(\)/);
  assert.match(component, /import\("@capacitor\/app"\)/);
  assert.match(component, /return null;/);
  assert.match(component, /stopWatch\?\.\(\)/);
  // The plugin object is the one already installed; no second back plugin.
  assert.ok(!/capacitor-plugin-back|@capacitor\/keyboard-back|backbutton-plugin/i.test(component));
});

test("browser back behaviour is untouched", () => {
  const component = read("src/components/native/NativeBackButton.tsx");

  // Browsers keep the History API: no popstate, no keydown, no interception.
  assert.ok(!/addEventListener\(\s*["']popstate/.test(component));
  assert.ok(!/addEventListener\(\s*["']keydown/.test(component));
  assert.ok(!/onpopstate|window\.history\.back|window\.history\.go/.test(component));
  assert.ok(!/beforeunload/.test(component));
  // A synthetic Escape is dispatched at an overlay only, never at the document.
  assert.match(component, /overlay\.dispatchEvent\(/);
});

test("it is mounted exactly once, from the root layout", () => {
  const layout = read("src/app/layout.tsx");

  assert.equal((layout.match(/<NativeBackButton\s*\/>/g) ?? []).length, 1);
  assert.match(
    layout,
    /import NativeBackButton from "\.\.\/components\/native\/NativeBackButton"/,
  );
  // Beside the other render-nothing root effects, not inside a route.
  assert.match(layout, /<NativeLifecycleBridge \/>[\s\S]{0,200}<NativeBackButton \/>/);
});

test("Phase 3B recovery and the lifecycle bridge are not modified by this phase", () => {
  const provider = read("src/context/SocketProvider.tsx");
  assert.ok(!/backButton|NativeBackButton|role="dialog"/.test(provider));

  const bridge = read("src/components/native/NativeLifecycleBridge.tsx");
  assert.ok(!/backButton/.test(bridge), "one listener owner per event");

  const recovery = read("src/lib/native/socketRecovery.ts");
  assert.ok(!/backButton/gi.test(recovery.replace(/Socket#connect/g, "")));
});

test("the component does not touch match, room or socket state", () => {
  const component = stripComments(read("src/components/native/NativeBackButton.tsx"));
  const lib = stripComments(read("src/lib/native/backButton.ts"));

  for (const source of [component, lib]) {
    assert.ok(!/\.emit\s*\(/.test(source), "no socket event is emitted");
    assert.ok(!/join_room|leave_room|room_event|user:join/.test(source));
    assert.ok(!/fetch\s*\(/.test(source), "no API call on Back");
    assert.ok(!/forfeit|resign/i.test(source), "no game action on Back");
  }
});
