// src/lib/proBilling.ts
//
// The GRYND PRO billing catalog — THREE recurring options for ONE membership.
//
// WHY THIS FILE EXISTS: the upgrade surface must show three prices and their
// savings, and the savings must be DERIVED, not typed into a component as
// marketing copy. This module owns the approved amounts, the annualised maths
// and the savings calculations, and it has NO server imports (no DB, no Stripe
// SDK), so both the server resolver and the client components can read it.
//
// It is deliberately NOT the price authority. The authoritative price for a
// given interval is the bound Stripe Price, resolved server-side by
// `src/lib/stripe/subscriptions.ts` and handed to the client as
// `ProPlanDisplay.billingOptions`. These constants are (a) the approved catalog
// amounts used when Stripe is unreachable and (b) the input to the checkout
// price sync. Savings are always computed from whichever amounts are in play,
// never hardcoded, so a catalog/Stripe change can never leave the page
// advertising a stale "you save X".
//
// ── The currency ──────────────────────────────────────────────────────────
//
// The catalog amounts are CAD (the base currency — lib/currency.ts). The
// upgrade surface may present a different currency when BOTH are true: the
// visitor's country maps to it, and the bound Stripe Price carries an amount
// for it in `currency_options`. That second condition is not a detail — an
// unconfigured currency must never be shown, or the page would advertise a
// number Stripe would not charge. Both the country→currency map and the
// formatters live in lib/currency.ts; this module only carries the currency a
// set of amounts is expressed in.
//
// All amounts are BEFORE applicable taxes. All three options grant EXACTLY the
// same membership — billing frequency never changes entitlements.

import {
  BASE_CURRENCY,
  formatAmount,
  currencySymbol,
  type PresentmentCurrency,
} from "./currency";

/** The three billing options. Order here is display order. */
export const PRO_BILLING_INTERVALS = ["weekly", "monthly", "yearly"] as const;

export type ProBillingInterval = (typeof PRO_BILLING_INTERVALS)[number];

/** Every GRYND PRO price is defined in the base currency: CAD. */
export const PRO_BILLING_CURRENCY = BASE_CURRENCY;

/**
 * Approved catalog amounts (cents), before tax, in the BASE currency (CAD).
 *
 *   weekly  CA$3.49 every week
 *   monthly CA$9.99 every month  (the pre-existing monthly price — preserved)
 *   yearly  CA$59.99 every year
 */
export const PRO_PRICE_CENTS: Record<ProBillingInterval, number> = {
  weekly: 349,
  monthly: 999,
  yearly: 5999,
};

/** The Stripe recurring interval each option maps to. */
export const PRO_STRIPE_INTERVAL: Record<
  ProBillingInterval,
  "week" | "month" | "year"
