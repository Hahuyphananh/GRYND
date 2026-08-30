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
 * Rich product descriptions shown in Stripe (product page + checkout). Keyed
 * by package key so the auto-created products carry real sales copy instead of
 * a one-line disclaimer. Falls back to the generic line for unknown keys.
 */
const PACKAGE_DESCRIPTIONS: Record<string, string> = {
  starter:
    "5,000 Grynd Tokens — the perfect way to start playing on GRYND. Use tokens to join any game: Blackjack, Mines, Plinko, Roulette, Crash Arena, Slots, Coin Flip and more. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  small:
    "10,500 Grynd Tokens (10,000 + 500 bonus). A step up for regular players: jump into higher-stakes tables and PvP lobbies across Blackjack, Plinko, Mines, Roulette, Crash Arena, Slots and more. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  medium:
    "22,000 Grynd Tokens (20,000 + 2,000 bonus — 10% extra value). Built for active players who want a bigger bankroll for tournaments, streaks and high-stakes PvP across all GRYND games. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  large:
    "48,000 Grynd Tokens (40,000 + 8,000 bonus — 20% extra value). The most popular pack. A serious bankroll for grinding the leaderboard, chasing daily streaks and playing every game GRYND offers at the stakes you want. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
  mega:
    "120,000 Grynd Tokens (90,000 + 30,000 bonus — 33% extra value). The best value pack on GRYND: the largest token top-up at the best price per token. For high rollers and long-term players who live on the leaderboard. Tokens never expire, work across the whole platform, and are virtual — they have no cash value and are non-refundable.",
};

export function getPackageDescription(key: string): string {
  return (
    PACKAGE_DESCRIPTIONS[key] ??
    "Virtual tokens for GRYND. No cash value; non-refundable."
  );
}

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
      description: getPackageDescription(pkg.key),
      // Managed Payments (on by default) rejects checkout for products without
      // a tax code. `txcd_99999999` is Stripe's general tax code for
      // electronically supplied services — the right fit for virtual tokens.
      tax_code: "txcd_99999999",
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
