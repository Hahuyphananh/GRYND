// src/lib/stripe/packages.ts
//
// Keeps `token_packages` backed by real Stripe Products + one-time Prices and
// persists their ids (stripe_product_id / stripe_price_id) on the row.
//
//   * ensurePackageStripe(bundle) — lazily creates a Product and one-time Price
//     for one package (idempotent: skips any resource already persisted). Used
//     by checkout on first purchase so every sale is a real Stripe price.
//   * syncAllTokenPackagesToStripe() — ensures every enabled package; used by
//     the admin sync route to precreate prices without waiting for a sale.
//
// Prices are one-time (`recurring` omitted) because Grynd tokens are one-time
// top-ups — not subscriptions. The client is never consulted for the amount;
// the price and token award both resolve from the catalog/server here.

import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { tokenPackages } from "../../db/schema";
import { getStripe } from "../stripe";

export type PackagePriceBundle = {
  id: number;
  key: string;
  name: string;
  priceCents: number;
  stripeProductId: string | null;
  stripePriceId: string | null;
};

/**
 * Guarantee the package has a Stripe Product + one-time Price, creating what's
 * missing and persisting the resulting ids back onto `token_packages`.
 * Returns the resolved product/price ids. Idempotent per field — already-set
 * ids are reused, never recreated on repeat calls.
 */
export async function ensurePackageStripe(
  pkg: PackagePriceBundle
): Promise<{ productId: string; priceId: string }> {
  const stripe = getStripe();

  let productId = pkg.stripeProductId;
  let priceId = pkg.stripePriceId;
  let changed = false;

  if (!productId) {
    const product = await stripe.products.create({
      name: `${pkg.name} — Grynd Tokens`,
      description: "Virtual tokens for GRYND. No cash value; non-refundable.",
      metadata: { packageKey: pkg.key },
    });
    productId = product.id;
    changed = true;
  }

  if (!priceId) {
    // The package is bound to a real Stripe product — reuse its existing active
    // one-time price if there is one, so we never mint duplicate prices for the
    // same product. Otherwise create a price to match our catalog value.
    if (productId) {
      try {
        const existing = await stripe.prices.list({
          product: productId,
          type: "one_time",
          active: true,
          limit: 1,
        });
        if (existing.data[0]) {
          priceId = existing.data[0].id;
        }
      } catch {
        // fall through to creating a new price
      }
    }
    if (!priceId) {
      const price = await stripe.prices.create({
        unit_amount: pkg.priceCents,
        currency: "usd",
        product: productId ?? undefined,
        metadata: { packageKey: pkg.key },
      });
      priceId = price.id;
    }
    changed = true;
  }

  if (changed) {
    await db
      .update(tokenPackages)
      .set({ stripeProductId: productId, stripePriceId: priceId, updatedAt: new Date() })
      .where(eq(tokenPackages.id, pkg.id));
  }

  return { productId, priceId };
}

/**
 * Resolve the authoritative display price (in cents) for a package. When the
 * package is bound to a real Stripe product, the product's active one-time
 * price wins; otherwise the catalog's stored `priceCents`. Never throws — on
 * any Stripe failure it falls back to the stored value so the Shop always
 * renders.
 */
export async function resolvePackagePriceCents(pkg: PackagePriceBundle): Promise<number> {
  if (pkg.stripeProductId) {
    try {
      const prices = await getStripe().prices.list({
        product: pkg.stripeProductId,
        type: "one_time",
        active: true,
        limit: 1,
      });
      if (prices.data[0] && typeof prices.data[0].unit_amount === "number") {
        return prices.data[0].unit_amount;
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
