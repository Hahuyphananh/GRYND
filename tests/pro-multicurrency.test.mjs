/**
 * pro-multicurrency.test.mjs
 *
 * GRYND PRO is priced in CAD and presented to a visitor in the currency their
 * country resolves to — but ONLY when the bound Stripe Price actually carries
 * an amount for that currency. Money is involved, so the rules are pinned:
 *
 *   1. Country → currency: a short, explicit map (eurozone → EUR, GB → GBP,
 *      US → USD, AU → AUD), and the BASE (CAD) for everything else — including
 *      European countries that do not use the euro. A visitor can never be
 *      shown a currency we did not choose.
 *   2. Formatting is deterministic and currency-agnostic of locale, because the
 *      same number is rendered on the server and re-rendered in the browser.
 *   3. Nothing CONVERTS money. Localized amounts are read from the Stripe
 *      Price's `currency_options`, and a PARTIALLY configured currency falls
 *      back to the base currency for all three options — never mixing two
 *      currencies inside one set of compared prices (the savings are derived
 *      from those comparisons).
 *   4. The checkout charges what the page showed: it passes a currency only
 *      when Stripe confirmed it, and records the currency it charged.
 *
 * Run: npm run test:multicurrency
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BASE_CURRENCY,
  PRESENTMENT_CURRENCIES,
  currencyForCountry,
  currencySymbol,
  formatAmount,
  formatMoney,
  isPresentmentCurrency,
} from "../src/lib/currency.ts";
import {
  PRO_BILLING_CURRENCY,
  PRO_PRICE_CENTS,
  buildProBillingOptions,
} from "../src/lib/proBilling.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:multicurrency";

// ── 1. Country → currency ───────────────────────────────────────────────────

test("the base currency is CAD and the catalog amounts are unchanged", () => {
  assert.equal(BASE_CURRENCY, "cad");
  assert.equal(PRO_BILLING_CURRENCY, BASE_CURRENCY);
  // The approved amounts: same numbers as before, now expressed in CAD.
  assert.deepEqual(PRO_PRICE_CENTS, { weekly: 349, monthly: 999, yearly: 5999 });
  assert.ok(PRESENTMENT_CURRENCIES.includes(BASE_CURRENCY));
});

test("each supported country resolves to its own currency", () => {
  assert.equal(currencyForCountry("CA"), "cad");
  assert.equal(currencyForCountry("US"), "usd");
  assert.equal(currencyForCountry("GB"), "gbp");
  assert.equal(currencyForCountry("AU"), "aud");
  for (const eurozone of ["FR", "DE", "ES", "IT", "NL", "IE", "PT", "GR", "FI", "AT"]) {
    assert.equal(currencyForCountry(eurozone), "eur", `${eurozone} uses the euro`);
  }
});

test("a European country outside the eurozone is NOT given EUR", () => {
  // A common bug in geo-pricing code is "in the EU → EUR". Half the EU does not
  // use the euro, and showing them EUR would misprice them.
  for (const notEuro of ["PL", "SE", "DK", "CZ", "HU", "RO", "BG"]) {
    assert.equal(
      currencyForCountry(notEuro),
      BASE_CURRENCY,
      `${notEuro} must fall back to the base currency`,
    );
  }
});

test("an unknown or missing country falls back to the base currency", () => {
  for (const unknown of ["JP", "BR", "IN", "ZZ", "", "  ", null, undefined, "not-a-country"]) {
    assert.equal(
      currencyForCountry(unknown),
      BASE_CURRENCY,
      `${String(unknown)} must fall back to the base currency`,
    );
  }
  // Case/whitespace insensitive, because header values arrive as-is.
  assert.equal(currencyForCountry(" us "), "usd");
  assert.equal(currencyForCountry("gb"), "gbp");
});

test("the currency guard only accepts currencies we support", () => {
  for (const good of PRESENTMENT_CURRENCIES) {
    assert.equal(isPresentmentCurrency(good), true);
  }
  // A currency Stripe may support but we have NOT configured an amount for must
  // never be treated as presentable.
  for (const bad of ["jpy", "brl", "inr", "us", "", null, undefined, 42, {}]) {
    assert.equal(isPresentmentCurrency(bad), false, `${String(bad)}`);
  }
});

// ── 2. Formatting ───────────────────────────────────────────────────────────

test("amounts are written the same way on the server and in the browser", () => {
  assert.equal(formatAmount(999), "9.99");
  assert.equal(formatAmount(349), "3.49");
  assert.equal(formatAmount(5999), "59.99");
  assert.equal(formatAmount(0), "0.00");
  // Defensive: a bad value is written as zero, never as "NaN" or a negative.
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, "abc", -500]) {
    assert.equal(formatAmount(bad), "0.00", `${String(bad)}`);
  }
  // No locale grouping: the string is produced identically by both runtimes.
  assert.equal(formatAmount(121490), "1214.90");
});

test("every supported currency has an unambiguous symbol", () => {
  assert.equal(formatMoney(999, "cad"), "CA$9.99");
  assert.equal(formatMoney(999, "usd"), "$9.99");
  assert.equal(formatMoney(999, "eur"), "€9.99");
  assert.equal(formatMoney(999, "gbp"), "£9.99");
  assert.equal(formatMoney(999, "aud"), "A$9.99");
  // The three dollar currencies must never render identically.
  const dollars = ["cad", "usd", "aud"].map((c) => currencySymbol(c));
  assert.equal(new Set(dollars).size, 3, "CAD, USD and AUD need distinct symbols");
  // An unsupported currency falls back to the base symbol rather than to "".
  assert.equal(formatMoney(999, "jpy"), "CA$9.99");
});

// ── 3. The options carry their currency ─────────────────────────────────────

test("the billing options are built in one currency, end to end", () => {
  const cad = buildProBillingOptions();
  for (const option of cad) {
    assert.equal(option.currency, "cad");
    assert.equal(option.priceDisplay, `CA$${option.priceFormatted}`);
  }
  assert.equal(cad.find((o) => o.interval === "monthly").priceDisplay, "CA$9.99");
  assert.equal(cad.find((o) => o.interval === "weekly").priceDisplay, "CA$3.49");
  assert.equal(cad.find((o) => o.interval === "yearly").priceDisplay, "CA$59.99");

  const eur = buildProBillingOptions(undefined, "eur");
  for (const option of eur) {
    assert.equal(option.currency, "eur");
    assert.equal(option.currencySymbol, "€");
    assert.equal(option.priceDisplay, `€${option.priceFormatted}`);
  }
  // The SAVINGS are derived from the same amounts, so they stay inside the
  // currency the options were built in.
  const yearly = eur.find((o) => o.interval === "yearly");
  assert.ok(yearly.savings.length > 0);
  const versusMonthly = yearly.savings.find((s) => s.versus === "monthly");
  assert.equal(versusMonthly.amountCents, 999 * 12 - 5999);
  assert.equal(
    formatMoney(versusMonthly.amountCents, yearly.currency),
    "€59.89",
  );
});

// ── 4. Localized amounts come from Stripe, and only whole ───────────────────

/** A fake Stripe whose three recurring prices carry `options` per currency. */
function fakeStripe(pricesById) {
  return {
    prices: {
      retrieve: async (id) => {
        const price = pricesById[id];
        if (!price) throw new Error(`No such price: ${id}`);
        return price;
      },
      list: async () => ({ data: [] }),
    },
  };
}

