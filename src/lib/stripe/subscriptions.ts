// src/lib/stripe/subscriptions.ts
//
// Grynd+ token subscriptions — recurring monthly token grants backed by
// Stripe Billing. Mirrors src/lib/stripe/packages.ts but for recurring
// prices: plans live in `token_subscription_plans`, and grants are credited
// per paid invoice by the webhook (idempotent on the invoice id).
//
//   * ensureSubscriptionPlanStripe(plan) — lazily creates a Product + recurring
//     (monthly) Price for one plan (idempotent: reuses persisted ids). Used by
//     the subscribe route on first checkout.
//   * syncAllSubscriptionPlansToStripe() — ensures every enabled plan; used by
//     the admin sync route to precreate prices without waiting for a sale.
//   * resolveSubscriptionPlanPriceCents(plan) — authoritative display price,
//     preferring the product's active recurring Stripe price.
//   * findActiveSubscription(clerkId) — the user's current subscription.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import {
  tokenSubscriptionCredits,
  tokenSubscriptionPlans,
  tokenSubscriptions,
  tokenTransactions,
} from "../../db/schema";
import { getStripe } from "../stripe";
import { creditUserBalance } from "../tokens/creditTokens";

export type SubscriptionPlanBundle = {
  id: number;
  key: string;
  name: string;
  monthlyTokens: number;
  priceCents: number;
  stripeProductId: string | null;
  stripePriceId: string | null;
};

/** Statuses that count as "the user currently has an active subscription". */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

/**
 * Guarantee the plan has a Stripe Product + recurring monthly Price, creating
 * what's missing and persisting the resulting ids back onto
 * `token_subscription_plans`. Idempotent per field — already-set ids are
 * reused, never recreated on repeat calls.
 */
export async function ensureSubscriptionPlanStripe(
  plan: SubscriptionPlanBundle
): Promise<{ productId: string; priceId: string }> {
  const stripe = getStripe();

  let productId = plan.stripeProductId;
  let priceId = plan.stripePriceId;
  let changed = false;

  // If only the price id is known (e.g. pasted from the Dashboard), resolve
  // its product so we never create a duplicate product for an existing price.
  // A binding can go stale when switching test -> live keys: the id no longer
  // resolves, so clear it and create a fresh product + price below (self-heal).
  if (!productId && priceId) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      if (typeof price.product === "string") {
        productId = price.product;
        changed = true;
      }
    } catch {
      priceId = null;
      changed = true;
    }
  }

  if (!productId) {
    const product = await stripe.products.create({
      name: `${plan.name} — Grynd Subscription`,
      description: "Monthly Grynd+ membership. Virtual tokens; no cash value; non-refundable.",
      // Same Managed Payments compliance as packages.ts (see note there).
      tax_code: "txcd_99999999",
      metadata: { planKey: plan.key },
    });
    productId = product.id;
    changed = true;
  }

  if (!priceId) {
    // Reuse the product's existing active recurring price if there is one,
    // so we never mint duplicate prices for the same product.
    if (productId) {
      try {
        const existing = await stripe.prices.list({
          product: productId,
          type: "recurring",
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
        unit_amount: plan.priceCents,
        currency: "usd",
        recurring: { interval: "month" },
        product: productId ?? undefined,
        metadata: { planKey: plan.key },
      });
      priceId = price.id;
    }
    changed = true;
  }

  if (changed) {
    await db
      .update(tokenSubscriptionPlans)
      .set({ stripeProductId: productId, stripePriceId: priceId, updatedAt: new Date() })
      .where(eq(tokenSubscriptionPlans.id, plan.id));
  }

  return { productId, priceId };
}

/**
 * Resolve the authoritative display price (in cents) for a plan. When the plan
 * is bound to a real Stripe product, the product's active recurring price wins;
 * otherwise the catalog's stored `priceCents`. Never throws — on any Stripe
 * failure it falls back to the stored value so the Shop always renders.
 */
export async function resolveSubscriptionPlanPriceCents(
  plan: SubscriptionPlanBundle
): Promise<number> {
  // The bound price is the most authoritative source when we have it.
  if (plan.stripePriceId) {
    try {
      const price = await getStripe().prices.retrieve(plan.stripePriceId);
      if (typeof price.unit_amount === "number") {
        return price.unit_amount;
      }
    } catch {
      // fall through to the product lookup / stored price
    }
  }
  if (plan.stripeProductId) {
    try {
      const prices = await getStripe().prices.list({
        product: plan.stripeProductId,
        type: "recurring",
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
  return plan.priceCents ?? 0;
}

/** Ensure a real Stripe Product + recurring Price exists for every enabled plan. */
export async function syncAllSubscriptionPlansToStripe(): Promise<{
  count: number;
  results: Record<string, { productId: string; priceId: string }>;
}> {
  const rows = await db
    .select({
      id: tokenSubscriptionPlans.id,
      key: tokenSubscriptionPlans.key,
      name: tokenSubscriptionPlans.name,
      monthlyTokens: tokenSubscriptionPlans.monthlyTokens,
      priceCents: tokenSubscriptionPlans.priceCents,
      stripeProductId: tokenSubscriptionPlans.stripeProductId,
      stripePriceId: tokenSubscriptionPlans.stripePriceId,
    })
    .from(tokenSubscriptionPlans)
    .where(eq(tokenSubscriptionPlans.enabled, true));

  const results: Record<string, { productId: string; priceId: string }> = {};
  for (const row of rows) {
    results[row.key] = await ensureSubscriptionPlanStripe(row);
  }
  return { count: rows.length, results };
}

/** True when the user currently holds an active Grynd+ membership. */
export async function isPremiumMember(clerkId: string): Promise<boolean> {
  return (await findActiveSubscription(clerkId)) !== null;
}

/** The user's current subscription row (newest first), or null. */
export async function findActiveSubscription(clerkId: string) {
  const rows = await db
    .select()
    .from(tokenSubscriptions)
    .where(
      and(
        eq(tokenSubscriptions.clerkId, clerkId),
        inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES)
      )
    )
    .orderBy(desc(tokenSubscriptions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Grant one month's tokens for a paid subscription invoice, atomically and
 * idempotently. The unique `stripe_invoice_id` in `token_subscription_credits`
 * is the durable key: the credit row is inserted first (only one concurrent
 * webhook delivery wins), then the balance credit + transaction history row
 * happen in the SAME transaction. Replays are no-ops.
 */
export async function grantSubscriptionInvoiceTokens(params: {
  clerkId: string;
  planKey: string;
  invoiceId: string;
  amount: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): Promise<boolean> {
  const { clerkId, planKey, invoiceId, amount, periodStart, periodEnd } = params;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(tokenSubscriptionCredits)
      .values({
        clerkId,
        planKey,
        stripeInvoiceId: invoiceId,
        amount,
        periodStart: periodStart ?? null,
        periodEnd: periodEnd ?? null,
      })
      .onConflictDoNothing({ target: tokenSubscriptionCredits.stripeInvoiceId })
      .returning({ id: tokenSubscriptionCredits.id });

    if (!inserted[0]) {
      // Already granted for this invoice — idempotent replay.
      return false;
    }

    await creditUserBalance(clerkId, amount, tx as never);

    // Durable, auditable transaction record — written in the SAME transaction
    // as the balance credit, so balance and history can never diverge.
    await tx.insert(tokenTransactions).values({
      clerkId,
      type: "purchase",
      amount,
      referenceType: "stripe_invoice",
      referenceId: invoiceId,
      note: `Subscription ${planKey}`,
    });

    return true;
  });
}
