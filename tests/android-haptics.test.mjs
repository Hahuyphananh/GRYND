/**
 * tests/android-haptics.test.mjs
 *
 * Phase 6 — native haptic feedback.
 *
 * `applyHaptic` and `safeHaptic` take the plugin object as an argument, so the
 * category → method/style mapping and the failure containment are provable
 * without a device, a DOM or a Capacitor runtime. The rest is structural: no
 * top-level Capacitor import (SSR), a `window` guard before any plugin work, a
 * lazy `isNativePlatform()` gate (a browser never downloads the plugin), and
 * exactly two shared integration points.
 *
 * Equally important is what must NOT exist: no timers, no frames, no socket or
 * lifecycle coupling, and no haptics anywhere in the native bridge modules or
 * the games — haptics are a confirmation channel, never a gameplay one.
 *
 * What this file cannot prove: that a phone actually buzzes, or how strong each
 * pattern feels. That needs a real Android device; see the report.
 *
 * Run:  node --import tsx --test tests/android-haptics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  applyHaptic,
  hapticFeedback,
  safeHaptic,
  triggerHaptic,
} from "../src/lib/native/haptics.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const HELPER = "src/lib/native/haptics.ts";
const TOASTS = "src/components/toast/ToastProvider.jsx";
const NAV = "src/components/navigation-bar.jsx";

/** Comments in these files explain the rules, so scans run against code. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A deterministic `@capacitor/haptics` double that records every call. */
function makeSdk({ throws = null } = {}) {
  const calls = { selectionChanged: 0, notification: [] };
  const sdk = {
    Haptics: {
      async selectionChanged() {
        if (throws) throw new Error(throws);
        calls.selectionChanged += 1;
      },
      async notification(options) {
        if (throws) throw new Error(throws);
        calls.notification.push(options);
      },
    },
    NotificationType: { Success: "SUCCESS", Warning: "WARNING" },
  };
  return { sdk, calls };
}

// ── Category → plugin method ──────────────────────────────────────────────

test("selection uses the plugin's selection hint", async () => {
  const { sdk, calls } = makeSdk();
  await applyHaptic("selection", sdk);

  assert.equal(calls.selectionChanged, 1);
  assert.deepEqual(calls.notification, [], "a selection is not a notification");
});

test("success uses the success notification pattern", async () => {
  const { sdk, calls } = makeSdk();
  await applyHaptic("success", sdk);

  assert.deepEqual(calls.notification, [{ type: "SUCCESS" }]);
  assert.equal(calls.selectionChanged, 0);
});

test("warning uses the warning notification pattern", async () => {
  const { sdk, calls } = makeSdk();
  await applyHaptic("warning", sdk);

  assert.deepEqual(calls.notification, [{ type: "WARNING" }]);
  assert.equal(calls.selectionChanged, 0);
});

test("an unknown category does nothing at all", async () => {
  const { sdk, calls } = makeSdk();
  await applyHaptic("celebration", sdk);

  assert.equal(calls.selectionChanged, 0);
  assert.deepEqual(calls.notification, []);
});

