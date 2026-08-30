/**
 * scripts/verify-stripe-packages.ts
 *
 * Confirms that the `token_packages` catalog is mirrored in Stripe as real
 * Products + one-time Prices, and reports any package that isn't yet.
 *
 * Reads the Stripe secret key from the environment (or `.env.local`) and the
 * token catalog from the database (DATABASE_URL / POSTGRES_URL).
 *
 * Usage (from the repo root):
 *   npx tsx scripts/verify-stripe-packages.ts            # report only
 *   npx tsx scripts/verify-stripe-packages.ts --sync     # also CREATE missing
 *                                                        # products/prices
 *
 * Exit code 0 = every enabled package has a matching active Stripe price.
 * Non-zero = some are missing (or --sync still could not reconcile).
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { tokenPackages } from "../src/db/schema";
import { getStripe } from "../src/lib/stripe";
import { ensurePackageStripe } from "../src/lib/stripe/packages";

const SYNC = process.argv.includes("--sync");

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error(
      "STRIPE_SECRET_KEY is not set. Export it (or add it to .env.local) first. " +
        "Get test keys from https://dashboard.stripe.com/test/apikeys — preferably a " +
        "restricted (rk_) key scoped to products/prices/checkout/webhooks."
    );
    process.exit(2);
  }

  const stripe = getStripe();

  const packages = await db
    .select({
      id: tokenPackages.id,
      key: tokenPackages.key,
      name: tokenPackages.name,
      priceCents: tokenPackages.priceCents,
      stripeProductId: tokenPackages.stripeProductId,
      stripePriceId: tokenPackages.stripePriceId,
      enabled: tokenPackages.enabled,
    })
    .from(tokenPackages)
    .orderBy(tokenPackages.sortOrder);

  // Map every Stripe product/price we can see (match by id and by the
  // packageKey metadata we stamp on creation).
  const [products, prices] = await Promise.all([
    stripe.products.list({ limit: 100 }),
    stripe.prices.list({ limit: 100, active: true }),
  ]);
  const productsByKey = new Map<string, string>();
  for (const p of products.data) {
    const k = p.metadata?.packageKey;
    if (k) productsByKey.set(k, p.id);
  }
  const pricesByKey = new Map<string, string>();
  for (const pr of prices.data) {
    const k = pr.metadata?.packageKey;
    if (k) pricesByKey.set(k, pr.id);
  }

  let allOk = true;
  let changed = false;

  for (const pkg of packages) {
    const storedProduct = pkg.stripeProductId;
    const storedPrice = pkg.stripePriceId;
    const productId = storedProduct || productsByKey.get(pkg.key) || null;
    const priceId = storedPrice || pricesByKey.get(pkg.key) || null;

    const price = priceId ? prices.data.find((p) => p.id === priceId) : null;
    const priceMatches = price && Number(price.unit_amount) === pkg.priceCents;

    if (SYNC && pkg.enabled && !(storedProduct && storedPrice && priceMatches)) {
      const r = await ensurePackageStripe(pkg);
      allOk = allOk && true;
      changed = true;
      console.log(`  [synced] ${pkg.key.padEnd(10)} product=${r.productId} price=${r.priceId}`);
      continue;
    }

    const status = pkg.enabled
      ? priceMatches
        ? "OK   "
        : priceId
          ? "MISMATCH"
          : "MISSING"
      : "disabled";

    if (pkg.enabled && !priceMatches) allOk = false;

    console.log(
      `  ${status}  ${pkg.key.padEnd(10)} $${(pkg.priceCents / 100).toFixed(2)}  ` +
        (productId ? `product=${productId} ` : "") +
        (priceId
          ? `price=${priceId} ($${(Number(price?.unit_amount) / 100).toFixed(2)})`
          : "(no price yet)")
    );
  }

  if (changed) {
    console.log("\nSynced new products/prices — re-run without --sync to confirm.");
  } else if (allOk) {
    console.log("\n✅ All enabled token packages have a matching active Stripe product + price.");
  } else {
    console.log(
      "\n⚠️  Some enabled packages are missing or mismatched in Stripe. Re-run with --sync to create them."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exitCode = 1;
});
