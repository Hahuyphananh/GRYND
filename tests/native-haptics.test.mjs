/**
 * native-haptics.test.mjs
 *
 * Haptics are a confirmation channel, never a gameplay channel. This exercises
 * the REAL module (it has no top-level Capacitor import, so Node can load it)
 * and pins the rules call sites rely on:
 *
 *   * the three categories map onto the three plugin calls we actually use;
 *   * a failing plugin is contained (never rejects, returns false);
 *   * server rendering and web sessions never touch the plugin;
 *   * no gameplay surface asks for feedback.
 *
 * Run:  node --import tsx --test tests/native-haptics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyHaptic,
  hapticFeedback,
  safeHaptic,
  triggerHaptic,
} from "../src/lib/native/haptics.ts";

const makeSdk = () => {
  const calls = [];
  return {
    calls,
    sdk: {
      Haptics: {
        selectionChanged: async () => calls.push("selection"),
        notification: async ({ type }) => calls.push(`notification:${type}`),
      },
      NotificationType: { Success: "SUCCESS", Warning: "WARNING" },
    },
  };
};

test("each category maps to its documented plugin call", async () => {
  const { calls, sdk } = makeSdk();
  await applyHaptic("selection", sdk);
  await applyHaptic("success", sdk);
  await applyHaptic("warning", sdk);
  assert.deepEqual(calls, [
    "selection",
    "notification:SUCCESS",
    "notification:WARNING",
  ]);
});

test("an unknown category does nothing and never touches the plugin", async () => {
  const { calls, sdk } = makeSdk();
  await applyHaptic("explosion", sdk);
  assert.deepEqual(calls, []);
});

test("a failing plugin is contained: false, never a rejection", async () => {
  const broken = {
    Haptics: {
      selectionChanged: async () => {
        throw new Error("no vibrator");
      },
      notification: async () => {
        throw new Error("no vibrator");
      },
    },
    NotificationType: { Success: "SUCCESS", Warning: "WARNING" },
  };
  assert.equal(await safeHaptic("selection", broken), false);
  assert.equal(await safeHaptic("success", broken), false);
});

test("a successful plugin reports true", async () => {
  const { sdk } = makeSdk();
  assert.equal(await safeHaptic("selection", sdk), true);
});

test("outside the native app (and in SSR) no feedback is attempted", async () => {
  // The module is imported in Node, so `typeof window === "undefined"` holds.
  assert.equal(await hapticFeedback("success"), false);
  // The fire-and-forget form must not throw either.
  assert.doesNotThrow(() => triggerHaptic("selection"));
});

test("gameplay never fires haptics", () => {
  const files = [
    "src/components/solitaire-duel/SolitaireBoard.tsx",
    "src/components/solitaire/SolitaireBoard.tsx",
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
  ].filter((path) => fs.existsSync(path));
  assert.ok(files.length > 0, "expected at least one solitaire surface");
  for (const path of files) {
    const src = fs.readFileSync(path, "utf8");
    assert.doesNotMatch(src, /triggerHaptic|hapticFeedback/, `${path} must not use haptics`);
  }
});
