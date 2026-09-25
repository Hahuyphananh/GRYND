// src/app/api/stripe/portal/route.ts
//
// POST — create a Stripe Customer Portal session for the authenticated user's
// active subscription. Lets subscribers update their payment method, cancel,
// or change billing details without contacting support.
//
// Security:
//   * auth-required,
//   * the portal session is created for the caller's OWN customer id (looked
//     up from their subscription row) — one user can never open another's
//     billing portal,
//   * the user returns to /upgrade-pro after managing.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getStripe, getBaseUrl } from "../../../../lib/stripe";
import { findActiveSubscription } from "../../../../lib/stripe/subscriptions";

export const runtime = "nodejs";

export async function POST() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const subscription = await findActiveSubscription(clerkId);
  if (!subscription || !subscription.customerId) {
    return NextResponse.json(
      { success: false, error: "No active subscription" },
      { status: 404 }
    );
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return NextResponse.json(
      { success: false, error: "Base URL is not configured" },
      { status: 500 }
    );
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: "Stripe is not configured" },
      { status: 503 }
    );
  }

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: subscription.customerId,
      return_url: `${baseUrl}/upgrade-pro`,
    });
    return NextResponse.json({ success: true, url: session.url ?? null });
  } catch (err) {
    console.error("[stripe/portal] Failed to create portal session:", err);
    return NextResponse.json(
      { success: false, error: "Could not open subscription management." },
      { status: 500 }
    );
  }
}
