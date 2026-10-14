// src/app/api/stripe/change-plan/route.ts
//
// POST — switch an EXISTING GRYND PRO subscription to a different billing
// interval (weekly / monthly / yearly). Every interval grants the same `pro`
// entitlement, so this changes WHEN the member is billed, never WHAT they get.
//
// Safety model (deliberately conservative — a billing change is destructive):
//   * auth-required;
//   * the caller must own an ACTIVE subscription (resolved server-side from
//     their own row), and the Stripe subscription's `clerkId` metadata is
//     re-checked, so nobody can move someone else's subscription;
//   * the client sends ONLY an interval. The server resolves the approved
//     Stripe Price for it — a client can never supply a price id or an amount;
//   * it UPDATES the single existing subscription item. It never creates a
//     second subscription, so the one-active-subscription rule holds;
//   * proration is explicit (`create_prorations`): Stripe credits the unused
//     time on the old price and bills the prorated difference on the next
//     invoice. No hidden charge, no double billing;
//   * `cancel_at_period_end` is cleared, so changing plan also un-cancels.
//
// The Stripe webhook remains the source of truth for the subscription row; the
// local `billing_interval` update here only keeps the UI honest until the
// `customer.subscription.updated` delivery lands.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { tokenSubscriptionPlans, tokenSubscriptions } from "../../../../db/schema";
import { getStripe } from "../../../../lib/stripe";
import {
  CANONICAL_MEMBERSHIP_PLAN_KEY,
  ensureSubscriptionPlanStripe,
  findActiveSubscription,
} from "../../../../lib/stripe/subscriptions";
import { isProBillingInterval } from "../../../../lib/proBilling";
import { BASE_CURRENCY } from "../../../../lib/currency";
import { auditLog } from "../../../../lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: "Stripe is not configured" },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  if (!isProBillingInterval(body?.interval)) {
    return NextResponse.json(
      { success: false, error: "A valid billing interval is required" },
      { status: 400 },
    );
  }
  const interval = body.interval;

  // The caller must already be an active member — changing plan is not a way to
  // start one (that is /api/stripe/subscribe).
  const subscription = await findActiveSubscription(clerkId);
  if (!subscription || subscription.clerkId !== clerkId) {
    return NextResponse.json(
      { success: false, error: "No active subscription" },
      { status: 404 },
    );
  }

  // Resolve the catalog plan and its three approved prices (idempotent — this
  // reuses the persisted bindings and creates only a genuinely missing one).
  const plan = await db
    .select()
    .from(tokenSubscriptionPlans)
    .where(eq(tokenSubscriptionPlans.key, CANONICAL_MEMBERSHIP_PLAN_KEY))
    .limit(1)
    .then((rows) => rows[0]);

  if (!plan || !plan.enabled || plan.key !== CANONICAL_MEMBERSHIP_PLAN_KEY) {
    return NextResponse.json({ success: false, error: "Plan is unavailable" }, { status: 404 });
  }

  let targetPriceId: string;
  try {
    const { priceIds } = await ensureSubscriptionPlanStripe({
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
    const resolved = priceIds[interval];
    if (!resolved) throw new Error(`No Stripe price resolved for the ${interval} option`);
    targetPriceId = resolved;
  } catch (err) {
    console.error("[stripe/change-plan] Failed to resolve the target price:", err);
    return NextResponse.json(
      { success: false, error: "Stripe is not configured correctly" },
      { status: 503 },
    );
  }

  const stripe = getStripe();

  let stripeSubscription;
  try {
    stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripeSubscriptionId,
    );
  } catch (err) {
    console.error("[stripe/change-plan] Failed to read the Stripe subscription:", err);
    return NextResponse.json(
      { success: false, error: "Could not reach Stripe. Please try again." },
      { status: 502 },
    );
  }

  // Defence in depth: the Stripe object must also belong to the caller.
  if (
    stripeSubscription.metadata?.clerkId &&
    stripeSubscription.metadata.clerkId !== clerkId
  ) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const item = stripeSubscription.items?.data?.[0];
  if (!item) {
    return NextResponse.json(
      { success: false, error: "Subscription has no billable item" },
      { status: 409 },
    );
  }
  const currentPriceId =
    typeof item.price === "string" ? item.price : (item.price?.id ?? null);

  if (currentPriceId === targetPriceId) {
    return NextResponse.json({ success: true, alreadyOnPlan: true, interval });
  }

  // A subscription's currency is fixed at creation and every option is priced
  // in it (base or a `currency_options` entry). Switching intervals must stay
  // inside that currency, so verify the target price is priced in it before
  // moving the item — Stripe's own error for this is opaque, and this is the
  // one case a per-currency configuration can produce (an option configured on
  // one price but not another).
  const subscriptionCurrency = String(stripeSubscription.currency || BASE_CURRENCY)
    .toLowerCase();
  try {
    const target = await stripe.prices.retrieve(targetPriceId);
    const pricedInTargetCurrency =
      String(target.currency || "").toLowerCase() === subscriptionCurrency ||
      Number.isFinite(
        Number(target.currency_options?.[subscriptionCurrency]?.unit_amount),
      );
    if (!pricedInTargetCurrency) {
      return NextResponse.json(
        {
          success: false,
          error: "That billing option isn't available in your subscription's currency.",
        },
        { status: 409 },
      );
    }
  } catch (err) {
    console.error("[stripe/change-plan] Failed to verify the target price currency:", err);
    return NextResponse.json(
      { success: false, error: "Could not reach Stripe. Please try again." },
      { status: 502 },
    );
  }

  try {
    // ONE item on ONE subscription is moved. Proration is explicit and the
    // subscription is never cancelled/recreated (which would risk a duplicate).
    const updated = await stripe.subscriptions.update(
      subscription.stripeSubscriptionId,
      {
        items: [{ id: item.id, price: targetPriceId }],
        proration_behavior: "create_prorations",
        cancel_at_period_end: false,
        metadata: {
          clerkId,
          planKey: CANONICAL_MEMBERSHIP_PLAN_KEY,
          billingInterval: interval,
        },
      },
    );

    // Keep the mirror row accurate until the webhook's `subscription.updated`
    // delivery (which is the source of truth) confirms it.
    await db
      .update(tokenSubscriptions)
      .set({
        planKey: CANONICAL_MEMBERSHIP_PLAN_KEY,
        billingInterval: interval,
        updatedAt: new Date(),
      })
      .where(eq(tokenSubscriptions.stripeSubscriptionId, subscription.stripeSubscriptionId));

    auditLog("stripe_subscription_interval_changed", {
      userId: clerkId,
      subscriptionId: subscription.stripeSubscriptionId,
      interval,
    });

    return NextResponse.json({
      success: true,
      interval,
      status: updated.status,
      currentPeriodEnd: updated.items?.data?.[0]?.current_period_end
        ? new Date(updated.items.data[0].current_period_end * 1000).toISOString()
        : null,
    });
  } catch (err) {
    console.error("[stripe/change-plan] Failed to change the billing interval:", err);
    return NextResponse.json(
      { success: false, error: "Could not change your billing interval. Please try again." },
      { status: 500 },
    );
  }
}
