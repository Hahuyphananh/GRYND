/**
 * GRYND PRO upgrade surface — contract guard for the Shop removal.
 *
 * The old token Shop (page, token purchase UI, its API routes) is gone and the
 * only paid product is the single GRYND PRO subscription. These are static
 * checks rather than mounting tests: the components need Clerk + a live Stripe
 * account, so they pin the CONTRACT that makes the flow safe:
 *
 *   1. the Shop is gone and can never sell anything again,
 *   2. the upgrade surface reuses the existing Stripe subscribe/portal routes,
 *   3. the price is resolved server-side from the plan catalog — no component
 *      hardcodes it,
 *   4. entitlement is server-authoritative: no client-side storage can claim
 *      PRO status,
 *   5. no token machinery is reachable from the upgrade flow,
 *   6. the CTA is placed on non-gameplay pages only.
 *
 * Run: node --import tsx --test tests/upgrade-pro-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const exists = (path) => fs.existsSync(path);

// ── Files that make up the upgrade experience ──────────────────────────────
const BUTTON = read("src/components/UpgradeProButton.tsx");
const MODAL = read("src/components/UpgradeProModal.tsx");
const CONTENT = read("src/components/UpgradeProContent.tsx");
const HOOK = read("src/lib/upgradePro.ts");
const DISPLAY = read("src/lib/membershipDisplay.ts");
const PAGE = read("src/app/upgrade-pro/page.tsx");
const PAGE_CLIENT = read("src/app/upgrade-pro/PageClient.tsx");
const SUBSCRIPTIONS = read("src/lib/stripe/subscriptions.ts");
const STATUS_ROUTE = read("src/app/api/membership/status/route.ts");
const SUBSCRIBE_ROUTE = read("src/app/api/stripe/subscribe/route.ts");
const PORTAL_ROUTE = read("src/app/api/stripe/portal/route.ts");
const NAVBAR = read("src/components/navigation-bar.jsx");
const PROXY = read("src/proxy.ts");
const TRANSLATIONS = read("src/lib/appTextTranslations.js");
const PRO_BILLING = read("src/lib/proBilling.ts");
const PRO_BENEFITS = read("src/lib/proBenefits.ts");
const MIGRATION_0215 = read("src/db/migrations/0215_pro_benefit_copy.sql");

const UPGRADE_SURFACE = { BUTTON, MODAL, CONTENT, HOOK, PAGE, PAGE_CLIENT };

test("the reusable upgrade components exist", () => {
  for (const path of [
    "src/components/UpgradeProButton.tsx",
    "src/components/UpgradeProModal.tsx",
    "src/components/UpgradeProContent.tsx",
    "src/lib/upgradePro.ts",
    "src/lib/membershipDisplay.ts",
    "src/app/upgrade-pro/page.tsx",
    "src/app/upgrade-pro/PageClient.tsx",
  ]) {
    assert.ok(exists(path), `${path} should exist`);
  }
});

test("the old Shop is gone (files deleted)", () => {
  for (const path of [
    "src/components/ShopBuyClient.tsx",
    "src/components/ShopItemsClient.tsx",
    "src/components/CosmeticsClient.tsx",
    "src/app/api/shop/items/route.js",
    "src/app/api/shop/items/route.ts",
    "src/app/api/shop/items/buy/route.js",
    "src/app/api/shop/items/buy/route.ts",
  ]) {
    assert.ok(!exists(path), `${path} should have been removed`);
  }
});

test("/shop redirects to /upgrade-pro and sells nothing", () => {
  // The route itself is gone — the legacy URL is a config-level 308, so it can
  // never render a shop again (and crawlers don't re-fetch a soft redirect).
  assert.ok(!exists("src/app/shop/page.tsx"), "the /shop route should be removed");
  const config = read("next.config.js");
  assert.match(
    config,
    /source: "\/shop",\s*\n\s*destination: "\/upgrade-pro",\s*\n\s*permanent: true,/,
  );
});

test("no page or component links to the removed Shop", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      // The retired boost-activation endpoint is an API path, not a link (the
      // legacy /shop URL is now a config-level redirect, not a route file).
      if (path.startsWith("src/app/api/shop/")) continue;
      if (read(path).includes('\"/shop\"')) offenders.push(path);
    }
  };
  walk("src/app");
  walk("src/components");
  assert.deepEqual(offenders, [], `these files still link to /shop: ${offenders}`);
});

test("checkout, portal and success URLs all return to /upgrade-pro", () => {
  assert.match(SUBSCRIBE_ROUTE, /success_url: `\$\{baseUrl\}\/upgrade-pro/);
  assert.match(SUBSCRIBE_ROUTE, /cancel_url: `\$\{baseUrl\}\/upgrade-pro/);
  assert.match(PORTAL_ROUTE, /return_url: `\$\{baseUrl\}\/upgrade-pro`/);
  assert.ok(
    !SUBSCRIBE_ROUTE.includes("/shop") && !PORTAL_ROUTE.includes("/shop"),
    "Stripe return URLs must not point at the removed Shop",
  );
});

test("the Checkout page is GRYND-branded and its back button returns to /upgrade-pro", () => {
  const BRANDING = read("src/lib/stripe/checkoutBranding.ts");

  // The page carries our palette (dark navy backdrop, brand-yellow CTA) and
  // our name, so a member never lands on Stripe's stock white form.
  assert.match(BRANDING, /displayName: "GRYND PRO"/);
  assert.match(BRANDING, /backgroundColor: "#071536"/);
  assert.match(BRANDING, /buttonColor: "#f5ff3b"/);
  assert.match(BRANDING, /iconPath: "\/icon-192\.png"/);

  // Every Checkout Session we create goes through the branded helper, which
  // degrades instead of ever blocking a payment.
  assert.match(SUBSCRIBE_ROUTE, /createBrandedCheckoutSession\(/);

  // The Checkout back button is `cancel_url`, so it points at the GRYND PRO
  // page AND is built from the origin the customer checked out from — a stored
  // env value is only the fallback, never a hardcoded host.
  assert.match(SUBSCRIBE_ROUTE, /getReturnBaseUrl\(req\)/);
  assert.match(PORTAL_ROUTE, /getReturnBaseUrl\(req\)/);
  assert.ok(
    !SUBSCRIBE_ROUTE.includes("getBaseUrl()") &&
      !PORTAL_ROUTE.includes("getBaseUrl()"),
    "Stripe return URLs must resolve from the request origin, not a bare env read",
  );
});

test("the navbar offers GRYND PRO instead of a Shop", () => {
  assert.ok(!NAVBAR.includes('"/shop"'), "navbar must not link to /shop");
  assert.ok(NAVBAR.includes('"/upgrade-pro"'), "navbar should link to /upgrade-pro");
  assert.ok(
    !NAVBAR.includes("IconShoppingBag"),
    "the Shop bag icon should be gone from the navbar",
  );
});

test("the price is resolved server-side and rendered from the plan, never hardcoded", () => {
  // One authoritative resolver, reading the catalog / bound Stripe price, and
  // taking the currency the caller's country resolves to (base CAD when the
  // bound price has no amount configured for that currency).
  assert.match(SUBSCRIPTIONS, /export async function getProPlanDisplay\(/);
  assert.match(SUBSCRIPTIONS, /resolveSubscriptionPlanPriceCents\(/);
  assert.match(SUBSCRIPTIONS, /resolveProBillingAmountsForCurrency\(/);
  assert.match(STATUS_ROUTE, /getProPlanDisplay\(currency\)/);

  // The client surfaces render whatever the server resolved: the price comes
  // off the resolved plan's per-interval billing options — the component holds
  // no price of its own, for any of the three options.
  assert.match(CONTENT, /plan\.billingOptions/);
  assert.match(CONTENT, /option\.priceDisplay/);
  assert.doesNotMatch(CONTENT, /plan\.priceUsd\s*[=+\-]/, "the component must not derive a price");
  // …and the symbol is never written by a component either: it arrives with
  // the resolved option (`currencySymbol`), so a hardcoded "$" cannot survive
  // a currency switch.
  assert.ok(
    !/\$\{option\./.test(CONTENT),
    "the price must be rendered as resolved, not re-symbolised in the component",
  );
  // Every option's price is resolved server-side from a bound Stripe price.
  assert.match(PRO_BILLING, /PRO_BILLING_INTERVALS/);
  assert.match(SUBSCRIPTIONS, /stripePriceIdWeekly|stripe_price_id_weekly/);
  assert.match(SUBSCRIPTIONS, /stripePriceIdYearly|stripe_price_id_yearly/);
  assert.ok(
    !/\$\s?9\.99|\b999\b/.test(BUTTON + MODAL + CONTENT + PAGE_CLIENT),
    "no component may hardcode the subscription price",
  );

  // Exactly one numeric fallback in the whole resolver (a named constant).
  const declarations =
    SUBSCRIPTIONS.match(/FALLBACK_PRO_PRICE_CENTS = \d+/g) ?? [];
  assert.equal(declarations.length, 1, "only one price fallback is allowed");
  assert.ok(
    !/priceCents:\s*\d/.test(SUBSCRIPTIONS),
    "the resolver must not inline a numeric price outside the fallback constant",
  );
});

test("entitlement is server-authoritative — the client can never claim PRO", () => {
  assert.match(STATUS_ROUTE, /findActiveSubscription\(userId\)/);
  assert.match(STATUS_ROUTE, /active: true/);
  assert.match(STATUS_ROUTE, /active: false/);

  // The hook only ever adopts `active` from the response body — and only for a
  // Pro tier. (The shared store that dedupes the call keeps the same rule.)
  assert.match(HOOK, /active: Boolean\(data\?\.active\) && data\?\.tier === "pro"/);
  for (const [name, source] of Object.entries(UPGRADE_SURFACE)) {
    assert.ok(
      !/(localStorage|sessionStorage)\s*\./.test(source),
      `${name} must not read membership from client storage`,
    );
  }
  // The client sends a plan key and WHICH approved interval to buy — never a
  // price. The server resolves the amount from the bound Stripe price, and the
  // interval is validated server-side against the allowed set.
  assert.match(HOOK, /JSON\.stringify\(\{ planKey, interval \}\)/);
  assert.ok(
    !/JSON\.stringify\(\{[^}]*price/.test(HOOK),
    "the client must never send a price",
  );
  assert.match(SUBSCRIBE_ROUTE, /PRO_BILLING_INTERVALS|isProBillingInterval/);
});

test("the upgrade flow reuses the existing Stripe endpoints and no token system", () => {
  assert.match(HOOK, /fetch\("\/api\/stripe\/subscribe"/);
  assert.match(HOOK, /fetch\("\/api\/stripe\/portal"/);
  for (const [name, source] of Object.entries(UPGRADE_SURFACE)) {
    assert.ok(!source.includes("/api/shop"), `${name} must not touch the Shop API`);
    assert.ok(!source.includes("/api/tokens"), `${name} must not touch token APIs`);
    assert.ok(
      !source.includes("creditUserBalance") && !source.includes("tokenTransactions"),
      `${name} must not touch token crediting`,
    );
  }
});

test("the modal shows the GRYND PRO offer with the pack-mega artwork", () => {
  assert.match(CONTENT, /"\/images\/pack-mega\.png"/);

  // The offer copy is TRANSLATED, not hardcoded: the component renders the
  // shared `pro.*` keys, and each key it renders exists in the English bundle
  // that every locale falls back through.
  assert.match(CONTENT, /t\("pro\.lead"\)/);
  assert.match(TRANSLATIONS, /lead: "Compete without distractions\."/);
  assert.match(CONTENT, /t\("pro\.cta\.subscribe"/);
  assert.match(CONTENT, /t\("pro\.cta\.manage"\)/);
  // The CTA carries the fully formatted price (symbol included), so the copy has
  // no currency of its own — the same key is correct in CAD, USD, EUR…
  assert.match(TRANSLATIONS, /subscribe: "Subscribe — \{price}\/\{unit}\"/);
  assert.ok(
    !/equivalent: "About \$\{amount}/.test(TRANSLATIONS) &&
      !/save: "Save \$\{amount}/.test(TRANSLATIONS),
    "no pro.* copy may hardcode a currency symbol",
  );
  assert.match(TRANSLATIONS, /manage: "Manage subscription"/);

  // All three billing options are offered, and the offer states plainly that
  // they are the same membership.
  assert.match(CONTENT, /PRO_BILLING_INTERVALS\.map/);
  assert.match(TRANSLATIONS, /same_membership:/);

  // The advertised benefits come from ONE approved catalog (lib/proBenefits.ts)
  // — never from whatever a plan row happens to contain — and only benefits
  // marked `available` may be rendered. An approved-but-unbuilt benefit is
  // recorded and translated, but must not appear on the offer.
  assert.match(
    CONTENT,
    /import \{ ADVERTISED_PRO_BENEFITS \} from "\.\.\/lib\/proBenefits";/,
  );
  assert.match(CONTENT, /ADVERTISED_PRO_BENEFITS\.map/);
  assert.match(CONTENT, /t\(`pro\.benefit\.\$\{id\}`\)/);
  assert.match(
    PRO_BENEFITS,
    /export const ADVERTISED_PRO_BENEFITS: readonly ProBenefit\[\] = PRO_BENEFITS\.filter\(\s*\(benefit\) => benefit\.availability === "available",\s*\);/,
    "the advertised set must be derived from the catalog's availability",
  );
  assert.match(
    PRO_BENEFITS,
    /\{ id: "ad_free", availability: "available" \}/,
    "ad-free is enforced today (lib/adEntitlement.ts) and stays advertised",
  );
  assert.ok(
    !/id: "(analytics|leaderboards|private_rooms)", availability: "available"/.test(
      PRO_BENEFITS,
    ),
    "statistics / ranking graphs / private rooms are not built yet — they must not be advertised",
  );

  // The perk row the API serves (/api/membership/status sends `plan.perks`) is
  // the same catalog, and the retired claims are gone from it. The comments in
  // the migration deliberately NAME the claims it removes (that is the audit
  // trail), so the check reads the statement — comments stripped — not the file.
  const sql = MIGRATION_0215.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.match(sql, /'Ad-free browsing and gaming'/);
  assert.match(
    sql,
    /'Priority matchmaking — a fair queue tie-break, never a skill advantage'/,
  );
  assert.ok(
    !/Detailed match history|Custom chat color|Priority support|customization/i.test(
      sql,
    ),
    "the plan row must not carry a retracted claim",
  );
});

test("every dynamic PRO string resolves in all three languages", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");

  // The keys the component BUILDS at runtime (template literals) can't be
  // grepped as literals, so they are enumerated here and resolved through the
  // real bundle. A locale that is missing one would otherwise render the raw
  // key — or silently fall back to English mid-sentence.
  const intervals = ["weekly", "monthly", "yearly"];
  // Derived from the catalog, not a second hand-kept list: every approved
  // benefit must be translated in every locale — INCLUDING the ones not
  // advertised yet, so the surface that ships each feature only has to flip its
  // availability.
  const { PRO_BENEFIT_IDS } = await import("../src/lib/proBenefits.ts");
  const benefits = [...PRO_BENEFIT_IDS];
  const keys = [
    ...intervals.map((i) => `pro.interval.${i}`),
    ...intervals.map((i) => `pro.unit.${i}`),
    ...benefits.map((b) => `pro.benefit.${b}`),
    ...["subscribe", "switch", "manage", "opening"].map((k) => `pro.cta.${k}`),
    "pro.lead",
    "pro.headline",
    "pro.subtitle",
    "pro.membership",
    "pro.interval_group",
    "pro.badge.best_value",
    "pro.equivalent",
    "pro.save",
    "pro.flexible_weekly",
    "pro.selected",
    "pro.same_membership",
    "pro.cancel_anytime",
    "pro.active_plain",
    "pro.active_renews",
    "pro.close",
    "pro.benefits_title",
    "pro.no_advantage",
    "pro.error_generic",
    "pro.checkout_cancelled",
    "pro.checkout_activating",
    "pro.checkout_active",
    "pro.free_title",
    "pro.free_body",
    "pro.free_note",
    "pro.billing_title",
    "pro.billing_current",
    "pro.billing_options_lead",
    "pro.billing_change",
    "pro.billing_profile_lead",
    "pro.billing_profile_link",
  ];

  for (const lang of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = t(lang, key);
      assert.ok(
        typeof value === "string" && value.length > 0 && value !== key,
        `${lang} is missing ${key}`,
      );
    }
  }
});

test("the upgrade CTA sits on non-gameplay pages only", () => {
  for (const path of [
    "src/app/PageClient.jsx",
    "src/app/casino/PageClient.jsx",
    "src/app/classement/PageClient.jsx",
    "src/app/profil/PageClient.jsx",
    "src/app/settings/PageClient.jsx",
  ]) {
    assert.ok(
      read(path).includes("UpgradeProButton"),
      `${path} should render the upgrade CTA`,
    );
  }

  // Nothing under a match/board route may render the CTA: those paths are the
  // active-gameplay surfaces (the games hub itself is fine).
  const gameplayDirs = ["src/app/casino", "src/app/uno"];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      // The hub page /casino/PageClient.jsx is a non-gameplay surface.
      if (path === "src/app/casino/PageClient.jsx") continue;
      if (read(path).includes("UpgradeProButton")) offenders.push(path);
    }
  };
  for (const dir of gameplayDirs) if (exists(dir)) walk(dir);
  assert.deepEqual(offenders, [], `upgrade CTA found inside gameplay: ${offenders}`);
});

test("the upgrade landing page is public and never prerendered for one user", () => {
  assert.ok(PROXY.includes('"/upgrade-pro"'), "proxy should treat it as public");
  assert.match(PAGE, /dynamic = "force-dynamic"/);
  assert.match(PAGE, /findActiveSubscription/);
  assert.match(PAGE, /getProPlanDisplay/);
});

test("the retired High Roller title is renamed in the migration", () => {
  const migration = read("src/db/migrations/0169_battlepass_title_apex.sql");
  assert.match(migration, /UPDATE "user_special_titles"/);
  assert.match(migration, /DELETE FROM "special_titles" WHERE "key" = 'bp_high_roller_legend'/);
  assert.ok(
    read("src/db/migrations/meta/_journal.json").includes("0169_battlepass_title_apex"),
    "the migration must be journaled",
  );
});
