// src/lib/stripe/subscriptions.ts
//
// GRYND membership — ONE paid plan (GRYND PRO) backed by Stripe Billing, sold
// on THREE recurring options (weekly / monthly / yearly). Every option grants
// the same `pro` entitlement; billing frequency never changes benefits.
// Mirrors src/lib/stripe/packages.ts: the plan lives in
// `token_subscription_plans` (a legacy table name kept for migration
// compatibility) and the subscription itself lives in `token_subscriptions`.
//
// The Stripe catalog model is ONE Product with THREE Prices:
//   * `stripeProductId`         — the single GRYND PRO product,
//   * `stripePriceId`           — the MONTHLY price (the original binding),
//   * `stripePriceIdWeekly`     — the $3.49/week price,
//   * `stripePriceIdYearly`     — the $59.99/year price.
// Amounts/intervals are the approved catalog (src/lib/proBilling.ts).
//
// The membership model is exactly two states: `free` and `pro`.
//
//   * ensureSubscriptionPlanStripe(plan) — lazily creates the Product + the
//     three recurring Prices, creating only what is missing (idempotent:
//     reuses persisted ids, adopts the product by its metadata, never
//     duplicates). Used by the subscribe route on first checkout and by the
//     admin sync route.
//   * syncAllSubscriptionPlansToStripe() — ensures every enabled plan; used by
//     the admin sync route to precreate prices without waiting for a sale.
//   * resolveProBillingAmounts(plan) — authoritative amounts for all three
//     options, preferring the bound Stripe price.
//   * resolveSubscriptionPlanPriceCents(plan, interval) — one option's price.
//   * findActiveSubscription(clerkId) — the user's current subscription, or
//     null. This is the single server-authoritative membership check.
//   * getMembershipTier(clerkId) — `pro` when a subscription is active,
//     otherwise `free`.
//   * getActiveMemberIds(clerkIds) — the bulk active-member set the matchmaking
//     queue worker uses for its bounded, ordering-only Pro priority.
//
// NO TOKENS: subscribing grants no tokens and no monthly currency. Paid
// invoices are acknowledged + audited, never credited (see the Stripe
// webhook). GRYND PRO sells ad-free/analytics/support perks only.

