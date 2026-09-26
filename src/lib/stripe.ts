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

/**
 * A configured or header-supplied URL reduced to its comparable hostname:
 * lowercased, without a leading `www.` (www and apex are the same site) and
 * without a port. Returns null when the value isn't a URL we can read.
 */
function comparableHostname(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The origin the current request was actually served on, or null when the
 * host headers are missing. Proxy headers win over `host` because that is what
 * the visitor's browser really addressed once a platform proxy rewrote it.
 */
function requestOrigin(req: { headers?: Headers } | undefined): string | null {
  const headers = req?.headers;
  if (!headers || typeof headers.get !== "function") return null;
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "")
    .split(",")[0]
    .trim();
  if (!host) return null;
  const proto = (headers.get("x-forwarded-proto") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  try {
    // Round-tripping through URL normalises the host (case, default ports) and
    // rejects a header value that isn't a host at all.
    return new URL(`${proto === "http" ? "http" : "https"}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Base URL to send a customer back to after Stripe (checkout success, the
 * Checkout back button, the billing portal's return link).
 *
 * The configured `NEXT_PUBLIC_BASE_URL` remains the authority — but a customer
 * who started checkout on this origin must come back to THIS origin, so a
 * request origin that is the same site (www/apex and port differences ignored)
 * is preferred over it. That keeps staging/preview/localhost flows inside
 * staging/preview/localhost instead of bouncing a returning customer off to a
 * different host (where the /upgrade-pro path can be lost to an unrelated
 * redirect further up the stack).
 *
 * The Host header is attacker-controlled, so it is only ever accepted when it
 * matches the configured site — a spoofed Host can never turn our Stripe
 * redirect URLs into an open redirect. When no site is configured at all the
 * request origin is the only absolute origin available, so it is used.
 */
export function getReturnBaseUrl(req?: { headers?: Headers }): string {
  const configured = getBaseUrl();
  const origin = requestOrigin(req);

  if (origin) {
    const configuredHost = comparableHostname(configured);
    const originHost = comparableHostname(origin);
    if (originHost && (configuredHost === null || originHost === configuredHost)) {
      return origin;
    }
  }

  return configured;
}
