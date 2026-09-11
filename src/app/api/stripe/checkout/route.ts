// src/app/api/stripe/checkout/route.ts
//
// POST — create a Stripe Checkout Session for a token top-up.
//
// Server-authoritative only:
//   * authenticates the caller (Clerk),
//   * resolves the price/token amount from the `token_packages` catalog on
//     the server (the client can only pass a `packageKey`, never an amount),
//   * persists a `stripe_checkout_sessions` ledger row BEFORE redirecting,
//     so the webhook always has an idempotency target,
//   * returns the Stripe-hosted Checkout URL (no card data touches Grynd).
//
// Handle asynchronous fulfillment in the webhook, not on the success page.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { tokenPackages, stripeCheckoutSessions } from "../../../../db/schema";
import { getStripe, getBaseUrl } from "../../../../lib/stripe";
import { ensurePackageStripe } from "../../../../lib/stripe/packages";
import { auditLog } from "../../../../lib/security/auditLog";
import { parseAndValidateJson } from "../../../../lib/security/validation";

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

  // Strict allowlist: `packageKey` is the ONLY field a client may send. The
  // price/token amount is always resolved server-side from the catalog — a
  // body that tries to smuggle amount, tokens, priceCents, or a userId is
  // rejected instead of partially read.
  const parsed = await parseAndValidateJson(req, {
    packageKey: { type: "string", required: true, minLength: 1, maxLength: 100 },
  });
  if (!parsed.ok) return parsed.response;

  const packageKey = parsed.data.packageKey;

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: "Stripe is not configured" },
      { status: 503 }
    );
  }

  const pkg = await db
    .select()
    .from(tokenPackages)
    .where(eq(tokenPackages.key, packageKey))
    .limit(1)
    .then((rows) => rows[0]);

  if (!pkg || !pkg.enabled) {
    return NextResponse.json(
      { success: false, error: "Unknown or disabled package" },
      { status: 404 }
    );
  }

  // One-time-only offers: a user may buy this package at most once. The gate
  // is the fulfilled ledger row (tokens actually credited), so an abandoned
  // or failed checkout never blocks a retry. The race window between two
  // concurrent checkouts is tiny and the webhook credit is per-session.
  if (pkg.oneTime) {
    const prior = await db
      .select({ id: stripeCheckoutSessions.id })
      .from(stripeCheckoutSessions)
      .where(
        and(
          eq(stripeCheckoutSessions.clerkId, clerkId),
          eq(stripeCheckoutSessions.packageKey, pkg.key),
          eq(stripeCheckoutSessions.fulfilled, true)
        )
      )
      .limit(1);

    if (prior[0]) {
      auditLog("stripe_one_time_repeat_attempt", {
        userId: clerkId,
        packageKey: pkg.key,
      });
      return NextResponse.json(
        { success: false, error: "This offer can only be purchased once." },
        { status: 409 }
      );
    }
  }

  // Total tokens awarded = base + optional bonus. Frozen at purchase time and
  // stored on the ledger row so webhook fulfillment always credits exactly
  // what the customer paid for, even if the package config changes later.
  const bonusTokens = Number(pkg.bonusTokens ?? 0);
  const awardedTokens = Number(pkg.tokenAmount) + bonusTokens;

  // Ensure the package has a real Stripe Product + one-time Price, creating and
  // persisting both lazily on first purchase. Every sale then references the
  // server-side price (never a client-trusted inline amount).
  let resolvedPriceId: string;
  try {
    resolvedPriceId = (
      await ensurePackageStripe({
        id: pkg.id,
        key: pkg.key,
        name: pkg.name,
        priceCents: pkg.priceCents,
        stripeProductId: pkg.stripeProductId,
        stripePriceId: pkg.stripePriceId,
      })
    ).priceId;
  } catch (err) {
    console.error("[stripe/checkout] Failed to ensure package price:", err);
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

  // Managed Payments is enabled by default on the account and is the merchant
  // of record for Grynd's digital products. Every product now carries an
  // eligible tax code (txcd_10103100 — see packages.ts), so the session runs
  // WITH Managed Payments enabled: `managed_payments[enabled]=true`. Stripe
  // handles sales tax, VAT/GST, fraud, disputes, and support for the
  // transaction. The session is created as a one-time `payment` checkout.
  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      // Omitted by design: dynamic payment methods selected by Stripe.
      client_reference_id: clerkId,
      metadata: { clerkId, packageKey: pkg.key },
      success_url: `${baseUrl}/shop?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/shop?checkout=cancelled`,
      allow_promotion_codes: true,
      managed_payments: { enabled: true },
      integration_identifier: `grynd_checkout_${randomSuffix()}`,
    });
  } catch (err) {
    console.error("[stripe/checkout] Failed to create checkout session:", err);
    return NextResponse.json(
      { success: false, error: "Could not start checkout. Please try again." },
      { status: 502 }
    );
  }

  // Persist the ledger row before redirecting so the webhook can fulfil it
  // idempotently. `session_id` is the durable idempotency key.
  await db
    .insert(stripeCheckoutSessions)
    .values({
      sessionId: session.id,
      clerkId,
      packageKey: pkg.key,
      tokenAmount: awardedTokens,
      amountCents: pkg.priceCents,
      currency: "usd",
      paymentStatus: "open",
      fulfilled: false,
    })
    .onConflictDoNothing({ target: stripeCheckoutSessions.sessionId });

  auditLog("stripe_checkout_created", {
    userId: clerkId,
    packageKey: pkg.key,
    awardedTokens,
    amountCents: pkg.priceCents,
    sessionId: session.id,
  });

  return NextResponse.json({ success: true, url: session.url ?? null });
}
