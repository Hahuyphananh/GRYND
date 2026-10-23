/**
 * coin-shop-ui.test.mjs
 *
 * Guards the coin-purchase section on /rewards (`CoinShopOffers`) and the pure
 * client helpers it uses.
 *
 * The interactive component needs Clerk + a live API, so — as elsewhere in this
 * repo — the STATES are pinned from source and the decision logic (return
 * parsing, redirect allow-listing, poll ceiling) is exercised for real.
 *
 * Covered:
 *   * signed-out users get a sign-in path, never a checkout call,
 *   * the feature-flag-disabled surface renders nothing / no action,
 *   * a failed checkout shows an error and redirects nowhere,
 *   * a pending payment keeps polling and is never reported as success,
 *   * success is shown only from a server `fulfilled` answer,
 *   * the balance is refreshed through the shared event, never optimistically,
 *   * the virtual-currency copy is present and makes no compliance claim.
 *
 * Run: node --import tsx --test tests/coin-shop-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  COIN_CHECKOUT_MAX_POLLS,
  COIN_CHECKOUT_POLL_INTERVAL_MS,
  isTrustedStripeUrl,
  parseCheckoutReturn,
  shouldPollCheckout,
} from "../src/lib/coinCheckoutClient.ts";
import {
  COIN_OFFER_TIERS,
  selectInitialCoinOffers,
} from "../src/lib/coinPurchases.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const UI = read("src/components/CoinShopOffers.tsx");
const UI_CODE = stripComments(UI);
const PAGE = read("src/app/rewards/PageClient.tsx");
const PAGE_CODE = stripComments(PAGE);
const TRANSLATIONS = read("src/lib/appTextTranslations.js");

// ── 1. Return-URL parsing ──────────────────────────────────────────────────

test("a success return yields the Checkout Session id", () => {
  assert.deepEqual(parseCheckoutReturn("?checkout=success&session_id=cs_test_a1B2c3"), {
    returned: true,
    cancelled: false,
    sessionId: "cs_test_a1B2c3",
  });
});

test("a cancel return never starts confirmation", () => {
  const parsed = parseCheckoutReturn("?checkout=cancelled");
  assert.equal(parsed.returned, true);
  assert.equal(parsed.cancelled, true);
  assert.equal(parsed.sessionId, null);
});

test("unrelated or malformed returns are ignored", () => {
  for (const search of ["", "?", "?foo=bar", "?checkout=success", "?checkout=success&session_id=nope"]) {
    const parsed = parseCheckoutReturn(search);
    if (search.includes("checkout=success")) {
      assert.equal(parsed.returned, true, `${search} is a return`);
      assert.equal(parsed.sessionId, null, `${search} must not yield a pollable id`);
    } else {
      assert.equal(parsed.returned, false, `${search} is not a return`);
    }
  }
});

// ── 2. Redirect allow-list ─────────────────────────────────────────────────

test("only https Stripe hosts are followed", () => {
  for (const url of [
    "https://checkout.stripe.com/c/pay/cs_test_123",
    "https://stripe.com/checkout",
    "https://pay.stripe.com/x",
  ]) {
    assert.equal(isTrustedStripeUrl(url), true, `${url} should be trusted`);
  }

  for (const url of [
    undefined,
    null,
    "",
    "http://checkout.stripe.com/c/pay/cs_test_123",
    "https://checkout.stripe.com.evil.example/pay",
    "https://evil-stripe.com/pay",
    "https://stripe.com.evil.example",
    "javascript:alert(1)",
    "//checkout.stripe.com/pay",
    "/relative",
    42,
  ]) {
    assert.equal(isTrustedStripeUrl(url), false, `${String(url)} must be refused`);
  }
});

// ── 3. Poll ceiling ────────────────────────────────────────────────────────

test("polling stops on fulfilment and after the ceiling", () => {
  assert.equal(shouldPollCheckout(1, false), true);
  assert.equal(shouldPollCheckout(COIN_CHECKOUT_MAX_POLLS - 1, false), true);
  assert.equal(shouldPollCheckout(COIN_CHECKOUT_MAX_POLLS, false), false);
  assert.equal(shouldPollCheckout(1, true), false);
  assert.ok(COIN_CHECKOUT_POLL_INTERVAL_MS >= 1000);
});

// ── 4. Server-resolved tiers and offers ────────────────────────────────────

test("the three tiers are server-owned and match the launch keys", () => {
  assert.deepEqual(COIN_OFFER_TIERS, {
    starter: "Starter",
    medium: "Standard",
    large: "Value",
  });
});

test("offers carry the server-resolved tier with the catalog amounts", () => {
  const row = (overrides) => ({
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

  const { offers } = selectInitialCoinOffers([
    row({}),
    row({ key: "medium", name: "Medium", tokenAmount: 20000, bonusTokens: 3000, priceCents: 1999, sortOrder: 3 }),
    row({ key: "large", name: "Large", tokenAmount: 40000, bonusTokens: 10000, priceCents: 3999, sortOrder: 4 }),
  ]);

  assert.deepEqual(
    offers.map((offer) => [offer.key, offer.tier, offer.totalCoins, offer.priceDisplay]),
    [
      ["starter", "Starter", 5000, "$4.99"],
      ["medium", "Standard", 23000, "$19.99"],
      ["large", "Value", 50000, "$39.99"],
    ],
  );
});

// ── 5. Disabled / no-catalog UI ────────────────────────────────────────────

test("a disabled shop renders no surface and no action", () => {
  assert.match(
    UI_CODE,
    /if \(!showOffers && confirmState === "idle"\) return null;/,
  );
  assert.match(UI_CODE, /const showOffers = Boolean\(catalog\?\.enabled/);
  // The action markup only exists when the SERVER says checkout is ready.
  assert.match(UI_CODE, /\{catalog\.checkoutReady && isLoaded \? \(/);
  assert.match(UI_CODE, /t\("coins\.soon"\)/);
  assert.doesNotMatch(UI_CODE, /<button[^>]*disabled=\{false\}/);
});

// ── 6. Signed-out users ────────────────────────────────────────────────────

test("a signed-out visitor sees a sign-in path, not a checkout call", () => {
  // The signed-out action is the sign-in link itself.
  const linkStart = UI_CODE.indexOf("<Link");
  const linkBlock = UI_CODE.slice(linkStart, UI_CODE.indexOf("</Link>", linkStart));

  assert.match(UI_CODE, /isSignedIn \? \(/);
  assert.match(linkBlock, /href="\/sign-in\?redirect_url=\/rewards"/);
  assert.match(linkBlock, /t\("coins\.signin"\)/);
  assert.ok(
    !linkBlock.includes("startCheckout"),
    "the signed-out action must not expose a checkout call",
  );
});

// ── 7. Starting Checkout ───────────────────────────────────────────────────

test("the client sends only the package key to the authenticated endpoint", () => {
  assert.match(UI_CODE, /fetch\("\/api\/coins\/checkout", \{/);
  assert.match(UI_CODE, /method: "POST"/);
  assert.match(UI_CODE, /body: JSON\.stringify\(\{ packageKey \}\)/);
  assert.match(UI_CODE, /credentials: "include"/);
  // No amount, price or currency may be sent.
  assert.doesNotMatch(UI_CODE, /body: JSON\.stringify\(\{[^}]*price/);
  assert.doesNotMatch(UI_CODE, /body: JSON\.stringify\(\{[^}]*amount/);
  assert.doesNotMatch(UI_CODE, /body: JSON\.stringify\(\{[^}]*currency/);
});

test("the redirect follows only the validated server URL", () => {
  assert.match(
    UI_CODE,
    /!res\.ok \|\| !data\?\.success \|\| !isTrustedStripeUrl\(data\.url\)/,
  );
  assert.match(UI_CODE, /window\.location\.assign\(data\.url\)/);

  const guardIndex = UI_CODE.indexOf("isTrustedStripeUrl(data.url)");
  const assignIndex = UI_CODE.indexOf("window.location.assign(data.url)");
  assert.ok(guardIndex > 0 && assignIndex > guardIndex, "assign must follow the guard");
});

test("a failed checkout shows an error and redirects nowhere", () => {
  const failureBranch = UI_CODE.slice(
    UI_CODE.indexOf("if (!res.ok || !data?.success || !isTrustedStripeUrl(data.url))"),
    UI_CODE.indexOf("window.location.assign(data.url)"),
  );
  assert.match(failureBranch, /setCheckoutError\(true\)/);
  assert.match(failureBranch, /setStartingKey\(null\)/);
  assert.match(failureBranch, /return;/);
  assert.ok(
    !failureBranch.includes("location.assign"),
    "the failure branch must not navigate",
  );
  assert.match(UI_CODE, /data-testid="coin-checkout-error"/);
  assert.match(UI_CODE, /role="alert"/);
});

test("a start in progress disables the other buttons", () => {
  assert.match(UI_CODE, /disabled=\{startingKey !== null\}/);
  assert.match(UI_CODE, /aria-busy=\{busy\}/);
  assert.match(UI_CODE, /t\("coins\.buying"\)/);
});

// ── 8. Return, polling and success ─────────────────────────────────────────

test("the return state polls the server-owned session status", () => {
  assert.match(UI_CODE, /parseCheckoutReturn\(window\.location\.search\)/);
  assert.match(
    UI_CODE,
    /fetch\(\s*`\/api\/stripe\/session-status\?session_id=\$\{encodeURIComponent\(sessionId\)\}`/,
  );
  assert.match(UI_CODE, /cache: "no-store"/);
  assert.match(UI_CODE, /shouldPollCheckout\(attempts, false\)/);
});

test("success is displayed only from a server fulfilled answer", () => {
  assert.match(UI_CODE, /if \(data\?\.success && data\?\.fulfilled\) \{/);
  const successIndex = UI_CODE.indexOf("if (data?.success && data?.fulfilled)");
  const confirmedIndex = UI_CODE.indexOf('setConfirmState("confirmed")');
  assert.ok(confirmedIndex > successIndex, "confirmed must sit inside the fulfilled branch");

  // Before fulfilment the page says it is confirming, never "confirmed".
  assert.match(UI_CODE, /data-testid="coin-purchase-confirming"/);
  assert.match(UI_CODE, /confirmState === "confirmed" \?/);
  assert.match(UI_CODE, /confirmState === "polling" \?/);
});

test("a payment that is not confirmed yet stays pending, with a retry", () => {
  const pendingBranch = UI_CODE.slice(
    UI_CODE.indexOf('setConfirmState("pending")'),
    UI_CODE.indexOf("}, [sessionId, pollKey])"),
  );
  assert.ok(pendingBranch.length > 0);
  assert.match(UI_CODE, /data-testid="coin-purchase-pending"/);
  assert.match(UI_CODE, /data-testid="coin-purchase-retry"/);
  assert.match(UI_CODE, /setPollKey\(\(key\) => key \+ 1\)/);
  assert.match(UI_CODE, /t\("coins\.pending"\)/);
});

// ── 9. Balance refresh, never optimistic ───────────────────────────────────

test("the balance is re-read through the shared hook after fulfilment", () => {
  assert.match(
    UI,
    /import \{ notifyCoinBalanceChanged \} from "\.\.\/hooks\/useCoinBalance"/,
  );
  const fulfilBranch = UI_CODE.slice(
    UI_CODE.indexOf("if (data?.success && data?.fulfilled)"),
    UI_CODE.indexOf("if (cancelled || fulfilled) return;"),
  );
  assert.match(fulfilBranch, /notifyCoinBalanceChanged\(\)/);
});

test("the browser never adds coins itself", () => {
  for (const forbidden of [
    "setBalance",
    "balance +",
    "balance:",
    "totalCoins +",
    "state.balance",
  ]) {
    assert.ok(
      !UI_CODE.includes(forbidden),
      `the shop UI must not mutate a balance (${forbidden})`,
    );
  }
  assert.doesNotMatch(UI_CODE, /localStorage|sessionStorage/);
});

// ── 10. Copy: virtual coins, no compliance claims ──────────────────────────

test("the section states that coins are virtual and non-redeemable", () => {
  assert.match(UI_CODE, /t\("coins\.cash"\)/);

  const english = TRANSLATIONS.slice(0, TRANSLATIONS.indexOf("  fr: {"));
  assert.match(english, /coins\.|cash:/);
  assert.match(english, /no cash value/);
  assert.match(english, /cannot be withdrawn/);
  assert.match(english, /gift cards/);
  assert.match(english, /only inside GRYND/);
});

test("no claim of legal or platform compliance is made", () => {
  for (const word of [
    "legally compliant",
    "compliant",
    "licen[cs]ed",
    "regulated",
    "guaranteed",
    "sweepstakes",
    "no risk",
    "cash out",
    "withdraw your coins",
  ]) {
    assert.ok(
      !new RegExp(word, "i").test(UI_CODE),
      `the UI must not claim "${word}"`,
    );
  }
});

test("the shop never offers gift cards or redemption", () => {
  assert.doesNotMatch(UI_CODE, /gift card|redeem|payout|cash out/i);
});

// ── 11. Page preservation ──────────────────────────────────────────────────

test("rewards, quests and navigation stay on the page", () => {
  for (const retained of [
    "<DailyRewardCard />",
    "<QuestBoard />",
    "<NavigationBar currentPath=\"/rewards\" />",
    "<Footer />",
    "<CoinShopOffers />",
  ]) {
    assert.ok(PAGE.includes(retained), `${retained} must remain on /rewards`);
  }
  // The page itself still owns no button/click/fetch — the shop's controls live
  // in its own component.
  assert.doesNotMatch(PAGE_CODE, /<button/);
  assert.doesNotMatch(PAGE_CODE, /onClick/);
  assert.doesNotMatch(PAGE_CODE, /fetch\(/);
});

test("the offers grid stays responsive and keyboard accessible", () => {
  assert.match(UI_CODE, /sm:grid-cols-3/);
  assert.match(UI_CODE, /focus-visible:ring-2/);
  assert.match(UI_CODE, /aria-labelledby=/);
  assert.match(UI_CODE, /role="status"/);
});