/** A bound plan whose three prices are exactly the ids given. */
const plan = {
  id: 1,
  key: "grynd-pro",
  name: "GRYND PRO",
  monthlyTokens: 0,
  priceCents: 999,
  stripeProductId: "prod_1",
  stripePriceId: "price_monthly",
  stripePriceIdWeekly: "price_weekly",
  stripePriceIdYearly: "price_yearly",
};

const basePrices = {
  price_weekly: { id: "price_weekly", currency: "cad", unit_amount: 349, recurring: { interval: "week" } },
  price_monthly: { id: "price_monthly", currency: "cad", unit_amount: 999, recurring: { interval: "month" } },
  price_yearly: { id: "price_yearly", currency: "cad", unit_amount: 5999, recurring: { interval: "year" } },
};

test("localized amounts are read from the price, and only whole sets are used", { skip: SKIP_REASON }, async (t) => {
  // ONE import of the resolver, driven through every branch — a module can only
  // be mocked once per process (the same constraint tests/ad-slot-gate.test.mjs
  // documents), so the Stripe catalog is a mutable WORLD the branches edit.
  const world = { prices: { ...basePrices } };
  t.mock.module("../src/lib/stripe.ts", {
    namedExports: { getStripe: () => fakeStripe(world.prices) },
  });

  const { resolveProBillingAmountsForCurrency, resolvePriceCharge } = await import(
    "../src/lib/stripe/subscriptions.ts"
  );

  // ── 1. Fully configured: every option has an amount for the currency ─────
  world.prices = {
    price_weekly: { ...basePrices.price_weekly, currency_options: { eur: { unit_amount: 249 } } },
    price_monthly: { ...basePrices.price_monthly, currency_options: { eur: { unit_amount: 699 } } },
    price_yearly: { ...basePrices.price_yearly, currency_options: { eur: { unit_amount: 4499 } } },
  };
  let resolved = await resolveProBillingAmountsForCurrency(plan, "eur");
  assert.equal(resolved.currency, "eur");
  assert.deepEqual(resolved.amounts, { weekly: 249, monthly: 699, yearly: 4499 });

  // ── 2. PARTIAL configuration falls back to the base for ALL options ──────
  // Only weekly + monthly carry a EUR amount. Nothing may be shown in EUR: the
  // savings compare the options against each other, so a mixed set would
  // advertise a saving between two different currencies.
  world.prices = {
    price_weekly: { ...basePrices.price_weekly, currency_options: { eur: { unit_amount: 249 } } },
    price_monthly: { ...basePrices.price_monthly, currency_options: { eur: { unit_amount: 699 } } },
    price_yearly: basePrices.price_yearly,
  };
  resolved = await resolveProBillingAmountsForCurrency(plan, "eur");
  assert.equal(resolved.currency, "cad", "a partial configuration must not localize");
  assert.deepEqual(resolved.amounts, { weekly: 349, monthly: 999, yearly: 5999 });

  // ── 3. The base amounts come from the bound prices, not the catalog ──────
  world.prices = {
    price_weekly: { ...basePrices.price_weekly, unit_amount: 400 },
    price_monthly: { ...basePrices.price_monthly, unit_amount: 1000 },
    price_yearly: { ...basePrices.price_yearly, unit_amount: 6000 },
  };
  resolved = await resolveProBillingAmountsForCurrency(plan, "cad");
  assert.equal(resolved.currency, "cad");
  assert.deepEqual(resolved.amounts, { weekly: 400, monthly: 1000, yearly: 6000 });

  // ── 4. What a specific price will actually charge ────────────────────────
  world.prices = {
    price_monthly: {
      ...basePrices.price_monthly,
      currency_options: { eur: { unit_amount: 699 }, gbp: { unit_amount: 599 } },
    },
  };
  // Configured → the localized amount, in that currency.
  assert.deepEqual(await resolvePriceCharge("price_monthly", "eur"), {
    currency: "eur",
    amountCents: 699,
  });
  assert.deepEqual(await resolvePriceCharge("price_monthly", "gbp"), {
    currency: "gbp",
    amountCents: 599,
  });
  // Not configured → the price's own currency and amount (what Checkout charges
  // when no currency is requested).
  assert.deepEqual(await resolvePriceCharge("price_monthly", "usd"), {
    currency: "cad",
    amountCents: 999,
  });
  assert.deepEqual(await resolvePriceCharge("price_monthly", "cad"), {
    currency: "cad",
    amountCents: 999,
  });
  // Unreadable price → null, so the caller falls back instead of guessing.
  assert.equal(await resolvePriceCharge("price_missing", "eur"), null);
});

