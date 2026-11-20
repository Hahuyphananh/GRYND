/**
 * native-ad-gates.test.mjs
 *
 * Every ad surface in the app must be decided on the SERVER, from the shell's
 * User-Agent — not by a prop, a cookie or a feature flag the WebView could keep.
 *
 * Why this is a policy test and not a nicety: the Play listing states what the
 * app's advertising behaviour is. AdSense is licensed for web pages, and a
 * third-party display/video network inside a WebView is a decision the listing
 * and the Data safety form have to reflect. A surface that quietly keeps
 * serving in the app makes that form false.
 *
 * The four surfaces:
 *   1. AdSense        — components/AdSenseScript.tsx + AdSlot.tsx (server)
 *   2. Hilltop banner — components/ads/HilltopBanner.tsx (server)
 *   3. Post-match VAST— app/api/ads/post-match/route.ts (server answer)
 *   4. The WebView backup path — AndroidManifest allowBackup
 *
 * Run:  npm run test:native-ads
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
/** Strip comments so a URL or an identifier in prose cannot satisfy a check. */
const code = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const ADSENSE = read("src/components/AdSenseScript.tsx");
const AD_SLOT = read("src/components/AdSlot.tsx");
const HILLTOP = read("src/components/ads/HilltopBanner.tsx");
const POST_MATCH_ROUTE = read("src/app/api/ads/post-match/route.ts");
const POST_MATCH_SLOT = read("src/components/ads/PostMatchAdSlot.tsx");
const MANIFEST = read("android/app/src/main/AndroidManifest.xml");

test("AdSense is gated before any other consideration", () => {
  for (const [name, source] of [
    ["AdSenseScript", ADSENSE],
    ["AdSlot", AD_SLOT],
  ]) {
    const body = code(source);
    assert.match(
      body,
      /import \{ isNativeShellDocument \} from "[./]*\/?lib\/native\/shellServer"/,
      `${name} must read the server-side shell answer`
    );
    assert.match(body, /await isNativeShellDocument\(\)/, `${name} must call it`);
    assert.ok(
      body.indexOf("isNativeShellDocument()") < body.indexOf("adsEnabled()"),
      `${name} must refuse the app before it even looks at the ad switches`
    );
  }
});

test("the Hilltop banner is gated before configuration and entitlement", () => {
  const body = code(HILLTOP);
  assert.match(body, /import \{ isNativeShellDocument \} from "[./]*\/?lib\/native\/shellServer"/);
  assert.match(body, /await isNativeShellDocument\(\)/);
  assert.ok(
    body.indexOf("isNativeShellDocument()") < body.indexOf("hilltopBannerAllowed("),
    "the shell gate must come before the provider gate"
  );
  assert.ok(
    body.indexOf("isNativeShellDocument()") < body.indexOf("isAdFreeViewer("),
    "the shell gate must come before the membership lookup"
  );
  // A server component still: a client gate here would be a hydration mismatch.
  assert.ok(!/"use client"/.test(body));
});

test("the post-match surface refuses the app from the route, not the client", () => {
  const route = code(POST_MATCH_ROUTE);
  assert.match(route, /import \{ isNativeShellDocument \} from "[./]*\/?lib\/native\/shellServer"/);
  assert.match(route, /if \(await isNativeShellDocument\(\)\)/);
  assert.match(route, /enabled: false/, "the answer must be an explicit no");
  assert.ok(
    route.indexOf("isNativeShellDocument()") < route.indexOf("postMatchAdSurface("),
    "the shell must be refused before the entitlement query"
  );
  // The slot must not grow a client-side bypass around the server's answer.
  const slot = code(POST_MATCH_SLOT);
  assert.ok(
    !/isNativeShell|navigator\.userAgent|Capacitor/.test(slot),
    "the slot trusts the server's answer and nothing else"
  );
  // Both result screens reach the ad only through the slot (which asks the
  // route), so one gate covers every game.
  for (const screen of [
    "src/components/result/PvpResultScreen.jsx",
    "src/components/solitaire-duel/SoloSolitaireGame.tsx",
  ]) {
    const source = code(read(screen));
    assert.match(source, /import PostMatchAdSlot/, `${screen} must use the shared slot`);
    assert.ok(
      !/PostMatchVideoAd/.test(source),
      `${screen} must not mount the creative directly — that would bypass the route`
    );
  }
});

test("the answer for the app is a clean no, so nothing stalls the result screen", () => {
  // The slot settles on `!enabled` and releases the held exit action; an answer
  // with `enabled: true` would leave the player on a dead button.
  const route = code(POST_MATCH_ROUTE);
  assert.match(route, /enabled: false, adFree: false/);
  assert.match(route, /"Cache-Control": "no-store"/, "a cached yes must not outlive the gate");
});

test("the installed app does not back up its WebView session", () => {
  assert.match(
    MANIFEST,
    /android:allowBackup="false"/,
    "auto-backup would restore a stale session on another device"
  );
  assert.equal(
    (MANIFEST.match(/uses-permission/g) ?? []).length,
    1,
    "the app must still request only INTERNET"
  );
  assert.match(MANIFEST, /android\.permission\.INTERNET/);
});

test("no ad surface can be switched on from the client", () => {
  // The three gates read the SERVER's answer. None of them consults a query
  // parameter, a cookie, localStorage or a prop that a WebView could set.
  for (const [name, source] of [
    ["HilltopBanner", HILLTOP],
    ["post-match route", POST_MATCH_ROUTE],
  ]) {
    const body = code(source);
    assert.ok(
      !/localStorage|sessionStorage|document\.cookie|searchParams|request\.json/.test(body),
      `${name} must not read client-supplied state`
    );
  }
});