> = {
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** Weeks per year used to annualise the weekly option. */
export const WEEKS_PER_YEAR = 52;
/** Months per year used to annualise the monthly option. */
export const MONTHS_PER_YEAR = 12;

export function isProBillingInterval(value: unknown): value is ProBillingInterval {
  return (
    typeof value === "string" &&
    (PRO_BILLING_INTERVALS as readonly string[]).includes(value)
  );
}

/** The approved amount for an interval, or the monthly amount as a last resort. */
export function defaultPriceCentsFor(interval: ProBillingInterval): number {
  return PRO_PRICE_CENTS[interval] ?? PRO_PRICE_CENTS.monthly;
}

/**
 * `349` → `"3.49"`. Two decimal places, always.
 *
 * This is the bare NUMBER — currency-agnostic on purpose, so the same helper
 * formats a CAD saving, a EUR saving or a total. It is re-exported from
 * lib/currency so every surface formats identically (and so a component never
 * reaches for `Intl`, whose output differs between the server and the browser).
 */
export function formatAmountCents(cents: number): string {
  return formatAmount(cents);
}

/** Standard rounding to two decimals (for percentages). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * What one year of an option costs, annualised from its own billing period:
 * weekly × 52, monthly × 12, yearly × 1. This is the ONLY basis for savings,
 * so every comparison is like-for-like and clearly labelled.
 */
export function annualCostCents(interval: ProBillingInterval, amounts?: Partial<Record<ProBillingInterval, number>>): number {
  const price = amounts?.[interval] ?? defaultPriceCentsFor(interval);
  if (interval === "weekly") return price * WEEKS_PER_YEAR;
  if (interval === "monthly") return price * MONTHS_PER_YEAR;
  return price;
}

/** Average monthly cost of the yearly option, rounded to the cent ($5.00). */
export function monthlyEquivalentCents(
  yearlyCents: number = PRO_PRICE_CENTS.yearly,
): number {
  return Math.round(yearlyCents / MONTHS_PER_YEAR);
}

/** One "you save X% ($Y/yr)" comparison against a more expensive option. */
export type ProBillingSaving = {
  /** The option this one is compared against. */
  versus: ProBillingInterval;
  /** Money saved per year, in cents. */
  amountCents: number;
  /** Percentage saved per year, rounded to two decimals. */
  percent: number;
};

/**
 * The savings to advertise for an option, computed from annualised costs.
 *
 * WEEKLY DELIBERATELY HAS NONE: it is the most flexible (and most expensive)
 * option, so claiming it "saves" anything would be dishonest. Monthly is only
 * ever compared against weekly, and yearly against both.
 */
export function savingsFor(
  interval: ProBillingInterval,
  amounts?: Partial<Record<ProBillingInterval, number>>,
): ProBillingSaving[] {
  if (interval === "weekly") return [];

  const ownAnnual = annualCostCents(interval, amounts);
  const versus: ProBillingInterval[] =
    interval === "monthly" ? ["weekly"] : ["monthly", "weekly"];

  return versus
    .map((other) => {
      const otherAnnual = annualCostCents(other, amounts);
      const amountCents = Math.max(0, otherAnnual - ownAnnual);
      const percent =
        otherAnnual > 0 ? round2((amountCents / otherAnnual) * 100) : 0;
      return { versus: other, amountCents, percent };
    })
    .filter((saving) => saving.amountCents > 0);
}

/** One fully-resolved billing option, ready to render. */
export type ProBillingOption = {
  interval: ProBillingInterval;
  /** Catalog key of the membership all three options grant. */
  planKey: string;
  /** Amount Stripe will charge per period, in cents, in `currency`. */
  priceCents: number;
  /** The currency the amounts below are expressed in (base unless localized). */
  currency: PresentmentCurrency;
  /** That currency's symbol, e.g. `"CA$"` / `"€"`. */
  currencySymbol: string;
  /** Pre-formatted amount, e.g. "3.49" (digits only). */
  priceFormatted: string;
  /** Symbol + amount, e.g. "CA$3.49" — what the card is charged, as written. */
  priceDisplay: string;
  /** `"BEST VALUE"` on the yearly option, otherwise null. */
  badge: string | null;
  /** Average monthly cost, only meaningful for the yearly option. */
  monthlyEquivalentCents: number | null;
  /** Derived savings comparisons (empty for the weekly option). */
  savings: ProBillingSaving[];
};

/** The single membership key all three billing options sell. */
export const PRO_MEMBERSHIP_KEY = "grynd-pro";

/**
 * Build the three display options from a set of amounts, all expressed in ONE
 * currency. Callers pass the server-resolved (Stripe-bound) amounts when they
 * have them; anything missing falls back to the approved catalog amount (which
 * is a BASE-currency amount, so callers only pass a non-base currency when
 * every amount they pass came from that currency — see
 * resolveProBillingAmountsForCurrency in lib/stripe/subscriptions.ts).
 * Everything derived — the formatted prices, the yearly monthly-equivalent and
 * every savings figure — is computed here from those amounts.
 */
export function buildProBillingOptions(
  amounts?: Partial<Record<ProBillingInterval, number>>,
  currency: PresentmentCurrency = BASE_CURRENCY,
): ProBillingOption[] {
  const priceFor = (interval: ProBillingInterval) =>
    amounts?.[interval] ?? defaultPriceCentsFor(interval);

  const yearlyCents = priceFor("yearly");
  const symbol = currencySymbol(currency);

  return PRO_BILLING_INTERVALS.map((interval) => ({
    interval,
    planKey: PRO_MEMBERSHIP_KEY,
    priceCents: priceFor(interval),
    currency,
    currencySymbol: symbol,
    priceFormatted: formatAmount(priceFor(interval)),
    priceDisplay: `${symbol}${formatAmount(priceFor(interval))}`,
    badge: interval === "yearly" ? "BEST VALUE" : null,
    // Only the yearly option advertises a monthly equivalent (it is the only
    // one billed less often than monthly).
    monthlyEquivalentCents:
      interval === "yearly" ? monthlyEquivalentCents(yearlyCents) : null,
    savings: savingsFor(interval, amounts),
  }));
}

/** The catalog defaults, for a cold read or a client-only render. */
export const PRO_BILLING_OPTIONS: ProBillingOption[] = buildProBillingOptions();
