// src/lib/currency.ts
//
// Which currency a visitor sees, and how an amount in it is written.
//
// WHY THIS FILE EXISTS: GRYND bills GRYND PRO in CAD (the base currency — see
// proBilling.ts), but a visitor in the eurozone, the UK, the US or Australia
// should be shown the price in the currency their card will actually be charged
// in. Two things decide that:
//
//   1. COUNTRY → CURRENCY. The visitor's country comes from the request geo
//      headers (see lib/consentRegions.ts `countryFromHeaders`, the same
//      server-side source the consent banner uses). It is NEVER taken from a
//      client-supplied value, so a visitor cannot shop a cheaper currency.
//
//   2. THE AMOUNT ITSELF. This module does NOT convert anything and does not
//      know any exchange rate. The amount for a presentment currency is
//      whatever is configured on the Stripe Price's `currency_options` (set by
//      the operator in the Stripe Dashboard, where Stripe offers its own
//      conversion). A currency without a configured amount is never displayed —
//      the base currency is shown instead — so the page can never advertise a
//      number Stripe would not charge (see resolveProBillingAmountsForCurrency
//      in lib/stripe/subscriptions.ts).
//
// FORMATTING IS DELIBERATELY NOT `Intl.NumberFormat`. Prices are rendered by
// client components, and `Intl` output depends on the ICU data of whatever
// runtime produced it (Node server vs. browser), which would make the
// server-rendered HTML and the hydrated client disagree. These formatters are
// plain string arithmetic, so the same cents always produce the same string on
// both sides.
//
// No server imports here: client components read this module too.

/** The currency GRYND's prices are defined in. */
export const BASE_CURRENCY = "cad";

/**
 * The currencies the upgrade surface may present. `cad` is the base; the rest
 * only ever appear when the visitor's country maps to them AND the Stripe price
 * carries a configured amount for them.
 */
export const PRESENTMENT_CURRENCIES = ["cad", "usd", "eur", "gbp", "aud"] as const;

export type PresentmentCurrency = (typeof PRESENTMENT_CURRENCIES)[number];

/**
 * Eurozone members, i.e. the countries whose currency is EUR. Anything not in
 * this set (or one of the countries below) resolves to the base currency.
 */
const EUROZONE_COUNTRIES = [
  "AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES",
] as const;

/** Countries that use a non-EUR currency we support. */
const COUNTRY_CURRENCY: Record<string, PresentmentCurrency> = {
  ...Object.fromEntries(EUROZONE_COUNTRIES.map((code) => [code, "eur"] as const)),
  US: "usd",
  GB: "gbp",
  AU: "aud",
  CA: BASE_CURRENCY,
};

/**
 * The currency to present to a visitor in `country` (an ISO 3166-1 alpha-2
 * code from the request headers). Every unsupported, unknown or missing country
 * — and every country that is not one of the four above — falls back to the
 * base currency, so a visitor is never shown a currency we did not choose.
 */
export function currencyForCountry(country: string | null | undefined): PresentmentCurrency {
  const code = String(country ?? "").trim().toUpperCase();
  return COUNTRY_CURRENCY[code] ?? BASE_CURRENCY;
}

export function isPresentmentCurrency(value: unknown): value is PresentmentCurrency {
  return (
    typeof value === "string" &&
    (PRESENTMENT_CURRENCIES as readonly string[]).includes(value)
  );
}

/**
 * How each supported currency is written in front of an amount. `CA$` and `A$`
 * are spelled out because a bare `$` would be ambiguous between three of the
 * five currencies, and the amount has to be unambiguous: it is what the
 * customer's card is charged.
 */
const CURRENCY_SYMBOL: Record<PresentmentCurrency, string> = {
  cad: "CA$",
  usd: "$",
  eur: "€",
  gbp: "£",
  aud: "A$",
};

export function currencySymbol(currency: string): string {
  return isPresentmentCurrency(currency)
    ? CURRENCY_SYMBOL[currency]
    : CURRENCY_SYMBOL[BASE_CURRENCY];
}

/** `999` → `"9.99"`. Two decimals, always; never a grouping separator. */
export function formatAmount(cents: number): string {
  const value = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  return (value / 100).toFixed(2);
}

/**
 * `999` + `"cad"` → `"CA$9.99"`. The one way an amount is written on the
 * upgrade surfaces: symbol from the currency, digits from the cents.
 */
export function formatMoney(cents: number, currency: string): string {
  return `${currencySymbol(currency)}${formatAmount(cents)}`;
}
