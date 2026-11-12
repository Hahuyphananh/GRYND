/**
 * scripts/reconcile-pro-catalog.mts
 *
 * One-off repair of the GRYND PRO Stripe catalog, limited to the `grynd-pro`
 * plan (unlike POST /api/admin/stripe-sync, which also touches token packages):
 *
 *   * ensures a CAD recurring Price for weekly / monthly / yearly,
 *   * rebinds the plan row's three price columns to them,
 *   * reconciles the Product's default price to the monthly CAD price,
 *   * reads the result back from both Stripe and the database.
 *
 * It reuses `ensureSubscriptionPlanStripe`, so it is idempotent: an already
 * correct binding is reused untouched, and legacy prices are never edited or
 * deactivated (historical invoices keep pointing at what was charged).
 *
 * REQUIRES the database CA bundle, because the pool verifies TLS on every
 * non-local connection (see docs/SUPABASE_MIGRATION.md):
 *
 *   DATABASE_SSL_CA_PATH=/home/ubuntu/grynd/env/db-ca.pem \
 *     npx tsx scripts/reconcile-pro-catalog.mts
 *
 * Prints no secrets. Exits non-zero unless the database row ended up holding
 * exactly the price ids the function resolved.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { tokenSubscriptionPlans } from "../src/db/schema";
import {
  CANONICAL_MEMBERSHIP_PLAN_KEY,
  ensureSubscriptionPlanStripe,
} from "../src/lib/stripe/subscriptions";
import { getStripe } from "../src/lib/stripe";

const [plan] = await db
  .select()
  .from(tokenSubscriptionPlans)
  .where(eq(tokenSubscriptionPlans.key, CANONICAL_MEMBERSHIP_PLAN_KEY))
  .limit(1);

if (!plan) throw new Error("grynd-pro plan row not found");

console.log(
  "BEFORE row:",
  JSON.stringify({
    product: plan.stripeProductId,
    weekly: plan.stripePriceIdWeekly,
    monthly: plan.stripePriceId,
    yearly: plan.stripePriceIdYearly,
  }),
);

const result = await ensureSubscriptionPlanStripe({
  id: plan.id,
  key: plan.key,
  name: plan.name,
  monthlyTokens: Number(plan.monthlyTokens),
  priceCents: plan.priceCents,
  stripeProductId: plan.stripeProductId,
  stripePriceId: plan.stripePriceId,
  stripePriceIdWeekly: plan.stripePriceIdWeekly,
  stripePriceIdYearly: plan.stripePriceIdYearly,
});

console.log("PRODUCT:", result.productId);

const stripe = getStripe();
for (const interval of ["weekly", "monthly", "yearly"] as const) {
  const id = result.priceIds[interval];
  if (!id) {
    console.log(interval.toUpperCase(), "MISSING");
    continue;
  }
  const price = await stripe.prices.retrieve(id);
  console.log(
    interval.toUpperCase(),
    JSON.stringify({
      id,
      currency: price.currency,
      amount: price.unit_amount,
      recurring: price.recurring?.interval,
      active: price.active,
    }),
  );
}

const product = await stripe.products.retrieve(result.productId);
const rawDefault = product.default_price;
const defaultId =
  typeof rawDefault === "string" ? rawDefault : (rawDefault?.id ?? null);
const defaultPrice = defaultId
  ? await stripe.prices.retrieve(defaultId).catch(() => null)
  : null;
console.log(
  "PRODUCT DEFAULT:",
  JSON.stringify({
    id: defaultId,
    currency: defaultPrice?.currency,
    amount: defaultPrice?.unit_amount,
  }),
);

const [after] = await db
  .select({
    product: tokenSubscriptionPlans.stripeProductId,
    weekly: tokenSubscriptionPlans.stripePriceIdWeekly,
    monthly: tokenSubscriptionPlans.stripePriceId,
    yearly: tokenSubscriptionPlans.stripePriceIdYearly,
  })
  .from(tokenSubscriptionPlans)
  .where(eq(tokenSubscriptionPlans.id, plan.id))
  .limit(1);

console.log("AFTER row:", JSON.stringify(after));

const persisted =
  after?.product === result.productId &&
  after?.weekly === result.priceIds.weekly &&
  after?.monthly === result.priceIds.monthly &&
  after?.yearly === result.priceIds.yearly;
console.log("PERSISTED:", persisted ? "yes" : "NO");

process.exit(persisted ? 0 : 1);