import { and, desc, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../../db/client";
import { tokenSubscriptionPlans, tokenSubscriptions } from "../../db/schema";
import { getStripe } from "../stripe";
import { MANAGED_PAYMENTS_TAX_CODE } from "./packages";
import {
  PRO_PLAN_FALLBACK_PERKS,
  formatUsdFromCents,
  type ProPlanDisplay,
} from "../membershipDisplay";
import {
  PRO_BILLING_INTERVALS,
  PRO_PRICE_CENTS,
  PRO_STRIPE_INTERVAL,
  buildProBillingOptions,
  type ProBillingInterval,
} from "../proBilling";

export type SubscriptionPlanBundle = {
  id: number;
  key: string;
  name: string;
  monthlyTokens: number;
  /** Legacy MONTHLY catalog price in cents (see `priceCentsByInterval`). */
  priceCents: number;
  stripeProductId: string | null;
  /** The MONTHLY Stripe price (the original binding — never re-purposed). */
  stripePriceId: string | null;
  /** The WEEKLY Stripe price, or null when not yet created/bound. */
  stripePriceIdWeekly?: string | null;
  /** The YEARLY Stripe price, or null when not yet created/bound. */
  stripePriceIdYearly?: string | null;
};

/** One bound Stripe Price id per billing option (null = not bound yet). */
export type StripePriceIds = Record<ProBillingInterval, string | null>;

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
// GRYND PRO sells ad-free browsing, advanced statistics / performance
// analytics, detailed match history, the profile-customization cosmetics
// (custom chat color, profile accent), priority support and PRIORITY
// MATCHMAKING. It NEVER grants:
//
//   * tokens or any other currency,
//   * XP multipliers,
//   * faster trophy or Elo progression,
//   * a wider skill window, a bypassed game/mode/region constraint, or any
//     influence over a match's outcome.
//
// PRIORITY MATCHMAKING — what it is and is NOT:
//   A verified ACTIVE subscriber is preferred over an otherwise EQUIVALENT free
//   candidate in the queue worker's candidate ORDERING only. Membership never
//   widens the trophy/Elo compatibility window (so a Pro member is never paired
//   outside the same skill band a free player is held to), never overrides the
//   game / mode / region / player-count constraints, and never changes a
//   result. Skill compatibility stays the primary criterion: a strictly closer
//   match always beats a less compatible Pro candidate. The priority is
//   bounded (a small skill tolerance) and the existing wait-time window
//   widening keeps free players from starving.
//   See src/lib/quickQueue.ts + src/lib/quickQueueWorker.ts.
//
// Free players get the complete game: all games, ranked play, Elo,
// leaderboards, free tournaments, profiles, match history, progression and
// every cosmetic reward.

/**
 * The catalog amount + Stripe recurring interval a billing option must have.
 * ONE product, THREE prices — every option sells the same membership.
 */
function expectedPriceSpec(interval: ProBillingInterval) {
  return {
    unitAmount: PRO_PRICE_CENTS[interval],
    currency: "usd",
    interval: PRO_STRIPE_INTERVAL[interval],
  };
}

/** A price's product id, whether Stripe returned it expanded or as a string. */
function priceProductId(price: Stripe.Price): string | null {
  const product = price.product as string | Stripe.Product | null;
  if (!product) return null;
  return typeof product === "string" ? product : product.id;
}

/**
 * True when `price` is the exact price the catalog approves for `interval`:
 * same product, same amount, USD, same recurring interval, and still active.
 * A mismatch means the binding is stale (an old amount, or a price from the
 * other Stripe mode) and must be re-resolved rather than sold.
 */
function priceMatchesSpec(
  price: Stripe.Price,
  productId: string,
  interval: ProBillingInterval,
): boolean {
  const spec = expectedPriceSpec(interval);
  if (price.active === false) return false;
  if (priceProductId(price) !== productId) return false;
  if (price.unit_amount !== spec.unitAmount) return false;
  if ((price.currency || "").toLowerCase() !== spec.currency) return false;
  return price.recurring?.interval === spec.interval;
}

/**
 * Find an existing GRYND PRO product by its `planKey` metadata, so a sync run
 * with a lost binding ADOPTS the real product instead of minting a duplicate.
 * Best-effort: the product-search API may be unavailable, in which case we
 * fall back to the persisted id / a fresh create.
 */
async function findProductIdByPlanKey(stripe: Stripe, planKey: string): Promise<string | null> {
  const safeKey = planKey.replace(/[^a-z0-9_-]/gi, "");
  if (!safeKey) return null;
  try {
    const found = await stripe.products.search({
      query: `metadata['planKey']:'${safeKey}'`,
      limit: 1,
    });
    return found.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Guarantee the plan has ONE Stripe Product + a recurring Price for EACH
 * billing option (weekly / monthly / yearly), creating only what is missing and
 * persisting the resulting ids back onto `token_subscription_plans`.
 *
 * Idempotent per interval:
 *   * an already-bound price that still resolves AND still matches the catalog
 *     (product, amount, currency, interval) is reused untouched — a valid
 *     binding is never silently replaced;
 *   * a binding that no longer resolves, or that no longer matches (a stale
 *     amount, or an id from the other Stripe mode after a key switch), is
 *     LOGGED and re-resolved to an existing matching price on the product, or
 *     a new one if the product has none;
 *   * the product itself is reused from the persisted id, or adopted by its
 *     `planKey` metadata, or only then created — never duplicated.
 *
 * The MONTHLY option keeps its original column (`stripePriceId`) so the
 * pre-existing monthly subscription path is byte-for-byte unchanged.
 */
export async function ensureSubscriptionPlanStripe(
  plan: SubscriptionPlanBundle
): Promise<{ productId: string; priceIds: StripePriceIds }> {
  const stripe = getStripe();

  const bound: StripePriceIds = {
    weekly: plan.stripePriceIdWeekly ?? null,
    monthly: plan.stripePriceId,
    yearly: plan.stripePriceIdYearly ?? null,
  };

  let productId = plan.stripeProductId;
  let changed = false;

  // If only a price id is known (e.g. pasted from the Dashboard), resolve its
  // product so we never create a duplicate product for an existing price. A
  // binding can go stale when switching test -> live keys: the id no longer
  // resolves, so drop it and re-resolve below (self-heal).
  if (!productId) {
    const knownPrice = PRO_BILLING_INTERVALS.map((i) => bound[i]).find(Boolean) as
      | string
      | undefined;
    if (knownPrice) {
      try {
        const price = await stripe.prices.retrieve(knownPrice);
        const resolved = priceProductId(price);
        if (resolved) {
          productId = resolved;
          changed = true;
        }
      } catch {
        for (const interval of PRO_BILLING_INTERVALS) {
          if (bound[interval] === knownPrice) bound[interval] = null;
        }
        changed = true;
      }
    }
  }

  if (productId) {
    // Same stale-binding self-heal as packages.ts: if the persisted product no
    // longer resolves (e.g. test-mode binding after switching to live keys),
    // clear it so it is re-adopted/created below. Valid products get their tax
    // code reconciled to the Managed Payments-eligible code (pre-MSP plans
    // used the ineligible `txcd_99999999`).
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
      for (const interval of PRO_BILLING_INTERVALS) bound[interval] = null;
      changed = true;
    }
  }

  // Adopt the real product before creating one, so a lost binding can never
  // produce a second GRYND PRO product.
  if (!productId) {
    productId = await findProductIdByPlanKey(stripe, plan.key);
    if (productId) changed = true;
  }

  if (!productId) {
    const product = await stripe.products.create({
      name: `${plan.name} — Grynd Subscription`,
      description:
        "GRYND PRO membership — ad-free browsing, advanced statistics and analytics, detailed match history, profile customization, priority support and priority matchmaking. Billed weekly, monthly or yearly. No tokens or in-game currency are included.",
      // Same Managed Payments-eligible tax code as packages.ts (txcd_10103100).
      tax_code: MANAGED_PAYMENTS_TAX_CODE,
      metadata: { planKey: plan.key },
    });
    productId = product.id;
    changed = true;
  }

  // The product's active recurring prices, listed at most ONCE per run and
  // reused for every interval that needs a reuse lookup — so a full sync of
  // three intervals costs a bounded number of Stripe calls.
  let productPrices: Stripe.Price[] | null = null;
  const activeProductPrices = async (): Promise<Stripe.Price[]> => {
    if (productPrices) return productPrices;
    try {
      const listed = await stripe.prices.list({
        product: productId as string,
        type: "recurring",
        active: true,
        limit: 100,
      });
      productPrices = listed.data;
    } catch {
      productPrices = [];
    }
    return productPrices;
  };

  const priceIds: StripePriceIds = { weekly: null, monthly: null, yearly: null };

  for (const interval of PRO_BILLING_INTERVALS) {
    const existingId = bound[interval];

    if (existingId) {
      try {
        const price = await stripe.prices.retrieve(existingId);
        if (priceMatchesSpec(price, productId, interval)) {
          // Still exactly right — never replace a valid binding.
          priceIds[interval] = existingId;
          continue;
        }
        // Resolves but no longer matches: a stale amount, or a binding left
        // over from the other Stripe mode. Never silently swapped — log it.
        console.warn(
          `[stripe] GRYND PRO ${interval} price binding ${existingId} no longer matches the catalog; re-resolving.`,
        );
      } catch {
        // Unresolvable (e.g. the other mode's id) — re-resolve below.
      }
      bound[interval] = null;
      changed = true;
    }

    // Reuse an existing matching price on the product rather than minting a
    // duplicate for the same amount + interval.
    const reusable = (await activeProductPrices()).find((price) =>
      priceMatchesSpec(price, productId as string, interval),
    );

    if (reusable) {
      priceIds[interval] = reusable.id;
    } else {
      const spec = expectedPriceSpec(interval);
      const created = await stripe.prices.create({
        unit_amount: spec.unitAmount,
        currency: spec.currency,
        recurring: { interval: spec.interval },
        product: productId,
        metadata: { planKey: plan.key, billingInterval: interval },
      });
      priceIds[interval] = created.id;
    }
    changed = true;
  }

  if (changed) {
    await db
      .update(tokenSubscriptionPlans)
      .set({
        stripeProductId: productId,
        // The monthly option keeps the ORIGINAL column so existing rows and the
        // existing monthly checkout path read exactly as before.
        stripePriceId: priceIds.monthly,
        stripePriceIdWeekly: priceIds.weekly,
        stripePriceIdYearly: priceIds.yearly,
        updatedAt: new Date(),
      })
      .where(eq(tokenSubscriptionPlans.id, plan.id));
  }

  return { productId, priceIds };
}

/**
 * The authoritative amounts (cents) for all three options for this plan,
 * used by the upgrade surface. Each bound Stripe price wins over the catalog
 * amount (so the advertised number is always what Stripe charges); a missing
 * or unreadable binding degrades to the product's matching price, then to the
 * approved catalog amount. Never throws.
 */
export async function resolveProBillingAmounts(
  plan: SubscriptionPlanBundle,
): Promise<Record<ProBillingInterval, number>> {
  const amounts: Record<ProBillingInterval, number> = { ...PRO_PRICE_CENTS };
  const bound: StripePriceIds = {
    weekly: plan.stripePriceIdWeekly ?? null,
    monthly: plan.stripePriceId,
    yearly: plan.stripePriceIdYearly ?? null,
  };

  let productPrices: Stripe.Price[] | null = null;
  try {
    for (const interval of PRO_BILLING_INTERVALS) {
      const priceId = bound[interval];
      if (priceId) {
        try {
          const price = await getStripe().prices.retrieve(priceId);
          if (typeof price.unit_amount === "number") {
            amounts[interval] = price.unit_amount;
            continue;
          }
        } catch {
          // fall through to the product lookup / catalog amount
        }
      }
      if (plan.stripeProductId) {
        if (!productPrices) {
          const listed = await getStripe().prices.list({
            product: plan.stripeProductId,
            type: "recurring",
            active: true,
            limit: 100,
          });
          productPrices = listed.data;
        }
        const match = productPrices.find(
          (price) => price.recurring?.interval === PRO_STRIPE_INTERVAL[interval],
        );
        if (typeof match?.unit_amount === "number") {
          amounts[interval] = match.unit_amount;
        }
      }
    }
  } catch {
    // Keep the catalog amounts — the upgrade surface must always render.
  }

  return amounts;
}

/**
 * Resolve the authoritative display price (in cents) for ONE billing option of
 * a plan. Kept as the single-interval entry point (defaults to the monthly
 * option, its historical meaning); it simply reads the multi-interval resolver
 * so there is exactly one price-resolution path. Never throws.
 */
export async function resolveSubscriptionPlanPriceCents(
  plan: SubscriptionPlanBundle,
  interval: ProBillingInterval = "monthly",
): Promise<number> {
  const amounts = await resolveProBillingAmounts(plan);
  return amounts[interval] ?? plan.priceCents ?? 0;
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
    // The three options are always present, so the upgrade surface can render
    // its selector even when the plan row (or Stripe) cannot be read.
    billingOptions: buildProBillingOptions(),
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
      stripePriceIdWeekly: tokenSubscriptionPlans.stripePriceIdWeekly,
      stripePriceIdYearly: tokenSubscriptionPlans.stripePriceIdYearly,
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

  const planBundle: SubscriptionPlanBundle = {
    id: row.id,
    key: row.key,
    name: row.name,
    monthlyTokens: Number(row.monthlyTokens ?? 0),
    priceCents: Number(row.priceCents ?? fallback.priceCents),
    stripeProductId: row.stripeProductId,
    stripePriceId: row.stripePriceId,
    stripePriceIdWeekly: row.stripePriceIdWeekly,
    stripePriceIdYearly: row.stripePriceIdYearly,
  };

  // Authoritative amounts for all three options (bound Stripe price wins, then
  // the product's matching price, then the approved catalog amount).
  let amounts: Record<ProBillingInterval, number> = { ...PRO_PRICE_CENTS };
  try {
    amounts = await resolveProBillingAmounts(planBundle);
  } catch {
    // Keep the catalog amounts — the upgrade surface must always render.
  }

  const billingOptions = buildProBillingOptions(amounts);
  // The headline monthly number keeps its historical meaning (and its column).
  const monthly =
    billingOptions.find((option) => option.interval === "monthly") ?? fallback.billingOptions[1];

  const perks = Array.isArray(row.perks)
    ? row.perks.filter((p): p is string => Boolean(p && String(p).trim()))
    : [];

  return {
    key: row.key,
    name: row.name || fallback.name,
    priceCents: monthly.priceCents,
    priceUsd: monthly.priceUsd,
    badge: row.badge ?? null,
    perks: perks.length > 0 ? perks : fallback.perks,
    billingOptions,
  };
}

/**
 * Ensure a real Stripe Product + a recurring Price for each billing option
 * exists for every enabled plan. Idempotent — safe to run repeatedly, and it
 * never replaces a valid binding or creates a duplicate product.
 */
export async function syncAllSubscriptionPlansToStripe(): Promise<{
  count: number;
  results: Record<string, { productId: string; priceIds: StripePriceIds }>;
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
      stripePriceIdWeekly: tokenSubscriptionPlans.stripePriceIdWeekly,
      stripePriceIdYearly: tokenSubscriptionPlans.stripePriceIdYearly,
    })
    .from(tokenSubscriptionPlans)
    .where(eq(tokenSubscriptionPlans.enabled, true));

  const results: Record<string, { productId: string; priceIds: StripePriceIds }> = {};
  for (const row of rows) {
    results[row.key] = await ensureSubscriptionPlanStripe(row);
  }
  return { count: rows.length, results };
}

