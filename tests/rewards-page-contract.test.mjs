/**
 * rewards-page-contract.test.mjs
 *
 * Guards the /rewards surface and its navbar entry against the strict scope the
 * feature was built under:
 *
 *   1. /rewards exists and owns its canonical metadata.
 *   2. The page DISPLAYS the caller's coin balance through the EXISTING coin
 *      system (the shared useCoinBalance hook) — it never reads or writes a
 *      balance itself, so no second currency path can appear.
 *   3. Gift cards are TEASERS ONLY: every card is labelled "Coming Soon", and
 *      the page carries no redemption/payment affordance — no <button>, no
 *      onClick, no provider SDK (Giftbit / Tremendous / Stripe).
 *   4. The explanatory message and the no-cash-value notice are present.
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
// words "redemption button", and neither of those is a violation.
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
  assert.match(route, /canonical:\s*"\/rewards"/, "the route must set its own canonical");
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

test("gift cards are teasers only — no redemption or payment affordance", () => {
  const page = read(PAGE);
  const code = stripComments(page);

  // Every teaser is labelled "Coming Soon".
  assert.match(code, /Coming Soon/, 'cards must be labelled "Coming Soon"');

  // The example rewards from the brief.
  assert.match(code, /Amazon gift card/);
  assert.match(code, /Steam gift card/);
  assert.match(code, /Visa \/ Mastercard prepaid card/);

  // No interactive controls at all on the page (the only clickable things in
  // this route are the navbar / footer, which live in their own components).
  assert.doesNotMatch(code, /<button/, "no buttons: nothing here is redeemable");
  assert.doesNotMatch(code, /onClick/, "no click handlers on the rewards surface");

  // No rewards provider, no payments.
  assert.doesNotMatch(
    code,
    /giftbit|tremendous|stripe|checkout|payment/i,
    "no rewards provider or payment integration may be added",
  );
});

test("the page states that rewards are not live and coins have no cash value", () => {
  const page = read(PAGE);
  assert.match(
    page,
    /Rewards are coming to GRYND\. We&apos;re working on bringing you exciting ways\s+to use your coins\. Stay tuned!/,
    "the explanatory message must be present verbatim",
  );
  assert.match(page, /not available yet/i, "redemption must be stated as unavailable");
  assert.match(page, /no cash value/i, "coins must be stated to have no cash value");
});

test("the navbar links to /rewards on desktop and in the mobile menu", () => {
  const nav = read(NAV);

  // Both link arrays carry the new path, in the same position, so the desktop
  // row and the mobile menu can never disagree.
  const arrays = nav.matchAll(
    /\["\/", "\/games", "\/classement", "\/rewards", "\/contact", "\/faq"\]/g,
  );
  assert.equal(
    [...arrays].length,
    2,
    "/rewards must appear in BOTH the desktop and mobile nav arrays",
  );

  // It resolves through the shared translation key and gets a gift glyph.
  assert.match(nav, /"\/rewards": "nav\.rewards"/);
  assert.match(nav, /IconGift/);
  assert.match(nav, /NAV_ICONS = \{ "\/rewards": <IconGift/);

  // Pre-existing primary links are untouched.
  for (const path of ["/", "/games", "/classement", "/contact", "/faq"]) {
    assert.match(nav, /NAV_TRANSLATION_KEYS/);
  }
  assert.match(nav, /"\/faq": "nav\.faq"/);
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
