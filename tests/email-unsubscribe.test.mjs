/**
 * email-unsubscribe.test.mjs
 *
 * Marketing emails must be easy to unfollow: every one carries a signed
 * unsubscribe link (and RFC 8058 headers) that works without a login, and the
 * public route flips the recipient's marketing preferences off.
 *
 * Run:  npm run test:emails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  ALL_MARKETING_OFF,
  buildUnsubscribeFooter,
  buildUnsubscribeUrl,
  createUnsubscribeToken,
  resolveUnsubscribeLanguage,
  UNSUBSCRIBE_EVENT_TYPE,
  UNSUBSCRIBE_LANGUAGES,
  withUnsubscribeFooter,
  verifyUnsubscribeToken,
} from "../src/lib/emails/unsubscribe.ts";
import { APP_TEXT_TRANSLATIONS, t } from "../src/lib/appTextTranslations.js";

const read = (path) => readFileSync(path, "utf8");

test("unsubscribe token round-trips the Clerk id", () => {
  const token = createUnsubscribeToken("user_abc123");
  assert.equal(verifyUnsubscribeToken(token), "user_abc123");
});

test("token is URL-safe and stable", () => {
  const token = createUnsubscribeToken("user_abc123");
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(token, createUnsubscribeToken("user_abc123"));
  assert.equal(encodeURIComponent(token), token);
});

test("tampered or malformed tokens are rejected", () => {
  const token = createUnsubscribeToken("user_abc123");
  const [payload] = token.split(".");

  assert.equal(verifyUnsubscribeToken(`${payload}.deadbeef`), null);
  assert.equal(verifyUnsubscribeToken("not-a-token"), null);
  assert.equal(verifyUnsubscribeToken(""), null);
  assert.equal(verifyUnsubscribeToken(null), null);
  assert.equal(verifyUnsubscribeToken(undefined), null);
  assert.equal(verifyUnsubscribeToken(123), null);
  // A token signed for another payload must not validate.
  assert.equal(
    verifyUnsubscribeToken(`${payload}.${createUnsubscribeToken("user_other").split(".")[1]}`),
    null,
  );
});

test("different users get different tokens", () => {
  assert.notEqual(createUnsubscribeToken("user_a"), createUnsubscribeToken("user_b"));
});

test("unsubscribe URL points at the public route with a signed token", () => {
  const url = buildUnsubscribeUrl("user_abc123");
  assert.match(url, /\/api\/emails\/unsubscribe\?token=/);
  const token = decodeURIComponent(url.split("token=")[1]);
  assert.equal(verifyUnsubscribeToken(token), "user_abc123");
});

test("footer links to the unsubscribe URL and to settings", () => {
  const footer = buildUnsubscribeFooter("user_abc123");
  assert.match(footer, /Unsubscribe/);
  assert.match(footer, /\/api\/emails\/unsubscribe\?token=/);
  assert.match(footer, /\/settings/);
});

test("withUnsubscribeFooter injects the footer inside the template", () => {
  const html = `<div style="padding:24px"><h2>Hi</h2><p>Body</p></div>`;
  const out = withUnsubscribeFooter(html, "user_abc123");
  assert.match(out, /\/api\/emails\/unsubscribe\?token=/);
  // Inserted before the container's closing tag, not after it.
  assert.ok(out.indexOf("/api/emails/unsubscribe") < out.lastIndexOf("</div>"));
  assert.ok(out.endsWith("</div>"));
});

test("withUnsubscribeFooter is idempotent", () => {
  const once = withUnsubscribeFooter("<div>Body</div>", "user_abc123");
  const twice = withUnsubscribeFooter(once, "user_abc123");
  assert.equal(twice, once);
});

test("withUnsubscribeFooter falls back to appending when no wrapper exists", () => {
  const out = withUnsubscribeFooter("<p>Body</p>", "user_abc123");
  assert.ok(out.startsWith("<p>Body</p>"));
  assert.match(out, /\/api\/emails\/unsubscribe\?token=/);
});

test("ALL_MARKETING_OFF turns every marketing preference off", () => {
  assert.deepEqual(Object.keys(ALL_MARKETING_OFF).sort(), [
    "daily",
    "progress",
    "promotions",
    "summary",
  ]);
  assert.ok(Object.values(ALL_MARKETING_OFF).every((value) => value === false));
});

// ── i18n ────────────────────────────────────────────────────────────────────

test("unsubscribe copy exists in every shipped language", () => {
  for (const lang of UNSUBSCRIBE_LANGUAGES) {
    const bundle = APP_TEXT_TRANSLATIONS[lang]?.unsubscribe;
    assert.ok(bundle, `unsubscribe namespace missing for ${lang}`);
    for (const key of [
      "unsubscribedTitle",
      "unsubscribedBody",
      "managePrefix",
      "invalidTitle",
      "invalidBody",
      "errorTitle",
      "errorBody",
      "settingsLink",
    ]) {
      assert.ok(bundle[key], `${lang}.unsubscribe.${key} missing`);
      assert.notEqual(
        t(lang, `unsubscribe.${key}`),
        `unsubscribe.${key}`,
        `${lang}.unsubscribe.${key} did not resolve`,
      );
    }
  }
});

test("resolveUnsubscribeLanguage prefers ?lang then Accept-Language", () => {
  assert.equal(resolveUnsubscribeLanguage(null, "fr"), "fr");
  assert.equal(resolveUnsubscribeLanguage("en-US,en;q=0.9", "es-MX"), "es");
  assert.equal(resolveUnsubscribeLanguage("fr-FR,fr;q=0.9,en;q=0.8"), "fr");
  assert.equal(resolveUnsubscribeLanguage("de-DE,de;q=0.9"), "en");
  assert.equal(resolveUnsubscribeLanguage(null, "zz"), "en");
  assert.equal(resolveUnsubscribeLanguage(null), "en");
});

// ── Wiring contracts ────────────────────────────────────────────────────────

test("sendEmailSafely attaches the footer and headers to marketing mail only", () => {
  const base = read("src/lib/emails/base.ts");
  assert.match(base, /from "\.\/unsubscribe"/);
  assert.match(base, /withUnsubscribeFooter\(html, user\.clerkId/);
  assert.match(base, /buildUnsubscribeUrl\(user\.clerkId/);
  assert.match(base, /List-Unsubscribe/);
  assert.match(base, /List-Unsubscribe-Post/);
  // Gated on category === "marketing" so receipts/OTPs stay untouched.
  assert.match(base, /const isMarketing = category === "marketing"/);
  assert.match(base, /const canUnsubscribe = isMarketing && Boolean\(user\.clerkId\)/);
  assert.match(base, /html: finalHtml/);
});

test("the unsubscribe route verifies the token and clears marketing prefs", () => {
  const path = "src/app/api/emails/unsubscribe/route.ts";
  assert.ok(existsSync(path), "the route must exist");
  const route = read(path);
  assert.match(route, /verifyUnsubscribeToken/);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /notificationPrefs: ALL_MARKETING_OFF/);
  // Copy comes from the app's i18n bundles, not hardcoded strings.
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/appTextTranslations"/);
  assert.match(route, /t\(lang, "unsubscribe\./);
  assert.match(route, /resolveUnsubscribeLanguage/);
});

test("every unsubscribe is recorded for compliance auditing", () => {
  const shared = read("src/lib/emails/unsubscribe.ts");
  assert.match(shared, /export const UNSUBSCRIBE_EVENT_TYPE = "unsubscribe"/);
  assert.match(shared, /db\.insert\(emailEvents\)/);
  assert.match(shared, /status: "unsubscribed"/);
  assert.equal(UNSUBSCRIBE_EVENT_TYPE, "unsubscribe");

  // Public email-link route logs both GET clicks and one-click POSTs.
  const route = read("src/app/api/emails/unsubscribe/route.ts");
  assert.match(route, /recordUnsubscribeEvent/);
  assert.match(route, /"email_link"/);
  assert.match(route, /"one_click"/);

  // The settings API logs the moment the last marketing pref is switched off.
  const settings = read("src/app/api/user/notification-preferences/route.ts");
  assert.match(settings, /recordUnsubscribeEvent/);
  assert.match(settings, /source: "settings"/);
  assert.match(settings, /!allOff\(before\)/);
});

test("settings offers a one-tap unsubscribe from all marketing email", () => {
  const page = read("src/app/settings/PageClient.jsx");
  assert.match(page, /const unsubscribeAll = async/);
  assert.match(page, /Unsubscribe from all emails/);
  assert.match(
    page,
    /promotions: false, daily: false, summary: false, progress: false/,
  );
});

test("the SMTP fallback forwards custom headers", () => {
  assert.match(read("src/lib/resend.ts"), /headers: opts\.headers/);
});

test("middleware allows the cross-origin one-click POST", () => {
  const proxy = read("src/middleware.ts");
  assert.match(proxy, /pathname === "\/api\/emails\/unsubscribe"/);
  assert.match(proxy, /!skipsCsrfGuards\(pathname\)/);
});