test("only the three mapped plugin methods are used — no raw vibrate", () => {
  const code = stripComments(read(HELPER));

  assert.ok(!/\.vibrate\s*\(/.test(code), "a raw buzz has no semantic meaning");
  assert.ok(!/\.impact\s*\(/.test(code), "impact is not one of the three categories");
  assert.ok(!/selectionStart|selectionEnd/.test(code));
  assert.match(code, /selectionChanged\(\)/);
  assert.match(code, /notification\(\{\s*type:\s*sdk\.NotificationType\.Success\s*\}\)/);
  assert.match(code, /notification\(\{\s*type:\s*sdk\.NotificationType\.Warning\s*\}\)/);
});

// ── Failure containment ───────────────────────────────────────────────────

test("a rejected plugin call is contained and reported as false", async () => {
  const { sdk } = makeSdk({ throws: "no vibrator" });

  assert.equal(await safeHaptic("success", sdk), false);
  assert.equal(await safeHaptic("selection", sdk), false);
  // The important half: it RESOLVES, so a click handler awaiting it continues.
  await assert.doesNotReject(() => safeHaptic("warning", sdk));
});

test("a synchronous throw is contained too", async () => {
  const sdk = {
    Haptics: {
      selectionChanged() {
        throw new Error("bridge missing");
      },
      async notification() {},
    },
    NotificationType: { Success: "SUCCESS", Warning: "WARNING" },
  };

  assert.equal(await safeHaptic("selection", sdk), false);
});

test("a successful call reports true", async () => {
  const { sdk } = makeSdk();
  assert.equal(await safeHaptic("success", sdk), true);
});

test("the fire-and-forget wrapper never returns a promise to the caller", () => {
  // `void`-ing it means an event handler cannot accidentally await a vibration.
  const code = stripComments(read(HELPER));
  assert.match(code, /export function triggerHaptic[\s\S]{0,120}void hapticFeedback\(kind\);/);

  // Calling it must not throw, and must not reject unhandled.
  assert.doesNotThrow(() => triggerHaptic("selection"));
});

// ── SSR and browser safety ────────────────────────────────────────────────

test("the helper has no top-level Capacitor import (server rendering)", () => {
  const code = stripComments(read(HELPER));
  const beforeFirstExport = code.split(/export /)[0];

  assert.ok(!/^\s*import\s/m.test(beforeFirstExport), "no imports at module scope");
  assert.match(code, /await import\("@capacitor\/core"\)/);
  assert.match(code, /await import\("@capacitor\/haptics"\)/);
});

test("the window guard runs before any plugin work", () => {
  const code = stripComments(read(HELPER));
  const guard = code.indexOf('typeof window === "undefined"');
  const firstImport = code.indexOf('import("@capacitor/core")');

  assert.ok(guard > -1 && firstImport > -1);
  assert.ok(guard < firstImport, "SSR must return before Capacitor is touched");
});

test("resolves false on the server and in a browser, without throwing", async () => {
  // Node: no window at all.
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(await hapticFeedback("success"), false);

  // A window without a native platform: Capacitor reports "web", so the
  // Haptics plugin is never loaded and nothing is invoked.
  globalThis.window = {};
  try {
    assert.equal(await hapticFeedback("selection"), false);
  } finally {
    delete globalThis.window;
  }
});

// ── Integration points ────────────────────────────────────────────────────

test("a toast confirmation is the only generic feedback surface", () => {
  const code = stripComments(read(TOASTS));

  assert.match(code, /import \{ triggerHaptic \} from "\.\.\/\.\.\/lib\/native\/haptics";/);
  assert.match(code, /if \(type === "success"\) triggerHaptic\("success"\);/);
  assert.match(code, /else if \(type === "error"\) triggerHaptic\("warning"\);/);
  // `info` is a hint, not a confirmation.
  assert.ok(!/triggerHaptic\("(info|failure|error)"\)/.test(code));
  // Exactly one call per branch, inside showToast.
  assert.equal((code.match(/triggerHaptic\(/g) ?? []).length, 2);
});

test("the mobile menu toggle is the only selection feedback", () => {
  const code = stripComments(read(NAV));

  assert.match(code, /import \{ triggerHaptic \} from "\.\.\/lib\/native\/haptics";/);
  // Both the signed-in and signed-out bars use the same toggle.
  assert.equal((code.match(/triggerHaptic\("selection"\)/g) ?? []).length, 2);
  assert.equal((code.match(/triggerHaptic\(/g) ?? []).length, 2);
});

test("no native bridge module fires haptics", () => {
  const files = [
    "src/lib/native/appLifecycle.ts",
    "src/lib/native/socketRecovery.ts",
    "src/lib/native/backButton.ts",
    "src/lib/native/keyboard.ts",
    "src/components/native/NativeLifecycleBridge.tsx",
    "src/components/native/NativeBackButton.tsx",
    "src/components/native/NativeSystemBars.tsx",
    "src/components/native/NativeKeyboard.tsx",
    "src/context/SocketProvider.tsx",
  ];

  for (const file of files) {
    const code = stripComments(read(file));
    assert.ok(!/haptic/i.test(code), `${file} must stay haptic-free`);
    assert.ok(!/triggerHaptic|safeHaptic|applyHaptic/.test(code), file);
  }
});

test("no game page fires haptics (no gameplay or timing feedback)", () => {
  const pages = [
    "src/app/casino/speed-typing/[matchId]/PageClient.tsx",
    "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
    "src/app/casino/odds/game/[matchId]/PageClient.tsx",
    "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
    "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  ];

  for (const page of pages) {
    const code = stripComments(read(page));
    assert.ok(!/triggerHaptic|hapticFeedback|@capacitor\/haptics/.test(code), page);
  }
});

test("nothing in the haptic layer loops or binds to time", () => {
  const code = stripComments(read(HELPER));

  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(code));
  assert.ok(!/addEventListener|removeEventListener/.test(code), "no global listener");
  assert.ok(!/socket|fetch\s*\(|matchId|roomId/.test(code), "no network or game coupling");
  // No module-level cache or "last fired" state: the only state is per-call.
  assert.ok(!/^let |^const .*=\s*\{/m.test(code.replace(/^const [A-Z_]+ =/gm, "")), "no persistent state");
});

test("a haptic is never awaited by the interaction it accompanies", () => {
  // Both integrations are inside synchronous handlers (a toggle click, a toast
  // call), which is only safe because the helper cannot reject.
  const toast = stripComments(read(TOASTS));
  const nav = stripComments(read(NAV));

  assert.ok(!/await triggerHaptic/.test(toast));
  assert.ok(!/await triggerHaptic/.test(nav));
  assert.match(stripComments(read(HELPER)), /export async function hapticFeedback/);
});