// ── 5. The wired-up paths ───────────────────────────────────────────────────

test("the Stripe catalog is created in CAD, with localization left to the price", () => {
  const subscriptions = read("src/lib/stripe/subscriptions.ts");
  // The base currency of every created price — the spec the binding is
  // validated against — is the base currency constant, never a literal "usd".
  assert.match(subscriptions, /currency: BASE_CURRENCY/);
  assert.doesNotMatch(subscriptions, /currency: "usd"/);
  // Localized amounts are READ from the price, never converted here.
  assert.match(subscriptions, /price\?\.currency_options/);
  // No exchange-rate machinery: the only way an amount may change currency is
  // Stripe's own configuration. (Comments are stripped first — this file
  // explains the rule in prose.)
  const code = subscriptions
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/exchange_?rate|fx_?rate|convert_?currency|currency_?convert/i.test(code),
    "nothing may convert money in the price resolver",
  );
});

test("the visitor's country decides the presented currency, server-side only", () => {
  const statusRoute = read("src/app/api/membership/status/route.ts");
  const upgradePage = read("src/app/upgrade-pro/page.tsx");

  for (const [name, source] of [
    ["the membership status route", statusRoute],
    ["the upgrade page", upgradePage],
  ]) {
    assert.match(
      source,
      /currencyForCountry\(countryFromHeaders\(/,
      `${name} must resolve the currency from the request headers`,
    );
    assert.match(source, /getProPlanDisplay\(currency\)/, `${name} must pass it`);
    // The currency NEVER comes from the client.
    assert.ok(
      !/body\?\.currency|searchParams.*currency|req\.json\(\)[\s\S]{0,120}currency/.test(source),
      `${name} must not accept a client-supplied currency`,
    );
  }
});

test("checkout charges the presented currency, and only a verified one", () => {
  const subscribe = read("src/app/api/stripe/subscribe/route.ts");

  // Resolved from the request's geo headers, then verified against the bound
  // price before it is used.
  assert.match(subscribe, /currencyForCountry\(countryFromHeaders\(req\.headers\)\)/);
  assert.match(subscribe, /await resolvePriceCharge\(resolvedPriceId, desiredCurrency\)/);
  // The currency is passed to Checkout ONLY when it differs from the base — i.e.
  // only when Stripe confirmed an amount for it (resolvePriceCharge's contract).
  assert.match(
    subscribe,
    /\.\.\.\(charge && charge\.currency !== BASE_CURRENCY \? \{ currency: charge\.currency \} : \{\}\)/,
  );
  // The ledger row records what was charged, not a hardcoded currency.
  assert.match(subscribe, /const chargedCurrency = charge\?\.currency \?\? BASE_CURRENCY/);
  assert.match(subscribe, /currency: chargedCurrency/);
  assert.doesNotMatch(subscribe, /currency: "usd"/);
});

test("switching billing interval cannot leave the subscription's currency", () => {
  const changePlan = read("src/app/api/stripe/change-plan/route.ts");
  // A subscription's currency is fixed; the target price must be priced in it.
  assert.match(changePlan, /const subscriptionCurrency = String\(stripeSubscription\.currency/);
  assert.match(changePlan, /currency_options\?\.\[subscriptionCurrency\]/);
  assert.match(changePlan, /pricedInTargetCurrency/);
});
