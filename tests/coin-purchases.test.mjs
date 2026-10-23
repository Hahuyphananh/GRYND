/**
 * coin-purchases.test.mjs
 *
 * Guards the OPTIONAL one-time coin shop preparation:
 *
 *   1. the feature flag is opt-in only — every value except exactly "1" keeps
 *      coin purchases disabled, so no environment sells coins by accident;
 *   2. the launch catalog is three keys into the EXISTING `token_packages`
 *      table (no second package system, no code-side price or coin amount);
 *   3. every catalog row is validated strictly before it can be offered — a
 *      $0 placeholder, a fractional amount, a negative bonus or a disabled row
 *      is dropped rather than coerced;
 *   4. the public API cannot create a Checkout Session (there is no session
 *      creation in this feature at all, and the disabled branch returns before
 *      any DB read);
 *   5. the UI offers no active purchase action while fulfilment is not
 *      implemented, and renders nothing when the flag is off;
 *   6. the displayed price and the Stripe charge share ONE currency constant.
 *
 * Run: node --import tsx --test tests/coin-purchases.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  COIN_CHECKOUT_READY,
  COIN_PACKAGE_CURRENCY,
  COIN_PURCHASES_FLAG,
  INITIAL_COIN_OFFER_KEYS,
  isCoinPurchasesEnabled,
  selectInitialCoinOffers,
  validateCoinPackage,
} from "../src/lib/coinPurchases.ts";
import { PACKAGE_CURRENCY } from "../src/lib/stripe/packages.ts";

const read = (path) => fs.readFileSync(path, "utf8");
// Prohibition checks look at CODE, not prose: these modules legitimately
// explain in comments which systems they do NOT touch.
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = read("src/app/api/coins/packages/route.ts");
const COMPONENT = read("src/components/CoinShopOffers.tsx");
const LIB = read("src/lib/coinPurchases.ts");
const PACKAGES = read("src/lib/stripe/packages.ts");
const REWARDS = read("src/app/rewards/PageClient.tsx");
const SCHEMA = read("src/db/schema.ts");

const baseRow = (overrides = {}) => ({
  key: "starter",
  name: "Starter",
  tokenAmount: 5000,
  bonusTokens: 0,
  priceCents: 499,
  enabled: true,
  featured: false,
  sortOrder: 1,
  badge: null,
  ...overrides,
});

// ── 1. The feature flag ────────────────────────────────────────────────────

test("the flag defaults to disabled for every value that is not exactly \"1\"", () => {
  assert.equal(COIN_PURCHASES_FLAG, "COIN_PURCHASES_ENABLED");

  for (const value of [
    undefined,
    "",
    " ",
    "0",
    "false",
    "true",
    "TRUE",
    "yes",
    "on",
    "enabled",
    "01",
    "2",
  ]) {
    assert.equal(
      isCoinPurchasesEnabled({ COIN_PURCHASES_ENABLED: value }),
      false,
      `value ${JSON.stringify(value)} must leave coin purchases disabled`,
    );
  }
});

test("only a deliberate COIN_PURCHASES_ENABLED=1 enables coin purchases", () => {
  assert.equal(isCoinPurchasesEnabled({ COIN_PURCHASES_ENABLED: "1" }), true);
  // Whitespace around the value is tolerated; the value itself is not widened.
  assert.equal(isCoinPurchasesEnabled({ COIN_PURCHASES_ENABLED: " 1 " }), true);
});

test("the process environment is disabled unless it explicitly opts in", () => {
  const raw = process.env.COIN_PURCHASES_ENABLED;
  const expected = (raw ?? "").trim() === "1";
  assert.equal(isCoinPurchasesEnabled(), expected);
});

// ── 2. The launch catalog reuses token_packages ────────────────────────────

test("the launch catalog is three keys into the existing package table", () => {
  assert.deepEqual([...INITIAL_COIN_OFFER_KEYS], ["starter", "medium", "large"]);
  assert.equal(new Set(INITIAL_COIN_OFFER_KEYS).size, 3);

  // The keys exist as seeded catalog rows (migration 0115).
  const seed = read("src/db/migrations/0115_tokens_offer_catalog.sql");
  for (const key of INITIAL_COIN_OFFER_KEYS) {
    assert.match(seed, new RegExp(`\\('${key}',`), `${key} must be a seeded row`);
  }

  // One catalog, not two: the resolver reads `token_packages`.
  assert.match(LIB, /import \{[^}]*\btokenPackages\b[^}]*\} from "\.\.\/db\/schema"/);
  assert.match(LIB, /\.from\(tokenPackages\)/);
  assert.doesNotMatch(SCHEMA, /coin_packages|coinPackages/);
});

test("no migration is added for coin purchases (the schema is sufficient)", () => {
  const migrations = fs
    .readdirSync("src/db/migrations")
    .filter((name) => name.endsWith(".sql"));
  const suspects = migrations.filter((name) =>
    /coin_(purchase|shop|package)|package_purchase/i.test(name),
  );
  assert.deepEqual(suspects, [], "no coin-purchase migration should exist");
});

// ── 3. Package validation ──────────────────────────────────────────────────

test("a well-formed enabled row is valid", () => {
  assert.deepEqual(validateCoinPackage(baseRow()), { ok: true });
  assert.deepEqual(validateCoinPackage(baseRow({ bonusTokens: 3000 })), { ok: true });
});

test("invalid rows are rejected with a reason, never coerced", () => {
  const cases = [
    [{ key: "" }, "missing key"],
    [{ name: "   " }, "missing name"],
    [{ enabled: false }, "not enabled"],
    [{ tokenAmount: 0 }, "coin amount must be a positive integer"],
    [{ tokenAmount: -5000 }, "coin amount must be a positive integer"],
    [{ tokenAmount: 12.5 }, "coin amount must be a positive integer"],
    [{ bonusTokens: -1 }, "bonus coins must be a non-negative integer"],
    [{ bonusTokens: 1.5 }, "bonus coins must be a non-negative integer"],
    // The `own` row's placeholder price (migration 0117) must never be sold.
    [{ priceCents: 0 }, "price must be a positive integer number of cents"],
    [{ priceCents: -499 }, "price must be a positive integer number of cents"],
    [{ priceCents: 4.99 }, "price must be a positive integer number of cents"],
  ];

  for (const [overrides, reason] of cases) {
    const result = validateCoinPackage(baseRow(overrides));
    assert.equal(result.ok, false, `expected ${JSON.stringify(overrides)} to be invalid`);
    assert.equal(result.reason, reason);
  }
});

// ── 4. Offer selection is server-authoritative ─────────────────────────────

const LADDER_ROWS = [
  baseRow({ key: "starter", name: "Starter", tokenAmount: 5000, bonusTokens: 0, priceCents: 499, sortOrder: 1 }),
  baseRow({ key: "small", name: "Small", tokenAmount: 10000, bonusTokens: 750, priceCents: 999, sortOrder: 2 }),
  baseRow({ key: "medium", name: "Medium", tokenAmount: 20000, bonusTokens: 3000, priceCents: 1999, sortOrder: 3 }),
  baseRow({ key: "large", name: "Large", tokenAmount: 40000, bonusTokens: 10000, priceCents: 3999, sortOrder: 4, badge: "Most popular" }),
  baseRow({ key: "mega", name: "Mega", tokenAmount: 90000, bonusTokens: 40000, priceCents: 9999, sortOrder: 5 }),
  baseRow({ key: "own", name: "Grynd Tokens", tokenAmount: 5000, priceCents: 0, sortOrder: 0 }),
];

test("only the three launch keys are offered, in catalog order", () => {
  const { offers, skipped } = selectInitialCoinOffers(LADDER_ROWS);
  assert.deepEqual(offers.map((offer) => offer.key), ["starter", "medium", "large"]);
  assert.deepEqual(
    skipped.map((row) => row.key).sort(),
    ["mega", "own", "small"],
    "rows outside the launch ladder are reported, never offered",
  );
});

test("amounts, bonuses, totals and prices come from the rows unchanged", () => {
  const { offers } = selectInitialCoinOffers(LADDER_ROWS);
  const medium = offers.find((offer) => offer.key === "medium");

  assert.equal(medium.coins, 20000);
  assert.equal(medium.bonusCoins, 3000);
  assert.equal(medium.totalCoins, 23000);
  assert.equal(medium.priceCents, 1999);
});

test("the displayed price is the charged amount in the charge currency", () => {
  const { offers } = selectInitialCoinOffers(LADDER_ROWS);

  for (const offer of offers) {
    assert.equal(offer.currency, COIN_PACKAGE_CURRENCY);
    // Same cents, same currency, one formatter: "$19.99" for 1999 USD cents.
    assert.equal(offer.priceDisplay, `$${(offer.priceCents / 100).toFixed(2)}`);
  }

  // The display currency and the currency packages.ts creates prices in are
  // ONE constant — they cannot drift apart.
  assert.equal(PACKAGE_CURRENCY, COIN_PACKAGE_CURRENCY);
  assert.equal(PACKAGE_CURRENCY, "usd");
  assert.equal((PACKAGES.match(/currency: PACKAGE_CURRENCY/g) ?? []).length, 2);
  assert.doesNotMatch(PACKAGES, /currency: "usd"/, "packages.ts must use the shared constant");
});

test("a disabled, malformed or duplicated row never reaches the shop", () => {
  const rows = [
    baseRow({ key: "starter" }),
    baseRow({ key: "starter", priceCents: 100 }), // duplicate key
    baseRow({ key: "medium", enabled: false }),
    baseRow({ key: "large", priceCents: 0 }),
  ];
  const { offers, skipped } = selectInitialCoinOffers(rows);

  assert.deepEqual(offers.map((offer) => offer.key), ["starter"]);
  assert.equal(offers[0].priceCents, 499, "the first valid row wins");
  assert.equal(skipped.length, 3);
});

test("the resolver accepts no client input", () => {
  const source = stripComments(read("src/lib/coinPurchases.ts"));
  const signatures = source.match(/export function \w+\([^)]*\)/g) ?? [];

  for (const signature of signatures) {
    assert.doesNotMatch(
      signature,
      /req|request|body|client|payload/i,
      `no resolver may take request data: ${signature}`,
    );
  }
  assert.doesNotMatch(source, /creditUserBalance|tokenTransactions|users\.balance/);
});

// ── 5. The public API cannot start a purchase ──────────────────────────────

test("the catalog route is read-only and gated by the flag before any read", () => {
  assert.match(ROUTE, /export async function GET\(/);
  assert.doesNotMatch(ROUTE, /export async function POST\(/);

  // No payment machinery at all: no Stripe client, no session, no price write.
  assert.doesNotMatch(ROUTE, /checkout\.sessions\.create/);
  assert.doesNotMatch(ROUTE, /getStripe|createBrandedCheckoutSession/);
  assert.doesNotMatch(ROUTE, /ensurePackageStripe|stripe\.prices\.create/);
  assert.doesNotMatch(ROUTE, /creditUserBalance|tokenTransactions/);

  // The gate comes first: disabled → empty offers, before the catalog read.
  const gateIndex = ROUTE.indexOf("isCoinPurchasesEnabled()");
  const readIndex = ROUTE.indexOf("resolveInitialCoinOffers()");
  assert.ok(gateIndex > 0, "the route must check the flag");
  assert.ok(readIndex > gateIndex, "the flag check must run before any DB read");
  assert.match(ROUTE, /enabled: false,/);
  assert.match(ROUTE, /offers: \[\],/);
});

test("a disabled deployment answers with no offers and no checkout", async () => {
  const { GET } = await import("../src/app/api/coins/packages/route.ts");
  const original = process.env.COIN_PURCHASES_ENABLED;
  delete process.env.COIN_PURCHASES_ENABLED;
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.checkoutReady, false);
    assert.deepEqual(body.offers, []);
  } finally {
    if (original === undefined) delete process.env.COIN_PURCHASES_ENABLED;
    else process.env.COIN_PURCHASES_ENABLED = original;
  }
});

test("the catalog reports the single readiness constant", () => {
  assert.equal(typeof COIN_CHECKOUT_READY, "boolean");
  assert.match(ROUTE, /checkoutReady: COIN_CHECKOUT_READY/);
});

test("the retired one-time Stripe routes stay gone; coins own their own path", () => {
  // The historical Shop/package endpoints must not come back — their removal is
  // pinned by tests/upgrade-pro-contract.test.mjs.
  for (const path of [
    "src/app/api/stripe/checkout/route.ts",
    "src/app/api/stripe/packages/route.ts",
  ]) {
    assert.equal(fs.existsSync(path), false, `${path} must stay removed`);
  }
  // The coin purchase lives in its own namespace, created by this feature.
  assert.equal(fs.existsSync("src/app/api/coins/checkout/route.ts"), true);
});

// ── 6. The UI offers no active purchase action ────────────────────────────

test("the offers component renders nothing when disabled or unresolved", () => {
  assert.match(
    COMPONENT,
    /const showOffers = Boolean\(catalog\?\.enabled && catalog\.offers\.length > 0\)/,
  );
  assert.match(COMPONENT, /if \(!showOffers && confirmState === "idle"\) return null;/);
});

test("the purchase action exists only behind the server readiness gate", () => {
  // The buy/sign-in action markup is conditional on the SERVER's flag; a
  // disabled deployment renders no action at all.
  assert.match(COMPONENT, /\{catalog\.checkoutReady && isLoaded \? \(/);
  assert.match(
    COMPONENT,
    /data-checkout-ready=\{catalog\?\.checkoutReady \? "true" : "false"\}/,
  );
  // Never a direct Stripe call from the browser, and never a client price.
  assert.doesNotMatch(COMPONENT, /checkout\.sessions/);
  assert.doesNotMatch(COMPONENT, /stripe\.com\/v1/);
  assert.doesNotMatch(COMPONENT, /body: JSON\.stringify\(\{[^}]*price/);
});

test("the component renders the server-resolved price verbatim", () => {
  assert.match(COMPONENT, /\{offer\.priceDisplay\}/);
  assert.doesNotMatch(COMPONENT, /\/ 100/, "the client must not convert cents");
  assert.doesNotMatch(COMPONENT, /"\$\{/, "the client must not re-symbolise a price");
  assert.match(COMPONENT, /fetch\("\/api\/coins\/packages", \{ cache: "no-store" \}\)/);
});

test("the offers copy resolves in every supported language", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");
  const keys = ["title", "lead", "total", "bonus", "soon", "cash"];

  for (const lang of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = t(lang, `coins.${key}`);
      assert.ok(
        typeof value === "string" && value.length > 0 && value !== `coins.${key}`,
        `${lang} is missing coins.${key}`,
      );
    }
  }
  assert.match(t("en", "coins.total"), /\{amount\}/);
});

test("free rewards and quests are untouched by the coin shop", () => {
  assert.match(REWARDS, /<DailyRewardCard \/>/);
  assert.match(REWARDS, /<QuestBoard \/>/);
  assert.match(REWARDS, /<CoinShopOffers \/>/);

  // The rewards page itself still owns no button, fetch or price.
  const code = REWARDS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /<button/);
  assert.doesNotMatch(code, /onClick/);
  assert.doesNotMatch(code, /fetch\(/);
});
