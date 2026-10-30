/**
 * tests/android-webview-recovery.test.mjs
 *
 * Phase 8 — remote WebView loading, the offline state, and the failure/retry path.
 *
 * Two things are pinned here:
 *
 *  1. `resolveOnline` — the single merge of `navigator.onLine` and the native
 *     `@capacitor/network` signal. One decision means one <OfflineBanner>, so a
 *     native app cannot end up with two competing "you're offline" indicators.
 *
 *  2. The recovery page Capacitor loads when the REMOTE app fails
 *     (`server.errorPath` → android/app/src/main/assets/public/error.html). Its
 *     promises are the guarantees Phase 8 must not break: a user-triggered retry
 *     that navigates once to the canonical URL, no automatic reload loop, and no
 *     touching of session, storage, caches, or a live match.
 *
 * What this cannot prove: how the page looks on a phone, or that a real
 * airplane-mode launch lands on it. Both need a device or emulator.
 *
 *   npm run test:webview-recovery
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveOnline } from "../src/lib/native/connectivity";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const RECOVERY_HTML = "android/app/src/main/assets/public/error.html";
const MARK_PNG = "android/app/src/main/assets/public/grynd-mark.png";
const CANONICAL = "https://www.grynd.dedyn.io/";

/** Strip HTML + JS comments: the files explain what must NOT happen in them. */
const stripComments = (source) =>
  source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// ── 1. One connectivity decision ──────────────────────────────────────────

test("an unknown signal never reports the app as offline", () => {
  // First paint, SSR and every browser session: nothing has been reported, so
  // the app must behave exactly as it did before the native bridge existed.
  assert.equal(resolveOnline(), true);
  assert.equal(resolveOnline({}), true);
  assert.equal(resolveOnline({ browserOnline: true }), true);
  assert.equal(resolveOnline({ nativeConnected: true }), true);
});

test("either signal reporting offline wins", () => {
  assert.equal(resolveOnline({ nativeConnected: false }), false);
  assert.equal(resolveOnline({ browserOnline: false }), false);
  assert.equal(
    resolveOnline({ browserOnline: true, nativeConnected: false }),
    false,
    "a native disconnect must not be hidden by a stale navigator.onLine",
  );
  assert.equal(
    resolveOnline({ browserOnline: false, nativeConnected: true }),
    false,
    "an offline browser signal still shows the warning (advisory, never blocking)",
  );
});

test("the hook merges both signals and cleans up, without reloading", () => {
  const hook = read("src/hooks/useOnlineStatus.ts");
  const code = stripComments(hook);

  assert.match(code, /subscribeToNetworkStatusChange/);
  assert.match(code, /resolveOnline/);
  assert.match(code, /unsubscribeNative\(\)/, "the native listener is removed on unmount");
  assert.match(code, /export const RECONNECT_EVENT/, "the existing event contract survives");

  // Phase 8: restoring connectivity revalidates; it must never reload the page.
  assert.ok(!/location\.reload|location\.replace|location\.href/.test(code));
});

// ── 2. The recovery page is real, shipped, and wired up ───────────────────

test("capacitor.config points errorPath at the shipped local page", () => {
  const config = read("capacitor.config.ts");

  assert.match(config, /errorPath:\s*'error\.html'/);
  // Inside `server`, alongside the untouched canonical URL.
  const serverBlock = config.slice(config.indexOf("server:"), config.indexOf("plugins:"));
  assert.match(serverBlock, /url:\s*'https:\/\/www\.grynd\.dedyn\.io\/'/);
  assert.match(serverBlock, /errorPath:\s*'error\.html'/);
  assert.match(config, /appId:\s*'com\.grynd\.app'/);

  // The file Capacitor resolves to `https://localhost/error.html` must exist in
  // the assets folder the local server serves, and be a real page.
  assert.ok(exists(RECOVERY_HTML), `${RECOVERY_HTML} is missing`);
  assert.ok(read(RECOVERY_HTML).includes("<!doctype html>"));
});

