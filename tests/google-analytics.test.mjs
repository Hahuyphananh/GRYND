// tests/google-analytics.test.mjs
//
// Contract tests for the Google Analytics 4 (gtag.js) tag.
//
// Two things have to stay true, and both are easy to break by accident:
//
//   1. it is on EVERY page — that means exactly one render site, in the root
//      layout (src/app/layout.tsx), not sprinkled per page;
//   2. it is CONSENT-GATED — our privacy policy and the cookie-consent banner
//      both promise analytics load only after the visitor accepts (Law 25 /
//      GDPR), which is also how PostHog behaves. A tag that fires on page load
//      would quietly break that promise.
//
// The behavioural proof (no request until consent; the loader + the
// `gtag('config', …)` call once consent is granted; the kill switch on a
// decline) lives in qa/google-analytics-check.mjs, which drives the real
// component in a real browser.
//
// Run:  node --test tests/google-analytics.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const LAYOUT = read("src/app/layout.tsx");
const TAG = read("src/components/GoogleAnalytics.tsx");

const squash = (text) => text.replace(/\s+/g, " ").trim();
const has = (haystack, needle) =>
  squash(haystack).includes(squash(needle))
    ? true
    : (() => {
        throw new Error(`expected source to contain:\n  ${squash(needle)}`);
      })();

/** Assertions test CODE, not the prose that explains it. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

// The component's doc comment quotes the snippet it implements, so every
// source assertion below runs against the file with block comments removed.
const TAG_CODE = code(TAG);

const MEASUREMENT_ID = "G-PFN3BBLC0E";

test("the tag is rendered on every page, from the root layout", () => {
  has(LAYOUT, 'import GoogleAnalytics from "../components/GoogleAnalytics";');
  has(LAYOUT, "<GoogleAnalytics />");
  // Exactly one render site in the layout — a second one would double-count.
  const renders = LAYOUT.match(/<GoogleAnalytics\s*\/>/g) || [];
  assert.equal(renders.length, 1, "the tag must be rendered once, from the root layout");
});

test("it is Google's snippet, for the right property", () => {
  has(TAG_CODE, `export const GA_MEASUREMENT_ID = "${MEASUREMENT_ID}";`);
  has(TAG_CODE, "https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}");
  has(TAG_CODE, "window.dataLayer = window.dataLayer || [];");
  has(TAG_CODE, "function gtag(){dataLayer.push(arguments);}");
  has(TAG_CODE, "gtag('js', new Date());");
  has(TAG_CODE, "gtag('config', '${GA_MEASUREMENT_ID}');");
});

test("the loader is not on the critical path", () => {
  // Both scripts must stay afterInteractive so they never compete with
  // hydration.
  const strategies = TAG_CODE.match(/strategy="([a-zA-Z]+)"/g) || [];
  assert.equal(strategies.length, 2, "expected the two Script tags");
  assert.deepEqual(strategies, ['strategy="afterInteractive"', 'strategy="afterInteractive"']);
});

test("it stays behind the cookie-consent gate", () => {
  has(TAG_CODE, 'import { COOKIE_CONSENT_EVENT, getCookieConsent } from "../lib/cookieConsent";');
  has(TAG_CODE, 'getCookieConsent() === "accepted"');
  // The gate has to be a render guard, not just a flag: nothing may be mounted
  // (or fetched) while consent is missing or declined.
  has(TAG_CODE, "if (!accepted) return null;");
  // Accepting in the banner must enable GA in the same session, without a
  // reload; another tab's choice syncs through `storage`.
  has(TAG_CODE, "window.addEventListener(COOKIE_CONSENT_EVENT, sync);");
  has(TAG_CODE, "window.addEventListener(\"storage\", sync);");
  has(TAG_CODE, "window.removeEventListener(COOKIE_CONSENT_EVENT, sync);");
  has(TAG_CODE, "window.removeEventListener(\"storage\", sync);");
});

test("withdrawing consent silences the tag without a reload", () => {
  // `ga-disable-<ID>` is GA's documented kill switch: it stops collection and
  // stops the cookie writes.
  has(TAG_CODE, "[`ga-disable-${GA_MEASUREMENT_ID}`] = !granted;");
});

test("it is a client component and never renders markup of its own", () => {
  assert.ok(TAG.trimStart().startsWith('"use client";'), "must be a client component");
  // The gated branch returns only <Script> tags — no wrapper element, no layout
  // impact on any page.
  const gated = TAG_CODE.slice(TAG_CODE.indexOf("if (!accepted) return null;"));
  assert.ok(!/<div|<span/.test(gated), "the tag must not render any element");
});

test("the analytics only own the browser-storage key they share with PostHog", () => {
  // The consent choice itself is not re-implemented here — the tag reads the
  // one shared key, so the banner stays the single source of truth.
  has(TAG_CODE, "getCookieConsent()");
  assert.ok(
    !/localStorage|grynd_cookie_consent/.test(TAG_CODE),
    "consent must be read through lib/cookieConsent, never re-implemented",
  );
});
