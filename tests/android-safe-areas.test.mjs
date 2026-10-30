/**
 * tests/android-safe-areas.test.mjs
 *
 * Phase 5A — safe areas, system bars and the splash-to-WebView frame.
 *
 * These are configuration and CSS facts, so they are pinned as such: the
 * viewport opt-in that makes `env(safe-area-inset-*)` report anything at all,
 * the single pair of CSS variables the app reads them through, the two fixed
 * elements that consume the top inset, the native status-bar component that
 * keeps the icons readable, and the Android theme/window colours that remove
 * the white frame before the WebView paints.
 *
 * Why `viewport-fit=cover` is the load-bearing assertion: without it every
 * `env(safe-area-inset-*)` in this codebase resolves to 0, so the app's
 * existing `.safe-bottom` utility and Keno's bottom bar were no-ops on a
 * device. It is also the one change that must NOT alter browser chrome, so its
 * companion assertion is that `themeColor` is still unset.
 *
 * What this file cannot prove: how any of it looks on a phone. Insets, the
 * edge-to-edge enforcement on Android 15+, and the splash hand-off all need a
 * real device or emulator; see the report.
 *
 * Run:  node --import tsx --test tests/android-safe-areas.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const LAYOUT = "src/app/layout.tsx";
const CSS = "src/app/globals.css";
const NAV = "src/components/navigation-bar.jsx";
const SYSTEM_BARS = "src/components/native/NativeSystemBars.tsx";

/** Comments in these files explain what must NOT happen, so scan code only. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── Viewport: the opt-in that makes insets exist ──────────────────────────

test("the document opts into safe-area insets with viewport-fit=cover", () => {
  const layout = read(LAYOUT);

  assert.match(layout, /export const viewport\s*=/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(layout, /width:\s*"device-width"/);
  assert.match(layout, /initialScale:\s*1/);
});

test("browser chrome is left alone: no themeColor, no zoom overrides", () => {
  // Code only — the layout's own comment names `themeColor` to explain why it
  // is absent, which is not a reason to fail.
  const layout = stripComments(read(LAYOUT));

  assert.ok(!/themeColor/.test(layout), "themeColor would recolour browser chrome");
  assert.ok(!/maximumScale|userScalable/.test(layout), "pinch-zoom stays as it was");
});

// ── CSS: one pair of variables, one utility per edge ──────────────────────

test("globals.css reads each inset exactly once, into a variable", () => {
  const css = read(CSS);

  assert.match(css, /--safe-top:\s*env\(safe-area-inset-top/);
  assert.match(css, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  // Both fall back to 0px, so a platform without insets is unchanged.
  assert.match(css, /env\(safe-area-inset-top,\s*0px\)/);
  assert.match(css, /env\(safe-area-inset-bottom,\s*0px\)/);
});

test("the utilities that consume the variables are defined", () => {
  const css = read(CSS);

  assert.match(css, /\.safe-top\s*\{\s*padding-top:\s*var\(--safe-top\);/);
  // The pre-existing utility keeps its floor, so it cannot collapse to 0.
  assert.match(css, /\.safe-bottom\s*\{\s*padding-bottom:\s*max\(1rem,\s*env\(safe-area-inset-bottom\)\);/);
});

// ── Consumers: the two fixed elements that meet the top bar ───────────────

test("the fixed navigation bar clears the status bar without moving its background", () => {
  const nav = read(NAV);

  // `safe-top` must sit on the `fixed top-0` element itself: the padding moves
  // the content down while the bar's own tint still paints behind the bar.
  assert.match(nav, /className="safe-top fixed top-0/);
});

test("the page offset below the bar adds the same inset, and nothing else", () => {
  const layout = read(LAYOUT);

  // `calc` needs real spaces; in a Tailwind arbitrary value those are written
  // as underscores. A literal `calc(68px+var(...))` is invalid CSS and would be
  // dropped silently, which is the bug this assertion exists to catch.
  assert.match(layout, /pt-\[calc\(68px_\+_var\(--safe-top\)\)\]/);
  assert.match(layout, /sm:pt-\[calc\(4rem_\+_var\(--safe-top\)\)\]/);

  const mainTag = layout.match(/<main[\s\S]{0,400}?>/)[0];
  assert.ok(!/safe-area-inset/.test(mainTag), "insets are read through the variable only");
  assert.ok(!/pb-\[/.test(mainTag), "no global bottom padding: per-screen bars own their own");
});

test("no device-specific pixel values were introduced for insets", () => {
  const css = read(CSS);
  const layout = read(LAYOUT);

  for (const source of [css, layout]) {
    // Nothing may hardcode a status-bar height (24/48px), an iPhone inset, etc.
    assert.ok(!/padding-top:\s*\d+px;?\s*\/\*\s*safe/.test(source));
  }
  assert.ok(!/env\(safe-area-inset-top\)\s*\+\s*\d/.test(css));
});

// ── Native status bar component ───────────────────────────────────────────

test("the status-bar component is client-only, native-only and lazy", () => {
  const component = read(SYSTEM_BARS);

  assert.match(component, /^"use client";/m);
  assert.match(component, /typeof window === "undefined"/);
  assert.match(component, /Capacitor\.isNativePlatform\(\)/);
  assert.match(component, /import\("@capacitor\/status-bar"\)/);
  assert.match(component, /return null;/);
});

test("it asks for light icons on the dark bar, on launch and on every resume", () => {
  const component = read(SYSTEM_BARS);

  // `Style.Dark` in Capacitor means "light text for a dark background".
  assert.match(component, /setStyle\(\{\s*style:\s*Style\.Dark\s*\}\)/);
  assert.match(component, /setBackgroundColor\(\{\s*color:\s*STATUS_BAR_BACKGROUND\s*\}\)/);
  assert.match(component, /const STATUS_BAR_BACKGROUND = "#030817"/);

  // Re-applied when the activity comes back, through the Phase 3A event — not
  // a second plugin listener.
  assert.match(component, /subscribeToAppStateChange/);
  assert.match(component, /if \(isActive\) void apply\(\)/);
});

test("it cleans up and never touches the browser", () => {
  const component = read(SYSTEM_BARS);
  const code = stripComments(component);

  assert.match(component, /unsubscribe\?\.\(\)/);
  assert.ok(!/addEventListener\s*\(/.test(code), "no browser listener");
  assert.ok(!/visibilitychange|popstate/.test(code));
  assert.ok(!/document\./.test(code));
  assert.ok(!/backButton|socket|matchId|roomId/.test(code), "one concern, no coupling");
});

test("the status-bar component is mounted exactly once, from the root layout", () => {
  const layout = read(LAYOUT);

  assert.equal((layout.match(/<NativeSystemBars\s*\/>/g) ?? []).length, 1);
  assert.match(
    layout,
    /import NativeSystemBars from "\.\.\/components\/native\/NativeSystemBars"/,
  );
  // After the back-button mount, so the existing native mounts keep their order.
  assert.match(layout, /<NativeBackButton \/>[\s\S]{0,160}<NativeSystemBars \/>/);
});

test("Phase 3B recovery and the back-button logic are untouched", () => {
  const provider = read("src/context/SocketProvider.tsx");
  const back = read("src/lib/native/backButton.ts");
  const backComponent = read("src/components/native/NativeBackButton.tsx");

  assert.ok(!/safe-area|status-bar|StatusBar/.test(provider));
  assert.ok(!/StatusBar|safe-area/.test(back));
  assert.ok(!/StatusBar|safe-area/.test(backComponent));
});

// ── Android theme and window ──────────────────────────────────────────────

test("both Android themes paint the system bars dark with light icons", () => {
  const styles = read("android/app/src/main/res/values/styles.xml");

  assert.match(styles, /name="AppTheme\.NoActionBar"/);
  assert.match(styles, /name="AppTheme\.NoActionBarLaunch"/);
  // Two themes (app + launch) × status + navigation bar colour.
  assert.equal((styles.match(/android:statusBarColor">#030817/g) ?? []).length, 2);
  assert.equal((styles.match(/android:navigationBarColor">#030817/g) ?? []).length, 2);
  assert.equal((styles.match(/android:windowLightStatusBar">false/g) ?? []).length, 2);
});

test("the launch theme still reuses the existing splash asset", () => {
  const styles = read("android/app/src/main/res/values/styles.xml");

  assert.match(styles, /name="AppTheme\.NoActionBarLaunch" parent="Theme\.SplashScreen"/);
  assert.match(styles, /android:background">@drawable\/splash/);
  // The asset itself is not regenerated or replaced by this phase.
  assert.ok(exists("android/app/src/main/res/drawable/splash.png"));
});

test("the window between splash and first paint is dark, not white", () => {
  const layout = read("android/app/src/main/res/layout/activity_main.xml");

  assert.match(layout, /android:background="#030817"/);
  assert.match(layout, /<WebView[\s\S]{0,200}android:background="#030817"/);
});

test("the Android manifest still launches the same activity and theme", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");

  assert.match(manifest, /android:name="\.MainActivity"/);
  assert.match(manifest, /android:theme="@style\/AppTheme\.NoActionBarLaunch"/);
  assert.match(manifest, /android:label="@string\/app_name"/);
});

// ── Capacitor configuration ───────────────────────────────────────────────

test("the Capacitor config still points at the canonical URL and app identity", () => {
  const config = read("capacitor.config.ts");

  assert.match(config, /appId:\s*'com\.grynd\.app'/);
  assert.match(config, /appName:\s*'GRYND'/);
  assert.match(config, /url:\s*'https:\/\/www\.grynd\.dedyn\.io\/'/);
  // The status bar and splash keep their documented defaults: edge-to-edge is
  // not something a config flag can turn off on Android 15+, and the splash is
  // configured by the native launch theme. (Phase 5B's `Keyboard` block is the
  // only plugin config, and it is asserted by tests/android-keyboard.test.mjs.)
  assert.ok(!/StatusBar:\s*\{/.test(config));
  assert.ok(!/SplashScreen:\s*\{/.test(config));
});
