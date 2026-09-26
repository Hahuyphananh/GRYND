// src/lib/stripe/subscriptions.ts
//
// GRYND membership — ONE paid plan (GRYND PRO) backed by Stripe Billing.
// Mirrors src/lib/stripe/packages.ts but for a recurring monthly price: the
// plan lives in `token_subscription_plans` (a legacy table name kept for
// migration compatibility) and the subscription itself lives in
// `token_subscriptions`.
//
// The membership model is exactly two states: `free` and `pro`.
//
//   * ensureSubscriptionPlanStripe(plan) — lazily creates a Product + recurring
//     (monthly) Price for the plan (idempotent: reuses persisted ids). Used by
//     the subscribe route on first checkout.
//   * syncAllSubscriptionPlansToStripe() — ensures every enabled plan; used by
//     the admin sync route to precreate prices without waiting for a sale.
//   * resolveSubscriptionPlanPriceCents(plan) — authoritative display price,
//     preferring the product's active recurring Stripe price.
//   * findActiveSubscription(clerkId) — the user's current subscription, or
//     null. This is the single server-authoritative membership check.
//   * getMembershipTier(clerkId) — `pro` when a subscription is active,
//     otherwise `free`.
//
// NO TOKENS: subscribing grants no tokens and no monthly currency. Paid
// invoices are acknowledged + audited, never credited (see the Stripe
// webhook). GRYND PRO sells ad-free/analytics/support perks only.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { tokenSubscriptionPlans, tokenSubscriptions } from "../../db/schema";
import { getStripe } from "../stripe";
import { MANAGED_PAYMENTS_TAX_CODE } from "./packages";
import {
  PRO_PLAN_FALLBACK_PERKS,
  formatUsdFromCents,
  type ProPlanDisplay,
} from "../membershipDisplay";

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
 * The two membership states GRYND supports: `free` and `pro`.
 *
 * Every active Stripe subscription resolves to `pro`, whatever plan key it was
 * created under. Legacy plans (grynd-plus / grynd-high-roller) are disabled for
 * new checkouts (migration 0168) but an existing PAID subscription is never
 * silently downgraded — it simply becomes GRYND PRO.
 */
export type MembershipTier = "free" | "pro";

/** The single purchasable membership plan (see migration 0168). */
export const CANONICAL_MEMBERSHIP_PLAN_KEY = "grynd-pro";

/** Legacy plan keys. Not purchasable; still resolve to `pro` while active. */
export const LEGACY_MEMBERSHIP_PLAN_KEYS = [
  "grynd-plus",
  "grynd-high-roller",
] as const;

/**
 * Catalog fallback price for GRYND PRO, used only when the plan row (or its
 * bound Stripe price) can't be read. The real price always comes from the plan
 * catalog / Stripe — this constant exists so the upgrade surface still renders
 * an honest number on a cold/failed read instead of a blank CTA.
 */
export const FALLBACK_PRO_PRICE_CENTS = 999;

/** The user's current membership state — server-authoritative. */
export async function getMembershipTier(
  clerkId: string
): Promise<MembershipTier> {
  return (await findActiveSubscription(clerkId)) ? "pro" : "free";
}

// ── Membership perks (GRYND PRO) ───────────────────────────────────────────
// GRYND PRO is deliberately non-competitive. It sells ad-free browsing,
// advanced statistics / performance analytics, detailed match history, the
// profile-customization cosmetics (custom chat color, profile accent) and a
// priority-support flag. It NEVER grants:
//
//   * tokens or any other currency,
//   * XP multipliers,
//   * faster trophy or Prestige progression,
//   * priority matchmaking or any other gameplay / competitive advantage.
//
// Free players get the complete game: all games, ranked play, Elo,
// leaderboards, free tournaments, profiles, match history, progression,
// the Battle Pass and cosmetic rewards.

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
      description:
        "Monthly GRYND PRO membership — ad-free browsing, advanced statistics and analytics, detailed match history. No tokens or in-game currency are included.",
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

/**
 * The single purchasable plan's display data (name, price, perks), resolved
 * server-side. This is THE source of the price for every upgrade surface —
 * UpgradeProButton, UpgradeProModal and the /upgrade-pro page all read it
 * (directly or via /api/membership/status), so the advertised price can never
 * drift from what Stripe charges.
 *
 * Never throws: on a Stripe/DB failure it falls back to the catalog price (or
 * the static defaults) so the upgrade surface still renders.
 */
export async function getProPlanDisplay(): Promise<ProPlanDisplay> {
  const fallback: ProPlanDisplay = {
    key: CANONICAL_MEMBERSHIP_PLAN_KEY,
    name: "GRYND PRO",
    priceCents: FALLBACK_PRO_PRICE_CENTS,
    priceUsd: formatUsdFromCents(FALLBACK_PRO_PRICE_CENTS),
    badge: "Pro",
    perks: [...PRO_PLAN_FALLBACK_PERKS],
  };

  const rows = await db
    .select({
      id: tokenSubscriptionPlans.id,
      key: tokenSubscriptionPlans.key,
      name: tokenSubscriptionPlans.name,
      monthlyTokens: tokenSubscriptionPlans.monthlyTokens,
      priceCents: tokenSubscriptionPlans.priceCents,
      badge: tokenSubscriptionPlans.badge,
      perks: tokenSubscriptionPlans.perks,
      stripeProductId: tokenSubscriptionPlans.stripeProductId,
      stripePriceId: tokenSubscriptionPlans.stripePriceId,
    })
    .from(tokenSubscriptionPlans)
    .where(eq(tokenSubscriptionPlans.key, CANONICAL_MEMBERSHIP_PLAN_KEY))
    .limit(1)
    .catch((err) => {
      // A cold/unreadable database must not blank the upgrade surface — the
      // catalog fallback is an honest display price for the same plan.
      console.error("[subscriptions] Failed to read the PRO plan:", err);
      return null;
    });

  const row = rows?.[0];
  if (!row) return fallback;

  let priceCents = Number(row.priceCents ?? fallback.priceCents);
  try {
    priceCents = await resolveSubscriptionPlanPriceCents({
      id: row.id,
      key: row.key,
      name: row.name,
      monthlyTokens: Number(row.monthlyTokens ?? 0),
      priceCents,
      stripeProductId: row.stripeProductId,
      stripePriceId: row.stripePriceId,
    });
  } catch {
    // Keep the catalog price — the upgrade surface must always render.
  }

  const perks = Array.isArray(row.perks)
    ? row.perks.filter((p): p is string => Boolean(p && String(p).trim()))
    : [];

  return {
    key: row.key,
    name: row.name || fallback.name,
    priceCents,
    priceUsd: formatUsdFromCents(priceCents),
    badge: row.badge ?? null,
    perks: perks.length > 0 ? perks : fallback.perks,
  };
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

/** True when the user currently holds an active GRYND PRO membership. */
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

