// src/lib/stripe/packages.ts
//
// Keeps `token_packages` backed by real Stripe Products + one-time Prices and
// persists their ids (stripe_product_id / stripe_price_id) on the row.
//
//   * ensurePackageStripe(bundle) — lazily creates a Product and one-time Price
//     for one package (idempotent: already-persisted resources are reused, and
//     price REPLACEMENTS are handled safely below). Used by checkout on first
//     purchase / on price mismatch so every sale is a real Stripe price.
//   * syncAllTokenPackagesToStripe() — ensures every enabled package; used by
//     the admin sync route to precreate prices without waiting for a sale.
//
// Prices are one-time (`recurring` omitted) because Grynd tokens are one-time
// top-ups — not subscriptions. The client is never consulted for the amount;
// the price and token award both resolve from the catalog/server here.
//
// PRICE REPLACEMENT RULES (Stripe audit rule 2):
//   * The catalog `price_cents` is the single source of truth for what we
//     SELL. If the persisted `stripe_price_id` no longer matches it (e.g. the
//     Mega pack moved $89.99 → $99.99), we CREATE a new Price at the target
//     amount and persist its id. We NEVER edit a Price in place, never
//     deactivate the old one, and never reuse a mismatched stale price.
//     Historical invoices keep pointing at whatever they were charged with.

import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { tokenPackages } from "../../db/schema";
import { getStripe } from "../stripe";

/**
 * Product tax code eligible for Managed Payments (`txcd_10103100` — SaaS,
 * electronic download, personal use). Managed Payments (merchant of record)
 * is enabled for Grynd's one-time checkout and requires every product to use
 * an eligible tax code; the generic `txcd_99999999` e-services code is not
 * eligible and makes Managed Payments checkout fail.
 */
export const MANAGED_PAYMENTS_TAX_CODE = "txcd_10103100";

export type PackagePriceBundle = {
  id: number;
  key: string;
  name: string;
  priceCents: number;
  stripeProductId: string | null;
  stripePriceId: string | null;
};

/**
 * Rich product descriptions shown in Stripe (product page + checkout). Keyed
 * by package key so the auto-created products carry real sales copy instead of
 * a one-line disclaimer. Falls back to the generic line for unknown keys.
 * Values mirror the 0156 rebalance ladder (base + bonus = total).
 */
const PACKAGE_DESCRIPTIONS: Record<string, string> = {
  starter:
    "5,000 Grynd Tokens — the perfect way to start playing on GRYND. Use tokens to join any game: Blackjack, Mines, Plinko, Roulette, Crash Arena, Slots, Coin Flip and more. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  small:
    "10,750 Grynd Tokens (10,000 + 750 bonus). A step up for regular players: jump into higher-stakes tables and PvP lobbies across Blackjack, Plinko, Mines, Roulette, Crash Arena, Slots and more. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  medium:
    "23,000 Grynd Tokens (20,000 + 3,000 bonus — 15% extra value). Built for active players who want a bigger bankroll for tournaments, streaks and high-stakes PvP across all GRYND games. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  large:
    "50,000 Grynd Tokens (40,000 + 10,000 bonus — 25% extra value). The most popular pack. A serious bankroll for grinding the leaderboard, chasing daily streaks and playing every game GRYND offers at the stakes you want. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  mega:
    "130,000 Grynd Tokens (90,000 + 40,000 bonus — 44% extra value). The best value pack on GRYND: the largest token top-up at the best price per token. For high rollers and long-term players who live on the leaderboard. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
};

export function getPackageDescription(key: string): string {
  return (
    PACKAGE_DESCRIPTIONS[key] ??
    "Virtual tokens for GRYND. No cash value; non-refundable."
  );
}

/**
 * Find the active one-time Price on `productId` whose unit_amount exactly
 * equals `targetCents` (the amount we want to SELL for). Returns null when no
 * such price exists yet — never falls back to a differently-priced active
 * price. A strict match is required so a stale price (old Mega $89.99) can
 * never be sold against the catalog's $99.99.
 */
async function findMatchingOneTimePrice(
  productId: string,
  targetCents: number
): Promise<string | null> {
  const prices = await getStripe().prices.list({
    product: productId,
    type: "one_time",
    active: true,
    limit: 100,
  });
  for (const price of prices.data) {
    if (price.unit_amount === targetCents) return price.id;
  }
  return null;
}

/**
 * Resolve the one-time Price id that SHOULD be used for a package sale,
 * creating it when needed. Guarantees the returned price charges exactly
 * `targetCents`. Never edits/deactivates the previously-persisted price, so
 * historical invoices stay intact (Stripe audit rule 2).
 */
async function resolveActivePriceId(
  productId: string,
  targetCents: number,
  packageKey: string
): Promise<string> {
  const matching = await findMatchingOneTimePrice(productId, targetCents);
  if (matching) return matching;

  // No active price at the target amount — create one.
  const price = await getStripe().prices.create({
    unit_amount: targetCents,
    currency: "usd",
    product: productId,
    metadata: { packageKey, rebalanced: "true" },
  });
  return price.id;
}

