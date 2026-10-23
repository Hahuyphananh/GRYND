/**
 * coin-checkout.test.mjs
 *
 * Guards `POST /api/coins/checkout` (one-time Stripe Checkout Session creation
 * for coin packages). No live Stripe call and no database write happens here:
 * the session BUILDER is pure and is exercised directly, and the route's
 * ordering/prohibitions are pinned from source (the same approach as
 * tests/upgrade-pro-contract.test.mjs, which this repository uses wherever an
 * endpoint needs Clerk + a real Stripe account).
 *
 * The contract:
 *   1. authenticated caller only; the user id comes from the session,
 *   2. the client sends ONE field — `packageKey` — and anything else (amount,
 *      price id, currency, redirect) is rejected,
 *   3. the price id is server-resolved and must be a `price_…` id; a
 *      product id, a client string or a relative origin throws instead of
 *      creating a session,
 *   4. the ledger row records the VERIFIED charge and the catalog coin award,
 *      and is written before the redirect is returned,
 *   5. retries within the idempotency window reuse one Stripe key; a different
 *      user/package/window gets a different one,
 *   6. nothing credits coins from this endpoint,
 *   7. both stopping gates (feature flag, fulfilment readiness) are server-side.
 *
 * Run: node --import tsx --test tests/coin-checkout.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS,
  COIN_CHECKOUT_READY,
  buildCoinCheckoutSession,
  coinCheckoutIdempotencyKey,
} from "../src/lib/coinPurchases.ts";
import { createBrandedCheckoutSession } from "../src/lib/stripe/checkoutBranding.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = read("src/app/api/coins/checkout/route.ts");
const ROUTE_CODE = stripComments(ROUTE);
const SUBSCRIBE = read("src/app/api/stripe/subscribe/route.ts");
const BRANDING = read("src/lib/stripe/checkoutBranding.ts");

const PKG = {
  id: 3,
  key: "medium",
  name: "Medium",
  tokenAmount: 20000,
  bonusTokens: 3000,
  totalCoins: 23000,
  priceCents: 1999,
  stripeProductId: "prod_test_medium",
  stripePriceId: "price_test_medium",
  oneTime: false,
};

const INPUT = {
  clerkId: "user_2abcdef123",
  pkg: PKG,
  priceId: "price_test_medium",
  charge: { currency: "usd", amountCents: 1999 },
  baseUrl: "https://grynd.dedyn.io",
  now: 1_700_000_000_000,
};

// ── 1. The built session is server-authoritative ───────────────────────────

test("the session is a one-time payment for ONE server-resolved price", () => {
  const { params } = buildCoinCheckoutSession(INPUT);

  assert.equal(params.mode, "payment");
  assert.deepEqual(params.line_items, [{ price: "price_test_medium", quantity: 1 }]);
  assert.equal(params.client_reference_id, "user_2abcdef123");
  assert.deepEqual(params.metadata, {
    clerkId: "user_2abcdef123",
    packageKey: "medium",
    coins: "23000",
  });
  assert.deepEqual(params.payment_intent_data?.metadata, {
    clerkId: "user_2abcdef123",
    packageKey: "medium",
  });
});

test("no client amount, currency or redirect can enter the session", () => {
  const { params } = buildCoinCheckoutSession({
    ...INPUT,
    // Anything extra the caller might try to smuggle in is ignored: the
    // builder only reads the documented fields. (A `priceId` IS a documented
    // field, which is why the route — not this function — is the gate that
    // guarantees it came from `ensurePackageStripe`: the body schema accepts
    // no price field at all.)
    amount: 1,
    currency: "btc",
    successUrl: "https://evil.example",
    price: "price_attacker",
  });

  assert.deepEqual(params.line_items, [{ price: "price_test_medium", quantity: 1 }]);
  assert.equal(params.success_url, "https://grynd.dedyn.io/rewards?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(params.cancel_url, "https://grynd.dedyn.io/rewards?checkout=cancelled");
  assert.equal(params.allow_promotion_codes, undefined);
  assert.equal(params.line_items?.[0]?.price, "price_test_medium");
});

test("the ledger records the verified charge and the catalog award", () => {
  const { ledger } = buildCoinCheckoutSession(INPUT);

  assert.deepEqual(ledger, {
    clerkId: "user_2abcdef123",
    packageKey: "medium",
    sessionMode: "payment",
    tokenAmount: 23000,
    amountCents: 1999,
    currency: "usd",
    paymentStatus: "open",
    fulfilled: false,
  });
});

test("a price id that was not resolved server-side is refused", () => {
  for (const priceId of ["", "prod_test_medium", "1999", "medium"]) {
    assert.throws(
      () => buildCoinCheckoutSession({ ...INPUT, priceId }),
      /server-resolved Stripe price id/,
      `${JSON.stringify(priceId)} must not create a session`,
    );
  }
  // The only id the route can pass is the one `ensurePackageStripe` returned —
  // there is no body field that could supply a different one (see the body
  // schema test below).
});

test("a relative or empty origin is refused", () => {
  for (const baseUrl of ["", "/rewards", "grynd.dedyn.io"]) {
    assert.throws(
      () => buildCoinCheckoutSession({ ...INPUT, baseUrl }),
      /absolute base URL/,
    );
  }
});

test("an unverified / non-integer charge is refused", () => {
  for (const charge of [
    { currency: "usd", amountCents: 0 },
    { currency: "usd", amountCents: -1999 },
    { currency: "usd", amountCents: 19.99 },
    { currency: "", amountCents: 1999 },
  ]) {
    assert.throws(() => buildCoinCheckoutSession({ ...INPUT, charge }), /verified charge/);
  }
});

test("a missing user id is refused", () => {
  assert.throws(() => buildCoinCheckoutSession({ ...INPUT, clerkId: "" }), /clerkId/);
});

// ── 2. Idempotency ─────────────────────────────────────────────────────────

// A window-aligned instant, so the boundary maths below is explicit rather
// than dependent on where `Date.now()` happens to fall.
const WINDOW_START =
  Math.floor(1_700_000_000_000 / COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS) *
  COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS;

test("retries inside the window reuse the same Stripe idempotency key", () => {
  const a = coinCheckoutIdempotencyKey("user_1", "medium", WINDOW_START + 1);
  const b = coinCheckoutIdempotencyKey(
    "user_1",
    "medium",
    WINDOW_START + COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS - 1,
  );
  assert.equal(a, b);
  assert.match(a, /^grynd_coins_[0-9a-f]{48}$/);
  assert.ok(!a.includes("user_1"), "the key must not carry the clerk id");
});

test("a different user, package or window gets a different key", () => {
  const base = coinCheckoutIdempotencyKey("user_1", "medium", WINDOW_START + 1);
  const later = coinCheckoutIdempotencyKey(
    "user_1",
    "medium",
    WINDOW_START + COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS,
  );
  const otherUser = coinCheckoutIdempotencyKey("user_2", "medium", WINDOW_START + 1);
  const otherPack = coinCheckoutIdempotencyKey("user_1", "starter", WINDOW_START + 1);

  assert.notEqual(base, later);
  assert.notEqual(base, otherUser);
  assert.notEqual(base, otherPack);
});

// ── 3. The route's gates and ordering ──────────────────────────────────────

test("the caller must be authenticated before anything else", () => {
  assert.match(ROUTE_CODE, /const \{ userId \} = await auth\(\);/);
  assert.match(ROUTE_CODE, /if \(!userId\)/);
  assert.match(ROUTE_CODE, /status: 401/);

  const authIndex = ROUTE_CODE.indexOf("await auth()");
  const flagIndex = ROUTE_CODE.indexOf("isCoinPurchasesEnabled()");
  assert.ok(authIndex > 0 && flagIndex > authIndex, "auth must run before the flag");
});

test("both server-side gates stop the endpoint", () => {
  assert.match(ROUTE_CODE, /if \(!isCoinPurchasesEnabled\(\)\)/);
  assert.match(ROUTE_CODE, /status: 404/);
  assert.match(ROUTE_CODE, /if \(!COIN_CHECKOUT_READY\)/);
  assert.match(ROUTE_CODE, /status: 503/);
  // The gate is a single boolean constant (now true for the launched shop);
  // what must stay pinned is that the route obeys it, not which way it points.
  assert.equal(typeof COIN_CHECKOUT_READY, "boolean", "a single switch decides launch");

  // The flag check is before the rate limit and the body read, so a disabled
  // deployment does nothing at all.
  assert.ok(
    ROUTE_CODE.indexOf("isCoinPurchasesEnabled()") <
      ROUTE_CODE.indexOf("consumeRateLimit("),
  );
});

test("the endpoint is rate limited per authenticated user", () => {
  assert.match(ROUTE_CODE, /consumeRateLimit\(`coins:checkout:\$\{userId\}`/);
  assert.match(ROUTE_CODE, /status: 429/);
});

test("the body accepts exactly one field: packageKey", () => {
  const schema = ROUTE_CODE.slice(
    ROUTE_CODE.indexOf("parseAndValidateJson("),
    ROUTE_CODE.indexOf("if (!parsed.ok)"),
  );
  assert.match(schema, /packageKey: \{/);
  for (const forbidden of ["amount", "price", "priceId", "coins", "currency", "url"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}: \\{`).test(schema),
      `the body schema must not accept ${forbidden}`,
    );
  }
});

test("the package, price and charge are all resolved server-side", () => {
  assert.match(ROUTE_CODE, /resolveCoinCheckoutPackage\(packageKey\)/);
  assert.match(ROUTE_CODE, /status: 404/); // unknown / disabled / unavailable
  assert.match(ROUTE_CODE, /ensurePackageStripe\(/);
  assert.match(ROUTE_CODE, /verifyPackagePrice\(priceId, \{/);
  assert.match(ROUTE_CODE, /amountCents: pkg\.priceCents/);
  assert.match(ROUTE_CODE, /currency: PACKAGE_CURRENCY/);

  // A verified-price failure refuses the sale.
  assert.match(ROUTE_CODE, /if \(!verified\.ok\)/);
  assert.match(ROUTE_CODE, /status: 503/);

  // Return URLs come from the trusted resolver, not from input.
  assert.match(ROUTE_CODE, /getReturnBaseUrl\(request\)/);
  assert.doesNotMatch(ROUTE_CODE, /success_url: (parsed|body|request)/);
});

test("the one-time restriction is enforced from the fulfilled ledger", () => {
  assert.match(ROUTE_CODE, /if \(pkg\.oneTime && \(await hasFulfilledPackagePurchase\(userId, pkg\.key\)\)\)/);
  assert.match(ROUTE_CODE, /status: 409/);
});

test("the branded helper carries the idempotency key and the coin page name", () => {
  assert.match(ROUTE_CODE, /createBrandedCheckoutSession\(/);
  assert.match(ROUTE_CODE, /requestOptions: \{ idempotencyKey: plan\.idempotencyKey \}/);
  assert.match(ROUTE_CODE, /displayName: "GRYND Coins"/);

  // The helper forwards those request options on every attempt, including the
  // two unbranded fallbacks — a branding rejection must not lose idempotency.
  assert.equal((BRANDING.match(/requestOptions/g) ?? []).length >= 4, true);
  assert.match(BRANDING, /getCheckoutBranding\(baseUrl, options\?\.displayName\)/);
});

test("the ledger row is persisted before the redirect is returned", () => {
  const insertIndex = ROUTE_CODE.indexOf("stripeCheckoutSessions)");
  const returnIndex = ROUTE_CODE.indexOf("return NextResponse.json({ success: true, url: session.url })");

  assert.ok(insertIndex > 0, "the route must write the ledger row");
  assert.ok(returnIndex > insertIndex, "the ledger write must precede the response");
  assert.match(ROUTE_CODE, /onConflictDoNothing\(\{ target: stripeCheckoutSessions\.sessionId \}\)/);
  assert.match(ROUTE_CODE, /\.\.\.plan\.ledger/);
});

test("nothing here credits coins or marks a purchase fulfilled", () => {
  for (const forbidden of [
    "creditUserBalance",
    "tokenTransactions",
    "users.balance",
    "fulfilled: true",
    "update(users)",
  ]) {
    assert.ok(
      !ROUTE_CODE.includes(forbidden),
      `/api/coins/checkout must not contain ${forbidden}`,
    );
  }
  // The ledger row is written as unfulfilled; only the webhook may flip it.
  assert.match(ROUTE_CODE, /fulfilled: false|plan\.ledger/);
});

test("the response carries only the Checkout URL", () => {
  assert.match(
    ROUTE_CODE,
    /return NextResponse\.json\(\{ success: true, url: session\.url \}\)/,
  );
  assert.doesNotMatch(ROUTE_CODE, /session\.id \}/);
});

test("the PRO subscription checkout is not touched", () => {
  assert.match(SUBSCRIBE, /mode: "subscription"/);
  assert.ok(
    !SUBSCRIBE.includes("coinPurchases") && !SUBSCRIBE.includes("/api/coins"),
    "the subscription route must not depend on the coin shop",
  );
});

// ── 4. Branded helper passthrough (behavioural, fake Stripe) ───────────────

test("createBrandedCheckoutSession forwards the idempotency key to Stripe", async () => {
  const calls = [];
  const fakeStripe = {
    checkout: {
      sessions: {
        create: async (params, options) => {
          calls.push({ params, options });
          return { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" };
        },
      },
    },
  };

  const session = await createBrandedCheckoutSession(
    fakeStripe,
    { mode: "payment", line_items: [{ price: "price_test_medium", quantity: 1 }] },
    "https://grynd.dedyn.io",
    { requestOptions: { idempotencyKey: "grynd_coins_test" }, displayName: "GRYND Coins" },
  );

  assert.equal(session.id, "cs_test_123");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { idempotencyKey: "grynd_coins_test" });
  assert.equal(calls[0].params.branding_settings.display_name, "GRYND Coins");
});
