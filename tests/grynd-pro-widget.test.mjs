/**
 * grynd-pro-widget.test.mjs
 *
 * THE RESTORED GRYND PRO CARD.
 *
 * The floating bottom-right card was mounted per page before (casino hub, game
 * landing pages). It is now mounted ONCE for the site, which moves the rules
 * that used to be implicit into `lib/proWidget.ts`. This suite pins them:
 *
 *   1. ROUTES — it appears on browsing pages only: never over a live board, a
 *      match, a bot picker, the upgrade page it points at, or auth.
 *   2. DISMISSAL — closing it lasts the browsing session, not forever.
 *   3. MONEY — it reuses the existing offer button and defines no price, no
 *      Stripe call and no entitlement logic of its own.
 *   4. MEMBERSHIP — an active PRO member is never shown an upsell.
 *
 * Run:  node --import tsx --test tests/grynd-pro-widget.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  PRO_WIDGET_DISMISS_KEY,
  shouldShowProWidget,
} from "../src/lib/proWidget.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const WIDGET = "src/components/GryndProWidget.tsx";
const CHROME = "src/components/SiteChrome.tsx";

// ── 1. Route eligibility ──────────────────────────────────────────────────

test("routes: browsing pages show the card", () => {
  for (const path of [
    "/",
    "/casino",
    "/casino/solitaire-duel",
    "/games/solitaire-duel",
    "/games/chess",
    "/faq",
    "/classement",
    "/profil/abc123",
    "/pro",
  ]) {
    assert.equal(shouldShowProWidget(path), true, `${path} is a browsing page`);
  }
});

test("routes: it never sits over a live board or a match", () => {
  for (const path of [
    "/solitaire",
    "/daily",
    "/games/solitaire-duel/play",
    "/casino/solitaire-duel/abc123",
    "/casino/solitaire-duel/play-ai",
    "/casino/chess/xyz789",
    "/casino/mines-pvp/practice",
  ]) {
    assert.equal(shouldShowProWidget(path), false, `${path} is gameplay`);
  }
});

test("routes: never on the upgrade page, auth, settings or the portal", () => {
  for (const path of [
    "/upgrade-pro",
    "/upgrade-pro/",
    "/upgrade-pro?checkout=success",
    "/sign-in",
    "/sign-up",
    "/sign-in/sso-callback",
    "/settings",
    "/play/solitaire-duel",
    "/welcome",
    "/welcome/questionnaire",
  ]) {
    assert.equal(shouldShowProWidget(path), false, `${path} must not carry the card`);
  }
});

test("routes: an empty or missing pathname is treated as the home page", () => {
  assert.equal(shouldShowProWidget(undefined), true);
  assert.equal(shouldShowProWidget(null), true);
  assert.equal(shouldShowProWidget(""), true);
  assert.equal(shouldShowProWidget("/casino#top"), true);
});

// ── 2. Dismissal ─────────────────────────────────────────────────────────

test("dismissal: the close lasts this browsing session, not forever", async () => {
  assert.equal(PRO_WIDGET_DISMISS_KEY, "grynd.proWidget.dismissed.v1");
  const lib = await import("../src/lib/proWidget.ts");
  assert.equal(typeof lib.dismissProWidget, "function");
  assert.equal(typeof lib.isProWidgetDismissed, "function");
  const src = code("src/lib/proWidget.ts");
  // sessionStorage (per tab), NOT localStorage.
  assert.match(src, /window\.sessionStorage\.setItem\(PRO_WIDGET_DISMISS_KEY, "1"\)/);
  assert.match(src, /window\.sessionStorage\.getItem\(PRO_WIDGET_DISMISS_KEY\) === "1"/);
  assert.equal(src.includes("localStorage"), false, "a dismissal must not be permanent");
});

test("dismissal: storage failures are survival, not a crash", () => {
  // Read WITH comments: the guards are documented in place.
  const src = read("src/lib/proWidget.ts");
  // Both helpers are wrapped: a browser that blocks storage still renders.
  assert.match(src, /try \{\s*return window\.sessionStorage\.getItem/);
  assert.match(src, /catch \{\s*return false;/);
  assert.match(src, /catch \{\s*\/\/ Storage unavailable/);
});

// ── 3. The card itself ───────────────────────────────────────────────────

test("widget: it is the recovered card, now dismissible", () => {
  const widget = code(WIDGET);

  // Branding, a concise message, and a close control with an accessible name.
  assert.match(widget, /GRYND PRO/);
  assert.match(widget, /Convenience only/);
  assert.match(widget, /aria-label="Dismiss the GRYND PRO offer"/);
  assert.match(widget, /dismissProWidget\(\)/);
  assert.match(widget, /isProWidgetDismissed\(\)/);
  assert.match(widget, /data-testid="grynd-pro-widget"/);

  // Bottom-right, above the mobile sticky CTA, respecting the safe area.
  assert.match(widget, /fixed right-3/);
  assert.match(widget, /bottom-\[calc\(4\.75rem\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(widget, /md:bottom-4 md:right-4/);
  assert.match(widget, /max-w|w-\[min\(18rem/);
  // Below the chat (z-70), cookie banner (z-60) and sticky CTA (z-50).
  assert.match(widget, /z-40/);
});

test("widget: it reuses the offer button and defines no money of its own", () => {
  const widget = code(WIDGET);
  assert.match(widget, /import UpgradeProButton from "\.\/UpgradeProButton"/);
  assert.match(widget, /<UpgradeProButton[^>]*linkToPage/);
  assert.match(widget, /UPGRADE_PRO_PATH/);
  // Prices, plans and payment code live in the catalog/Stripe layer only.
  for (const forbidden of ["priceUsd", "priceDisplay", "/api/stripe", "checkout", "subscribe", "cents"]) {
    assert.equal(widget.includes(forbidden), false, `the widget must not contain ${forbidden}`);
  }
});

test("widget: membership is the server's answer, and PRO is never upsold", () => {
  const widget = code(WIDGET);
  assert.match(widget, /useMembershipStatus\(\)/);
  assert.match(widget, /if \(!loaded \|\| !signedIn \|\| active \|\| dismissed\) return null/);
  // It must never decide entitlement locally.
  assert.equal(widget.includes("localStorage"), false);
  assert.equal(widget.includes("tier =="), false);
});

// ── 4. One mount ─────────────────────────────────────────────────────────

test("mount: the site chrome renders it once, behind the route gate", () => {
  const chrome = code(CHROME);
  assert.match(chrome, /import \{ shouldShowProWidget \} from "\.\.\/lib\/proWidget"/);
  assert.match(chrome, /import GryndProWidget from "\.\/GryndProWidget"/);
  assert.match(chrome, /shouldShowProWidget\(pathname\) && <GryndProWidget \/>/);
  assert.equal((chrome.match(/<GryndProWidget \/>/g) ?? []).length, 1, "exactly one mount");
  // The portal surface returns before the site chrome, so a portal frame never
  // gets the card even if the gate changes.
  const portalReturn = chrome.indexOf("isPortalPlayPath(pathname)");
  const mount = chrome.indexOf("<GryndProWidget />");
  assert.ok(portalReturn > 0 && mount > portalReturn, "the mount must sit after the portal guard");
});

test("mount: the old per-page mounts are gone, so the card cannot double up", () => {
  for (const path of ["src/app/casino/PageClient.jsx", "src/components/game-landing/GameLanding.tsx"]) {
    assert.equal(read(path).includes("GryndProWidget"), false, `${path} must no longer mount the card`);
  }
});
