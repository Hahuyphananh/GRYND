// src/app/api/stripe/subscribe/route.ts
//
// POST — start a Stripe Checkout Session for the GRYND PRO subscription.
//
// Server-authoritative only (mirrors /api/stripe/checkout):
//   * authenticates the caller (Clerk),
//   * resolves the plan from the `token_subscription_plans` catalog on the
//     server (the client can only pass a `planKey`), and only the single
//     canonical GRYND PRO plan is purchasable,
//   * enforces ONE active subscription per user,
//   * persists a `stripe_checkout_sessions` ledger row BEFORE redirecting so
//     the return-to-/upgrade-pro confirmation (/api/stripe/session-status) has
//     a target, and the audit trail is complete,
//   * returns the Stripe-hosted Checkout URL.
//
// NO TOKENS: GRYND has no token currency and GRYND PRO grants no monthly
// tokens — the webhook only records the membership lifecycle.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { tokenSubscriptionPlans, stripeCheckoutSessions } from "../../../../db/schema";
import { getStripe, getReturnBaseUrl } from "../../../../lib/stripe";
import { createBrandedCheckoutSession } from "../../../../lib/stripe/checkoutBranding";
import {
  CANONICAL_MEMBERSHIP_PLAN_KEY,
  ensureSubscriptionPlanStripe,
  findActiveSubscription,
} from "../../../../lib/stripe/subscriptions";
import {
  PRO_PRICE_CENTS,
  defaultPriceCentsFor,
  isProBillingInterval,
  type ProBillingInterval,
} from "../../../../lib/proBilling";
import { auditLog } from "../../../../lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 8 random lowercase letters suffix for the checkout integration_identifier. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).toLowerCase();
}

export async function POST(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { planKey?: unknown; interval?: unknown };
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const planKey = typeof body?.planKey === "string" ? body.planKey.trim() : "";
  if (!planKey) {
    return NextResponse.json({ success: false, error: "planKey is required" }, { status: 400 });
  }

  // The client may only request a BILLING INTERVAL; the server resolves the
  // approved Stripe Price for it. A missing interval defaults to monthly, so a
  // stale client (one shipped before the three-interval catalog) still checks
  // out on the original monthly price instead of erroring.
  const interval: ProBillingInterval = isProBillingInterval(body?.interval)
    ? body.interval
    : "monthly";

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: "Stripe is not configured" },
      { status: 503 }
    );
  }

  const plan = await db
    .select()
    .from(tokenSubscriptionPlans)
    .where(eq(tokenSubscriptionPlans.key, planKey))
    .limit(1)
    .then((rows) => rows[0]);

  // Only the single canonical GRYND PRO plan is purchasable. Legacy plan keys
  // (grynd-plus / grynd-high-roller) are disabled in the catalog; this check
  // is belt-and-braces so a stale client can never start a legacy checkout.
  if (!plan || !plan.enabled || plan.key !== CANONICAL_MEMBERSHIP_PLAN_KEY) {
    return NextResponse.json(
      { success: false, error: "Unknown or disabled plan" },
      { status: 404 }
    );
  }

  // One active subscription per user — resubscribing is only possible after
  // the current one is canceled (or lapses).
  const existing = await findActiveSubscription(clerkId);
  if (existing) {
    return NextResponse.json(
      { success: false, error: "You already have an active subscription." },
      { status: 409 }
    );
  }

  // Ensure the plan has a real Stripe Product + a recurring Price for EVERY
  // billing option, creating only what is missing, then use the price for the
  // interval the caller asked for. The persisted ids are reused, so this is
  // idempotent across checkouts.
  let resolvedPriceId: string;
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
    const priceId = priceIds[interval];
    if (!priceId) {
      throw new Error(`No Stripe price resolved for the ${interval} option`);
    }
    resolvedPriceId = priceId;
  } catch (err) {
    console.error("[stripe/subscribe] Failed to ensure plan price:", err);
    return NextResponse.json(
      { success: false, error: "Stripe is not configured correctly" },
      { status: 503 }
    );
  }

  // The amount this checkout charges. The price we just resolved is verified
  // against the approved catalog amount for the interval, so this is the
  // authoritative figure — never a client-supplied one.
  const amountCents = PRO_PRICE_CENTS[interval] ?? defaultPriceCentsFor(interval);

  // The origin the customer is checking out FROM, so every return path lands
  // back on the same app they left (never a different host's homepage).
  const baseUrl = getReturnBaseUrl(req);
  if (!baseUrl) {
    return NextResponse.json(
      { success: false, error: "Base URL is not configured" },
      { status: 500 }
    );
  }

  const stripe = getStripe();

  const session = await createBrandedCheckoutSession(
    stripe,
    {
      mode: "subscription",
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      // Omitted by design: dynamic payment methods selected by Stripe.
      client_reference_id: clerkId,
      metadata: { clerkId, planKey: plan.key, billingInterval: interval },
      // Carried onto the Subscription object so the webhook can map every paid
      // invoice back to the plan (and user) without trusting the payload.
      subscription_data: {
        metadata: { clerkId, planKey: plan.key, billingInterval: interval },
      },
      success_url: `${baseUrl}/upgrade-pro?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      // The Checkout back button is `cancel_url` (Stripe: "If set, Checkout
      // displays a back button and customers will be directed to this URL" —
      // see the create-session reference). It must therefore always be the
      // GRYND PRO page, which is where the "checkout cancelled" notice lives.
      cancel_url: `${baseUrl}/upgrade-pro?checkout=cancelled`,
      allow_promotion_codes: true,
      // Managed Payments is enabled by default on the account and is the
      // merchant of record for Grynd subscriptions too (plans are created via
      // Checkout, which Managed Payments supports). The plan product now
      // carries the eligible tax code txcd_10103100 (see subscriptions.ts), so
      // the recurring checkout runs WITH Managed Payments enabled.
      managed_payments: { enabled: true },
      integration_identifier: `grynd_subscribe_${randomSuffix()}`,
    },
    baseUrl
  );

  // Persist the ledger row before redirecting. `token_amount` is 0 on purpose
  // — subscription tokens are granted per paid invoice, never at checkout.
  await db
    .insert(stripeCheckoutSessions)
    .values({
      sessionId: session.id,
      clerkId,
      packageKey: plan.key,
      sessionMode: "subscription",
      tokenAmount: 0,
      amountCents,
      currency: "usd",
      paymentStatus: "open",
      fulfilled: false,
    })
    .onConflictDoNothing({ target: stripeCheckoutSessions.sessionId });

  auditLog("stripe_subscription_checkout_created", {
    userId: clerkId,
    planKey: plan.key,
    billingInterval: interval,
    sessionId: session.id,
    amountCents,
  });

  return NextResponse.json({ success: true, url: session.url ?? null });
}