/**
 * Guarantee the package has a Stripe Product + one-time Price that charges the
 * catalog's current `priceCents`, creating what's missing and persisting the
 * resulting ids back onto `token_packages`. Returns the resolved product/price
 * ids. Idempotent per field — already-set ids are reused when they still match
 * the catalog; a persisted price that no longer matches the catalog amount is
 * REPLACED with a new correctly-priced Price (the old one is never edited or
 * deactivated, so purchase history remains intact).
 */
export async function ensurePackageStripe(
  pkg: PackagePriceBundle
): Promise<{ productId: string; priceId: string }> {
  const stripe = getStripe();

  let productId = pkg.stripeProductId;
  let priceId: string | null = null;
  let changed = false;

  if (productId) {
    // Reusing an existing product. Bindings can go stale (e.g. created under
    // test keys, then switched to live keys — the ids no longer resolve). If
    // the product is unreachable, clear the doomed binding and fall through to
    // creating a fresh product + price below, so the live switch self-heals
    // instead of failing. Otherwise reconcile the tax code to the Managed
    // Payments-eligible code (pre-MSP products were created with the
    // ineligible `txcd_99999999` and would make Managed Payments checkout 400).
    try {
      await stripe.products.retrieve(productId);
      try {
        await stripe.products.update(productId, {
          tax_code: MANAGED_PAYMENTS_TAX_CODE,
        });
      } catch {
        // Non-fatal: the price resolution below still works / later retries.
      }
    } catch {
      productId = null;
      changed = true;
    }
  }

  if (!productId) {
    // Managed Payments (merchant of record — on by default on this account)
    // requires every product to carry a tax code eligible for Managed Payments.
    // `txcd_10103100` (SaaS — electronic download, personal use) is eligible;
    // the general e-services code `txcd_99999999` is not and made one-time
    // checkout 400. The product and its default one-time price are created in
    // one call via `default_price_data`; the returned `default_price` becomes
    // the session's price id (blueprint: Managed Payments settings).
    const product = await stripe.products.create({
      name: `${pkg.name} — Grynd Tokens`,
      description: getPackageDescription(pkg.key),
      tax_code: MANAGED_PAYMENTS_TAX_CODE,
      default_price_data: {
        unit_amount: pkg.priceCents,
        currency: "usd",
      },
      metadata: { packageKey: pkg.key },
    });
    productId = product.id;
    if (typeof product.default_price === "string") {
      priceId = product.default_price;
    }
    changed = true;
  }

  // Decide the price id to sell at. Reuse the persisted price ONLY when it is
  // still a live (active, resolves) price charging exactly the catalog amount.
  // Otherwise find-or-create a price at the catalog amount.
  const persistedStillMatches = !!priceId || !pkg.stripePriceId ? false : await stripe.prices
    .retrieve(pkg.stripePriceId)
    .then((p) => p.unit_amount === pkg.priceCents)
    .catch(() => false);

  if (priceId) {
    // A brand-new product's default_price always charges pkg.priceCents, so it
    // is already the canonical price — nothing more to resolve.
  } else if (persistedStillMatches) {
    priceId = pkg.stripePriceId!;
  } else {
    const resolved = await resolveActivePriceId(productId, pkg.priceCents, pkg.key);
    if (resolved !== pkg.stripePriceId) changed = true;
    priceId = resolved;
  }

  if (changed || priceId !== pkg.stripePriceId) {
    await db
      .update(tokenPackages)
      .set({ stripeProductId: productId, stripePriceId: priceId, updatedAt: new Date() })
      .where(eq(tokenPackages.id, pkg.id));
  }

  return { productId, priceId };
}

/**
 * Resolve the authoritative display price (in cents) for a package. The
 * persisted `stripePriceId` is the exact price we sell — when it resolves, its
 * unit amount wins; on any Stripe failure it falls back to the catalog's stored
 * `priceCents` so the Shop always renders. (A stale persisted price would only
 * survive here if it matched the catalog amount; replacements are persisted
 * with a fresh id by ensurePackageStripe.)
 */
export async function resolvePackagePriceCents(pkg: PackagePriceBundle): Promise<number> {
  if (pkg.stripePriceId) {
    try {
      const price = await getStripe().prices.retrieve(pkg.stripePriceId);
      if (typeof price.unit_amount === "number") {
        return price.unit_amount;
      }
    } catch {
      // fall through to the stored price
    }
  }
  return pkg.priceCents ?? 0;
}

/** Ensure a real Stripe Product + Price exists for every enabled package. */
export async function syncAllTokenPackagesToStripe(): Promise<{
  count: number;
  results: Record<string, { productId: string; priceId: string }>;
}> {
  const rows = await db
    .select({
      id: tokenPackages.id,
      key: tokenPackages.key,
      name: tokenPackages.name,
      priceCents: tokenPackages.priceCents,
      stripeProductId: tokenPackages.stripeProductId,
      stripePriceId: tokenPackages.stripePriceId,
    })
    .from(tokenPackages)
    .where(eq(tokenPackages.enabled, true));

  const results: Record<string, { productId: string; priceId: string }> = {};
  for (const row of rows) {
    results[row.key] = await ensurePackageStripe(row);
  }
  return { count: rows.length, results };
}