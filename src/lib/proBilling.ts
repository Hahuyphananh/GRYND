// src/lib/proBilling.ts
//
// The GRYND PRO billing catalog — a monthly subscription and a yearly one.
//
// WHY THIS FILE EXISTS: the upgrade surface must show the prices and their
// savings, and the savings must be DERIVED, not typed into a component as
// marketing copy. This module owns the approved amounts, the annualised maths
// and the savings calculations, and it has NO server imports (no DB, no Stripe
// SDK), so both the server resolver and the client components can read it.
//
// It is deliberately NOT the price authority. The authoritative price for a
// recurring option is the bound Stripe Price, resolved server-side by
// `src/lib/stripe/subscriptions.ts` and handed to the client as
// `ProPlanDisplay.billingOptions`. These constants are (a) the approved catalog
// amounts used when Stripe is unreachable and (b) the input to the checkout
// price sync. Savings are always computed from whichever amounts are in play,
// never hardcoded.
//
// ── The founder rate ─────────────────────────────────────────────────────
//
// The catalog is the EARLY SUPPORTER / FOUNDER rate: half the intended public
// price, offered while the site is small. The weekly option was retired in the
// same change — a weekly cadence is the most expensive way to pay for a
// membership and the least useful to an indie project — leaving two honest
// options: monthly for flexibility, yearly for the better rate.
//
// ── The currency ──────────────────────────────────────────────────────────
//
// The catalog amounts are CAD (the base currency — lib/currency.ts). The
// upgrade surface may present a different currency when BOTH are true: the
// visitor's country maps to it, and the bound Stripe Price carries an amount
// for it in `currency_options`. An unconfigured currency must never be shown,
// or the page would advertise a number Stripe would not charge.
//
// All amounts are BEFORE applicable taxes. Both options grant EXACTLY the same
// membership.

import {
  BASE_CURRENCY,
  formatAmount,
  currencySymbol,
  type PresentmentCurrency,
} from "./currency";

/** The recurring billing options. Order here is display order. */
export const PRO_BILLING_INTERVALS = ["monthly", "yearly"] as const;

export type ProBillingInterval = (typeof PRO_BILLING_INTERVALS)[number];

/** Every GRYND PRO price is defined in the base currency: CAD. */
export const PRO_BILLING_CURRENCY = BASE_CURRENCY;

/**
 * Approved FOUNDER RATE amounts (cents), before tax, in the BASE currency (CAD).
 *
 *   monthly CA$4.99 every month  (public price will be CA$9.99)
 *   yearly  CA$29.99 every year  (≈ CA$2.50/month)
 */
export const PRO_PRICE_CENTS: Record<ProBillingInterval, number> = {
  monthly: 499,
  yearly: 2999,
};

/** The Stripe recurring interval each subscription option maps to. */
export const PRO_STRIPE_INTERVAL: Record<ProBillingInterval, "month" | "year"> = {
  monthly: "month",
  yearly: "year",
};

/** Months per year used to annualise the monthly option. */
export const MONTHS_PER_YEAR = 12;

export function isProBillingInterval(value: unknown): value is ProBillingInterval {
  return (
    typeof value === "string" &&
    (PRO_BILLING_INTERVALS as readonly string[]).includes(value)
  );
}

/** The approved recurring amount, or the monthly amount as a last resort. */
export function defaultPriceCentsFor(interval: ProBillingInterval): number {
  return PRO_PRICE_CENTS[interval] ?? PRO_PRICE_CENTS.monthly;
}

/**
 * `499` → `"4.99"`. Two decimal places, always; currency-agnostic on purpose.
 */
export function formatAmountCents(cents: number): string {
  return formatAmount(cents);
}

/** Standard rounding to two decimals (for percentages). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * What one year of a recurring option costs, annualised from its own billing
 * period: monthly × 12, yearly × 1. This is the ONLY basis for savings, so
 * every comparison is like-for-like and clearly labelled.
 */
export function annualCostCents(
  interval: ProBillingInterval,
  amounts?: Partial<Record<ProBillingInterval, number>>,
): number {
  const price = amounts?.[interval] ?? defaultPriceCentsFor(interval);
  return interval === "monthly" ? price * MONTHS_PER_YEAR : price;
}

/** Average monthly cost of the yearly option, rounded to the cent ($2.50). */
export function monthlyEquivalentCents(
  yearlyCents: number = PRO_PRICE_CENTS.yearly,
): number {
  return Math.round(yearlyCents / MONTHS_PER_YEAR);
}

/** One "you save X% ($Y/yr)" comparison against a more expensive option. */
export type ProBillingSaving = {
  versus: ProBillingInterval;
  amountCents: number;
  percent: number;
};

/**
 * The savings to advertise for a recurring option, computed from annualised
 * costs. Monthly is the most flexible (and most expensive) option, so it
 * "saves" nothing; yearly is only ever compared against monthly.
 */
export function savingsFor(
  interval: ProBillingInterval,
  amounts?: Partial<Record<ProBillingInterval, number>>,
): ProBillingSaving[] {
  if (interval === "monthly") return [];

  const ownAnnual = annualCostCents(interval, amounts);
  return (["monthly"] as ProBillingInterval[])
    .map((other) => {
      const otherAnnual = annualCostCents(other, amounts);
      const amountCents = Math.max(0, otherAnnual - ownAnnual);
      const percent =
        otherAnnual > 0 ? round2((amountCents / otherAnnual) * 100) : 0;
      return { versus: other, amountCents, percent };
    })
    .filter((saving) => saving.amountCents > 0);
}

/** One fully-resolved recurring billing option, ready to render. */
export type ProBillingOption = {
  interval: ProBillingInterval;
  /** Catalog key of the membership every option grants. */
  planKey: string;
  /** Amount Stripe will charge per period, in cents, in `currency`. */
  priceCents: number;
  currency: PresentmentCurrency;
  currencySymbol: string;
  priceFormatted: string;
  /** Symbol + amount, e.g. "CA$4.99" — what the card is charged, as written. */
  priceDisplay: string;
  /** `"BEST VALUE"` on the yearly option, otherwise null. */
  badge: string | null;
  /** Average monthly cost, only meaningful for the yearly option. */
  monthlyEquivalentCents: number | null;
  savings: ProBillingSaving[];
};

/** The single membership key every option sells. */
export const PRO_MEMBERSHIP_KEY = "grynd-pro";

/**
 * Build the recurring display options from a set of amounts, all expressed in
 * ONE currency. Callers pass the server-resolved (Stripe-bound) amounts when
 * they have them; anything missing falls back to the approved catalog amount.
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
    monthlyEquivalentCents:
      interval === "yearly" ? monthlyEquivalentCents(yearlyCents) : null,
    savings: savingsFor(interval, amounts),
  }));
}

/** The catalog defaults, for a cold read or a client-only render. */
export const PRO_BILLING_OPTIONS: ProBillingOption[] = buildProBillingOptions();
