// src/lib/membershipDisplay.ts
//
// Client-safe GRYND PRO display data.
//
// WHY THIS FILE EXISTS SEPARATELY: the authoritative plan (name, price, perks)
// lives in the database + Stripe and is resolved server-side by
// `getProPlanDisplay()` in lib/stripe/subscriptions.ts. Client components must
// never import that module (it pulls in the DB client and the Stripe SDK), but
// they DO need the shape and the fallback copy. So the type and the constants
// live here — a module with no server imports at all — and the server helper
// fills them in.
//
// THE PRICE IS NEVER DEFINED HERE. It is passed down from the server (the
// plan catalog / the bound Stripe price), so there is exactly one source of
// truth and no component can drift from what Stripe actually charges.

import { PRO_BILLING_OPTIONS, type ProBillingOption } from "./proBilling";
import {
  BASE_CURRENCY,
  formatAmount,
  type PresentmentCurrency,
} from "./currency";
import { ADVERTISED_PRO_PERKS } from "./proBenefits";

/** What the client renders for the single GRYND PRO plan. */
export type ProPlanDisplay = {
  /** Canonical plan key — `grynd-pro`. */
  key: string;
  /** Display name from the catalog — `GRYND PRO`. */
  name: string;
  /**
   * Authoritative MONTHLY price in cents (Stripe-bound price wins), expressed
   * in `currency`. Kept as the headline number for every surface that predates
   * the three-interval catalog — it always equals the monthly entry of
   * `billingOptions`.
   */
  priceCents: number;
  /** The currency the monthly price above is expressed in. */
  currency: PresentmentCurrency;
  /**
   * The monthly price as written, symbol included — e.g. "CA$9.99" or "€9.99".
   * Digits are always Western with two decimals (see lib/currency).
   */
  priceDisplay: string;
  badge: string | null;
  /** Perk lines from the catalog, in display order. */
  perks: string[];
  /**
   * The THREE billing options (weekly / monthly / yearly), already resolved to
   * authoritative amounts with their formatted prices and DERIVED savings. The
   * upgrade surface renders these and never re-derives a price or a saving.
   */
  billingOptions: ProBillingOption[];
};

/** The catalog defaults for the three options, for a cold or client-only render. */
export const FALLBACK_BILLING_OPTIONS: ProBillingOption[] = PRO_BILLING_OPTIONS;

/**
 * The PRO perk lines used when the catalog's `perks` are missing or empty.
 *
 * DERIVED from the approved benefit catalog (lib/proBenefits.ts) and limited to
 * the benefits that actually exist today — this list is also what the
 * membership widget renders and what a cold/failed plan read falls back to, so
 * it can never advertise a benefit the membership does not yet grant. The
 * database row is the real source for the API payload; migration 0215 keeps it
 * in step with the same catalog.
 */
export const PRO_PLAN_FALLBACK_PERKS = ADVERTISED_PRO_PERKS;

/**
 * `999` → `"9.99"`.
 *
 * Kept as a named export for the server resolver, but the implementation (and
 * the only place formatting is defined) is lib/currency — so a price rendered
 * on the server and re-rendered on the client can never differ.
 */
export function formatAmountFromCents(priceCents: number): string {
  return formatAmount(priceCents);
}

/** The base currency every catalog amount is defined in. */
export const DEFAULT_PLAN_CURRENCY = BASE_CURRENCY;

/** The intended GRYND PRO plan key (mirrors CANONICAL_MEMBERSHIP_PLAN_KEY). */
export const PRO_PLAN_KEY = "grynd-pro";

/** Public upgrade landing page — the single canonical membership URL. */
export const UPGRADE_PRO_PATH = "/upgrade-pro";
