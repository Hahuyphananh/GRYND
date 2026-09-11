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
//   * getMembershipTier(clerkId) — the user's tier (free | grynd_plus | pro |
//     high_roller) resolved from the active subscription's plan key. Higher
//     tiers also earn monthly perk grants (see TIER_MONTHLY_GRANTS) credited
//     by the webhook alongside the token grant.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  tokenSubscriptionCredits,
  tokenSubscriptionPlans,
  tokenSubscriptions,
  tokenTransactions,
  userItemEffects,
  userItems,
  users,
} from "../../db/schema";
import { getStripe } from "../stripe";
import { MANAGED_PAYMENTS_TAX_CODE } from "./packages";
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

/** Membership tiers, ordered low → high. */
export type MembershipTier = "grynd_plus" | "pro" | "high_roller";

/**
 * Tier resolution: subscription plan key → membership tier. Unknown/legacy
 * plan keys keep behaving as the base tier so an active paid membership is
 * never silently downgraded to "no perks".
 */
export const TIER_BY_PLAN_KEY: Record<string, MembershipTier> = {
  "grynd-plus": "grynd_plus",
  "grynd-pro": "pro",
  "grynd-high-roller": "high_roller",
};

/**
 * The `perks` advertised on the higher-tier Shop cards that are granted
 * mechanically per paid invoice (besides the token grant): Daily Streak
 * Shields + a 3× XP boost window. Credited inside the same transaction as the
 * monthly token grant so a given paid invoice always delivers the full
 * reward exactly once (idempotent on the invoice id).
 */
export const TIER_MONTHLY_GRANTS: Record<
  string,
  { streakShields: number; xpBoost3xHours: number }
> = {
  "grynd-pro": { streakShields: 3, xpBoost3xHours: 48 },
  "grynd-high-roller": { streakShields: 5, xpBoost3xHours: 96 },
};

/** The user's current membership tier, or null when they have no active plan. */
export async function getMembershipTier(
  clerkId: string
): Promise<MembershipTier | null> {
  const sub = await findActiveSubscription(clerkId);
  if (!sub) return null;
  return TIER_BY_PLAN_KEY[sub.planKey] ?? "grynd_plus";
}

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

  if (productId) {
    // Same stale-binding self-heal as packages.ts: if the persisted product no
    // longer resolves (e.g. test-mode binding after switching to live keys),
    // clear it so a fresh product + recurring price is minted below. Valid
    // products get their tax code reconciled to the Managed Payments-eligible
    // code (pre-MSP plans used the ineligible `txcd_99999999`).
    try {
      await stripe.products.retrieve(productId);
      try {
        await stripe.products.update(productId, {
          tax_code: MANAGED_PAYMENTS_TAX_CODE,
        });
      } catch {
        // Non-fatal: recurring price resolution below still works.
      }
    } catch {
      productId = null;
      priceId = null;
      changed = true;
    }
  }

  if (!productId) {
    const product = await stripe.products.create({
      name: `${plan.name} — Grynd Subscription`,
      description: "Monthly Grynd+ membership. Virtual tokens; no cash value; non-refundable.",
      // Same Managed Payments-eligible tax code as packages.ts (txcd_10103100).
      tax_code: MANAGED_PAYMENTS_TAX_CODE,
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

    // Higher tiers also grant monthly consumable perks inside the same
    // transaction (sales copy lives in the plan's `perks` column). Uses the
    // same write shapes as the shop/battlepass (user_items upsert +
    // user_item_effects extend-or-activate), so exempted monthly shields/XP
    // boost never add a second, unaccounted source of inventory writes.
    const tierGrant = TIER_MONTHLY_GRANTS[planKey];
    if (tierGrant) {
      const [appUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);
      if (appUser) {
        if (tierGrant.streakShields > 0) {
          await tx
            .insert(userItems)
            .values({
              userId: appUser.id,
              itemKey: "streak_shield",
              qty: tierGrant.streakShields,
            })
            .onConflictDoUpdate({
              target: [userItems.userId, userItems.itemKey],
              set: {
                qty: sql`${userItems.qty} + ${tierGrant.streakShields}`,
                updatedAt: new Date(),
              },
            });
        }
        if (tierGrant.xpBoost3xHours > 0) {
          await tx
            .insert(userItemEffects)
            .values({
              userId: appUser.id,
              effectKey: "xp_boost_3x_48h",
              expiresAt: new Date(
                Date.now() + tierGrant.xpBoost3xHours * 3600 * 1000
              ),
            })
            .onConflictDoUpdate({
              target: [userItemEffects.userId, userItemEffects.effectKey],
              set: {
                expiresAt: sql`GREATEST(${userItemEffects.expiresAt}, now()) + make_interval(hours => ${tierGrant.xpBoost3xHours})`,
                updatedAt: new Date(),
              },
            });
        }
      }
    }

    return true;
  });
}