/**
 * Which billing option a Stripe Price id belongs to, from the plan catalog's
 * three bound price columns. Used by the webhook to label a subscription with
 * the interval it is ACTUALLY on (derived from its price, not from a payload
 * field). Returns null when the price isn't one of ours yet.
 */
export async function resolveBillingIntervalForPriceId(
  priceId: string | null | undefined,
): Promise<ProBillingInterval | null> {
  if (!priceId) return null;
  try {
    const [row] = await db
      .select({
        stripePriceId: tokenSubscriptionPlans.stripePriceId,
        stripePriceIdWeekly: tokenSubscriptionPlans.stripePriceIdWeekly,
        stripePriceIdYearly: tokenSubscriptionPlans.stripePriceIdYearly,
      })
      .from(tokenSubscriptionPlans)
      .where(eq(tokenSubscriptionPlans.key, CANONICAL_MEMBERSHIP_PLAN_KEY))
      .limit(1);
    if (!row) return null;
    if (row.stripePriceIdWeekly && row.stripePriceIdWeekly === priceId) return "weekly";
    if (row.stripePriceIdYearly && row.stripePriceIdYearly === priceId) return "yearly";
    if (row.stripePriceId && row.stripePriceId === priceId) return "monthly";
    return null;
  } catch (err) {
    console.error("[subscriptions] Failed to resolve the billing interval:", err);
    return null;
  }
}

/**
 * The subset of `clerkIds` that currently holds an ACTIVE GRYND PRO
 * subscription — the ONE place matchmaking asks about membership.
 *
 * This is deliberately a bulk, server-side read of `token_subscriptions`:
 *   * it is authoritative (the same table /api/membership/status reads, with
 *     the same ACTIVE_SUBSCRIPTION_STATUSES set), so a client can never grant
 *     itself Pro priority by submitting a flag;
 *   * it is fresh at match time, so a canceled/expired/failed subscription
 *     stops receiving priority immediately;
 *   * it is one query for a whole queue batch, not one per candidate.
 *
 * Fails CLOSED: an unreadable table means "nobody is a member for this pass",
 * so a database blip can never hand out paid priority.
 */
export async function getActiveMemberIds(
  clerkIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(clerkIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Set();
  try {
    const rows = await db
      .selectDistinct({ clerkId: tokenSubscriptions.clerkId })
      .from(tokenSubscriptions)
      .where(
        and(
          inArray(tokenSubscriptions.clerkId, ids),
          inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
        ),
      );
    return new Set(rows.map((row) => row.clerkId));
  } catch (err) {
    console.error("[subscriptions] Failed to read active members:", err);
    return new Set();
  }
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

