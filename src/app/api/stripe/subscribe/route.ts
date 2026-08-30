// src/app/api/stripe/subscribe/route.ts
//
// POST — start a Stripe Checkout Session for a Grynd+ token subscription.
//
// Server-authoritative only (mirrors /api/stripe/checkout):
//   * authenticates the caller (Clerk),
//   * resolves the plan from the `token_subscription_plans` catalog on the
//     server (the client can only pass a `planKey`),
//   * enforces ONE active subscription per user,
//   * persists a `stripe_checkout_sessions` ledger row BEFORE redirecting so
//     the return-to-shop confirmation (/api/stripe/session-status) has a
//     target, and the audit trail is complete,
//   * returns the Stripe-hosted Checkout URL.
//
// Tokens are NEVER granted at checkout: each paid invoice (starting with the
// first) is credited monthly by the webhook, idempotent on the invoice id.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { tokenSubscriptionPlans, stripeCheckoutSessions } from "../../../../db/schema";
import { getStripe, getBaseUrl } from "../../../../lib/stripe";
import {
  ensureSubscriptionPlanStripe,
  findActiveSubscription,
} from "../../../../lib/stripe/subscriptions";
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

  let body: { planKey?: unknown };
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const planKey = typeof body?.planKey === "string" ? body.planKey.trim() : "";
  if (!planKey) {
    return NextResponse.json({ success: false, error: "planKey is required" }, { status: 400 });
  }

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

  if (!plan || !plan.enabled) {
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

  // Ensure the plan has a real Stripe Product + recurring monthly Price,
  // creating and persisting both lazily on first subscribe.
  let resolvedPriceId: string;
  try {
    resolvedPriceId = (
      await ensureSubscriptionPlanStripe({
        id: plan.id,
        key: plan.key,
        name: plan.name,
        monthlyTokens: Number(plan.monthlyTokens),
        priceCents: plan.priceCents,
        stripeProductId: plan.stripeProductId,
        stripePriceId: plan.stripePriceId,
      })
    ).priceId;
  } catch (err) {
    console.error("[stripe/subscribe] Failed to ensure plan price:", err);
    return NextResponse.json(
      { success: false, error: "Stripe is not configured correctly" },
      { status: 503 }
    );
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return NextResponse.json(
      { success: false, error: "Base URL is not configured" },
      { status: 500 }
    );
  }

  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: resolvedPriceId, quantity: 1 }],
    // Omitted by design: dynamic payment methods selected by Stripe.
    client_reference_id: clerkId,
    metadata: { clerkId, planKey: plan.key },
    // Carried onto the Subscription object so the webhook can map every paid
    // invoice back to the plan (and user) without trusting the payload.
    subscription_data: { metadata: { clerkId, planKey: plan.key } },
    success_url: `${baseUrl}/shop?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/shop?checkout=cancelled`,
    allow_promotion_codes: true,
    // Same Managed Payments opt-out as checkout: the app collects no tax and
    // plans may lack a tax_code, which Managed Payments would reject.
    managed_payments: { enabled: false },
    integration_identifier: `grynd_subscribe_${randomSuffix()}`,
  });

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
      amountCents: plan.priceCents,
      currency: "usd",
      paymentStatus: "open",
      fulfilled: false,
    })
    .onConflictDoNothing({ target: stripeCheckoutSessions.sessionId });

  auditLog("stripe_subscription_checkout_created", {
    userId: clerkId,
    planKey: plan.key,
    sessionId: session.id,
    amountCents: plan.priceCents,
  });

  return NextResponse.json({ success: true, url: session.url ?? null });
}
