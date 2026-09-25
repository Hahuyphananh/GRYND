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

/** What the client renders for the single GRYND PRO plan. */
export type ProPlanDisplay = {
  /** Canonical plan key — `grynd-pro`. */
  key: string;
  /** Display name from the catalog — `GRYND PRO`. */
  name: string;
  /** Authoritative monthly price in cents (Stripe-bound price wins). */
  priceCents: number;
  /** Pre-formatted USD price, e.g. "9.99". */
  priceUsd: string;
  badge: string | null;
  /** Perk lines from the catalog, in display order. */
  perks: string[];
};

/**
 * The four headline PRO perks, in the order the upgrade surface presents them.
 * Used only as a fallback when the catalog perks are missing/empty — the
 * database row (migration 0168) is the real source.
 */
export const PRO_PLAN_FALLBACK_PERKS = [
  "Ad-free experience",
  "Advanced statistics",
  "Advanced performance analytics",
  "Detailed match history",
] as const;

/** Perks that are advertised but shown as secondary, smaller lines. */
export const PRO_PLAN_SECONDARY_PERKS = [
  "Custom chat color & profile accent",
  "Priority support",
] as const;

/** `999` → `"9.99"`. Kept in one place so every surface formats identically. */
export function formatUsdFromCents(priceCents: number): string {
  const cents = Number.isFinite(priceCents) ? Math.max(0, priceCents) : 0;
  return (cents / 100).toFixed(2);
}

/** The intended GRYND PRO plan key (mirrors CANONICAL_MEMBERSHIP_PLAN_KEY). */
export const PRO_PLAN_KEY = "grynd-pro";

/** Public upgrade landing page — the single canonical membership URL. */
export const UPGRADE_PRO_PATH = "/upgrade-pro";
