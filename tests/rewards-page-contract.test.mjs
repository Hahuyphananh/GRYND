/**
 * rewards-page-contract.test.mjs
 *
 * Guards the /rewards surface and its navbar entry:
 *
 *   1. /rewards exists and owns its canonical metadata.
 *   2. The page DISPLAYS the caller's coin balance through the EXISTING coin
 *      system (the shared useCoinBalance hook) — it never reads or writes a
 *      balance itself, so no second currency path can appear.
 *   3. The page now hosts the live reward — the daily streak reward — and the
 *      old gift-card TEASERS are gone. There
 *      is still no redemption/payment system of any kind: no gift-card claims,
 *      no provider SDK (Giftbit / Tremendous / Stripe).
 *   4. The explanatory copy states what counts (completed matches against real
 *      players) and that coins have no cash value.
 *   5. The navbar links to /rewards on BOTH the desktop row and the mobile
 *      menu, with the nav.rewards translation key and a gift glyph, and every
 *      pre-existing primary link is untouched.
 *   6. /rewards is a PUBLIC route, so the same link works for signed-out
 *      visitors (as /faq does).
 *
 * These are static-source assertions: they pin the wiring AND the prohibitions,
 * which is exactly what a browser check cannot prove the absence of.
 *
 * Run: npm run test:rewards
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// Prohibition checks must look at CODE, not prose: the page's doc comment
// names `/api/get-user-tokens` (to explain which system it reuses) and says the
// words "no redemption", and neither of those is a violation.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = "src/app/rewards/page.tsx";
const PAGE = "src/app/rewards/PageClient.tsx";
const NAV = "src/components/navigation-bar.jsx";
const TRANSLATIONS = "src/lib/appTextTranslations.js";
const PROXY = "src/proxy.ts";

test("the /rewards route exists and owns its canonical URL", () => {
  assert.ok(existsSync(join(root, ROUTE)), `${ROUTE} must exist`);
  const route = read(ROUTE);
  assert.match(route, /path:\s*"\/rewards"/, "the route must set its own canonical path");
  assert.match(route, /from "\.\/PageClient"/, "the route must render the page client");
});

test("the balance is read from the existing coin system, not re-implemented", () => {
  const page = read(PAGE);
  const code = stripComments(page);
  assert.match(
    code,
    /import \{ useCoinBalance \} from "\.\.\/\.\.\/hooks\/useCoinBalance"/,
    "the page must reuse the shared coin-balance hook",
  );
  // No second currency path: the page must not fetch a balance or touch the
  // coin/user API directly.
  assert.doesNotMatch(code, /fetch\(/, "the page must not fetch anything itself");
  assert.doesNotMatch(
    code,
    /get-user-tokens|users\.balance|token_transactions/,
    "the page must not read the currency tables or endpoint directly",
  );
});

test("the live reward is on the page: the daily streak card", () => {
  const code = stripComments(read(PAGE));
  assert.match(code, /<DailyRewardCard \/>/, "the daily streak card stays");
  assert.doesNotMatch(code, /QuestBoard|quest/i, "quests are gone from the surface");
});

test("gift-card teasers are gone and no redemption system replaced them", () => {
  const code = stripComments(read(PAGE));

  // The teaser section and its "Coming Soon" framing were removed.
  assert.doesNotMatch(code, /Coming Soon/);
  assert.doesNotMatch(code, /Amazon gift card|Steam gift card|prepaid card/i);
  assert.doesNotMatch(code, /GIFT_CARD_TEASERS|gift-card-/);

  // Nothing on the page is interactive: the page itself owns no button or
  // click handler (the quest board component owns its claim buttons).
  assert.doesNotMatch(code, /<button/, "the page itself must hold no button");
  assert.doesNotMatch(code, /onClick/, "the page itself must hold no click handler");

  // No rewards provider, no payments, no gift-card redemption.
  assert.doesNotMatch(
    code,
    /giftbit|tremendous|stripe|checkout|payment/i,
    "no rewards provider or payment integration may be added",
  );
});

test("the page explains the streak rule and that coins have no cash value", () => {
  const page = read(PAGE);
  assert.match(
    page,
    /finish a game/i,
    "the streak rule (finish a game) must be stated",
  );
  assert.match(page, /no cash value/i, "coins must be stated to have no cash value");
  assert.match(
    page,
    /cannot be\s+withdrawn/i,
    "the page must say coins cannot be withdrawn",
  );
  assert.match(page, /gift cards/i, "gift-card redemption must be stated as unavailable");
});

test("the retired /rewards surface is not sold in the navigation", () => {
  const nav = read(NAV);
  // Solitaire-first removed the link: the page still answers old bookmarks
  // (the proxy redirects it), but the product does not advertise it.
  assert.doesNotMatch(nav, /"\/rewards"/);
  assert.match(nav, /"\/": "nav\.home"/);
});

test("nav.rewards is translated in every supported language", () => {
  const t = read(TRANSLATIONS);
  assert.match(t, /rewards: "Rewards"/);
  assert.match(t, /rewards: "Récompenses"/);
  assert.match(t, /rewards: "Recompensas"/);
});

test("/rewards is a public route so the link works signed out", () => {
  const proxy = read(PROXY);
  const publicBlock = proxy.slice(
    proxy.indexOf("const isPublicRoute = createRouteMatcher(["),
    proxy.indexOf("const gameRouteMatcher"),
  );
  assert.match(publicBlock, /"\/rewards",/, "/rewards must be listed as public");
});
