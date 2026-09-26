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
  const BATTLEPASS_ROUTE = read("src/app/api/battlepass/claim/route.js");

  // The page carries our palette (dark navy backdrop, brand-yellow CTA) and
  // our name, so a member never lands on Stripe's stock white form.
  assert.match(BRANDING, /displayName: "GRYND PRO"/);
  assert.match(BRANDING, /backgroundColor: "#071536"/);
  assert.match(BRANDING, /buttonColor: "#f5ff3b"/);
  assert.match(BRANDING, /iconPath: "\/icon-192\.png"/);

  // Every Checkout Session we create goes through the branded helper, which
  // degrades instead of ever blocking a payment.
  assert.match(SUBSCRIBE_ROUTE, /createBrandedCheckoutSession\(/);
  assert.match(BATTLEPASS_ROUTE, /createBrandedCheckoutSession\(/);

  // The Checkout back button is `cancel_url`, so it points at the GRYND PRO
  // page AND is built from the origin the customer checked out from — a stored
  // env value is only the fallback, never a hardcoded host.
  assert.match(SUBSCRIBE_ROUTE, /getReturnBaseUrl\(req\)/);
  assert.match(PORTAL_ROUTE, /getReturnBaseUrl\(req\)/);
  assert.match(BATTLEPASS_ROUTE, /getReturnBaseUrl\(req\)/);

  // The Battle Pass free-trial checkout shares the same way back: cancelling
  // lands on the GRYND PRO page (the only surface with a cancelled notice),
  // while the success redirect stays on the page that re-reads the claim.
  assert.match(BATTLEPASS_ROUTE, /cancel_url: `\$\{baseUrl\}\/upgrade-pro\?checkout=cancelled`/);
  assert.match(BATTLEPASS_ROUTE, /success_url: `\$\{baseUrl\}\/battlepass\?checkout=success`/);
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
  // One authoritative resolver, reading the catalog / bound Stripe price.
  assert.match(SUBSCRIPTIONS, /export async function getProPlanDisplay\(/);
  assert.match(SUBSCRIPTIONS, /resolveSubscriptionPlanPriceCents\(/);
  assert.match(STATUS_ROUTE, /getProPlanDisplay\(\)/);

  // The client surfaces render whatever the server resolved.
  assert.match(CONTENT, /plan\.priceUsd/);
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

  // The hook only ever adopts `active` from the response body.
  assert.match(HOOK, /setActive\(Boolean\(data\?\.active\)/);
  for (const [name, source] of Object.entries(UPGRADE_SURFACE)) {
    assert.ok(
      !/(localStorage|sessionStorage)\s*\./.test(source),
      `${name} must not read membership from client storage`,
    );
  }
  // The client sends a plan key only; the server resolves the price.
  assert.match(HOOK, /JSON\.stringify\(\{ planKey \}\)/);
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
  assert.match(CONTENT, /Compete without distractions\./);
  assert.match(CONTENT, /Upgrade to GRYND PRO/);
  assert.match(CONTENT, /Manage Subscription/);
  for (const perk of [
    "Ad-free experience",
    "Advanced statistics",
    "Advanced performance analytics",
    "Detailed match history",
  ]) {
    assert.ok(
      MEMBERSHIP_DISPLAY_HAS(perk),
      `the PRO perk list should include "${perk}"`,
    );
  }
  assert.match(read("src/db/migrations/0168_membership_single_pro.sql"), /'Ad-free experience'/);
});

function MEMBERSHIP_DISPLAY_HAS(perk) {
  return DISPLAY.includes(perk) || SUBSCRIPTIONS.includes(perk);
}

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

test("the retired High Roller title is renamed in the track and migrated", () => {
  const rewards = read("src/lib/battlepassRewards.js");
  assert.ok(
    !rewards.includes("bp_high_roller_legend") && !rewards.includes("High Roller"),
    "no High Roller tier copy may remain in the reward track",
  );
  assert.match(rewards, /bp_apex_legend/);
  const migration = read("src/db/migrations/0169_battlepass_title_apex.sql");
  assert.match(migration, /UPDATE "user_special_titles"/);
  assert.match(migration, /DELETE FROM "special_titles" WHERE "key" = 'bp_high_roller_legend'/);
  assert.ok(
    read("src/db/migrations/meta/_journal.json").includes("0169_battlepass_title_apex"),
    "the migration must be journaled",
  );
});