test("the recovery page is branded, dark and safe-area aware", () => {
  const html = read(RECOVERY_HTML);

  assert.match(html, /viewport-fit=cover/, "edge-to-edge insets are honoured");
  assert.match(html, /env\(safe-area-inset-top/, "top inset respected");
  assert.match(html, /env\(safe-area-inset-bottom/, "bottom inset respected");
  assert.match(html, /#030817/, "GRYND navy background");
  assert.match(html, /role="status"/, "state is announced");
  assert.match(html, /alt=""/, "the mark is decorative, not a second title");
  assert.match(html, /<noscript>/, "still offers a way forward without JS");
  assert.ok(exists(MARK_PNG), `${MARK_PNG} is missing`);

  const png = fs.readFileSync(path.join(ROOT, MARK_PNG));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png[25], 6, "the mark keeps transparency so it sits on the navy page");
  assert.ok(png.readUInt32BE(16) <= 192, "the mark is not shipped at full size");
});

test("retry is user-triggered, single-shot, and targets the canonical page", () => {
  const code = stripComments(read(RECOVERY_HTML));

  // One button, and one navigation, gated on the click handler.
  assert.equal((code.match(/location\.replace/g) ?? []).length, 1);
  assert.match(code, /button\.addEventListener\("click"/);
  assert.match(code, /if \(busy\) return;/, "rapid taps cannot queue extra navigations");
  assert.match(code, /button\.disabled = true;/, "the button is disabled while retrying");

  // It reloads the page the WebView failed to load — the app boots at this URL.
  assert.match(code, /var APP_URL = "https:\/\/www\.grynd\.dedyn\.io\/";/);
  assert.match(code, /location\.replace\(APP_URL\)/);
});

test("the recovery page never reloads itself and never loops", () => {
  const code = stripComments(read(RECOVERY_HTML));

  assert.ok(!/<meta[^>]+http-equiv=["']?refresh/i.test(read(RECOVERY_HTML)));
  assert.ok(!/setInterval/.test(code), "no polling");
  assert.ok(!/location\.reload/.test(code), "no bare reload");
  // The only timer is the UI reset that re-enables the button; it must not navigate.
  const timers = code.match(/setTimeout\(/g) ?? [];
  assert.equal(timers.length, 1);
  const resetBody = code.slice(code.indexOf("setTimeout("), code.indexOf("}, 10000);"));
  assert.ok(
    !/location|href|reload/.test(resetBody),
    "the reset timer must not navigate",
  );

  // Connectivity changes rewrite the copy only — they must not start a load.
  assert.match(code, /addEventListener\("online", paint\)/);
  assert.match(code, /addEventListener\("offline", paint\)/);
});

test("the recovery page cannot touch the session, storage or caches", () => {
  const code = stripComments(read(RECOVERY_HTML));

  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "document.cookie",
    "indexedDB",
    "caches.",
    "Capacitor",
    "fetch(",
    "XMLHttpRequest",
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `the recovery page must not use ${forbidden} — it is a local page with no plugin access`,
    );
  }
});

// ── 3. Live matches and existing systems are protected ───────────────────

test("no recovery path reloads the page on foreground or reconnect", () => {
  // Phase 3A/3B own waking the socket; Phase 8 must not add a reload beside it.
  for (const file of [
    "src/lib/native/appLifecycle.ts",
    "src/lib/native/socketRecovery.ts",
    "src/components/native/NativeLifecycleBridge.tsx",
    "src/components/native/NativeSystemBars.tsx",
    "src/components/states/OfflineBanner.tsx",
    "src/lib/native/connectivity.ts",
  ]) {
    const code = stripComments(read(file));
    assert.ok(
      !/location\.reload|location\.replace|window\.location\s*=|router\.reload/.test(code),
      `${file} must not force a page reload`,
    );
  }
});

test("there is still exactly one offline indicator", () => {
  const providers = read("src/app/providers.tsx");

  assert.equal((providers.match(/<OfflineBanner\s*\/>/g) ?? []).length, 1);
  assert.match(providers, /import OfflineBanner from "\.\.\/components\/states\/OfflineBanner"/);

  // No second native banner component was introduced beside it.
  const natives = fs.readdirSync(path.join(ROOT, "src/components/native"));
  assert.ok(
    !natives.some((file) => /offline|connect|error/i.test(file)),
    "native components must not add a competing connectivity/error UI",
  );
});

test("the recovery page does not claim GRYND works offline", () => {
  const html = read(RECOVERY_HTML);

  // It is a failure screen, not a cached copy of the app.
  assert.ok(!/offline mode|works offline|available offline/i.test(html));
  assert.match(html, /continues on the server/, "a live match is described as server-side");
});
