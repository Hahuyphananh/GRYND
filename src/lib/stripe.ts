// src/lib/stripe.ts
//
// Stripe client + webhook secret accessors. Secrets come from env vars only
// (never from source or logs). The SDK when instantiated without an explicit
// apiVersion pins the latest API version, per Stripe best practices.
//
// Security model:
//   * STRIPE_SECRET_KEY should be a RESTRICTED key (rk_...) with minimal
//     permissions, split per environment, stored as a Vercel sensitive env
//     var. Recommend switching off the sk_ secret key once the RAK works.
//   * STRIPE_WEBHOOK_SECRET signs/verified via stripe.webhooks.constructEvent.

import Stripe from "stripe";

let stripeInstance: Stripe | null = null;

/**
 * Lazily-instantiated Stripe client. Throws if STRIPE_SECRET_KEY is missing
 * so the app fails closed (never silently works without a key).
 */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.trim()) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!stripeInstance) {
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

/**
 * The webhook signing secret. Returns null when unset so the webhook route
 * can fail closed with a clear 503 instead of crashing.
 */
export function getStripeWebhookSecret(): string | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  return secret && secret.trim().length > 0 ? secret.trim() : null;
}

/** Base URL for checkout success/cancel redirects. */
export function getBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(
    /\/+$/,
    ""
  );
}
