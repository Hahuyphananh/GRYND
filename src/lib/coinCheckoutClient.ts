// src/lib/coinCheckoutClient.ts
//
// Client-safe helpers for the coin shop. NO server imports (no DB, no Stripe
// SDK), so a client component can use them and a unit test can exercise them
// directly.
//
// Two jobs:
//   * parse the return query after Stripe Checkout, and
//   * refuse to navigate anywhere except a real Stripe Checkout host.
//
// Neither helper decides anything about money or coins — the server owns that.

/**
 * How often the return-from-Checkout screen asks the server whether the
 * purchase has been fulfilled.
 */
export const COIN_CHECKOUT_POLL_INTERVAL_MS = 2_000;

/** Give up (and offer a manual retry) after this many polls. */
export const COIN_CHECKOUT_MAX_POLLS = 20;

export type CheckoutReturnState = {
  /** True when this page load came back from Checkout. */
  returned: boolean;
  /** True when the customer used the Back/cancel path. */
  cancelled: boolean;
  /** The Checkout Session id to confirm, when the return carried a valid one. */
  sessionId: string | null;
};

/**
 * Read `?checkout=success|cancelled&session_id=cs_…`.
 *
 * Only a `cs_…` shaped id is accepted. The id is never trusted for anything but
 * polling our own authenticated `/api/stripe/session-status`, which answers only
 * for the caller's own sessions — so a forged id can reveal nothing.
 */
export function parseCheckoutReturn(search: string): CheckoutReturnState {
  const EMPTY: CheckoutReturnState = { returned: false, cancelled: false, sessionId: null };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search ?? "");
  } catch {
    return EMPTY;
  }

  const checkout = params.get("checkout");
  if (checkout === "cancelled") {
    return { returned: true, cancelled: true, sessionId: null };
  }
  if (checkout !== "success") return EMPTY;

  const rawSessionId = params.get("session_id") ?? "";
  const sessionId = /^cs_[A-Za-z0-9_]+$/.test(rawSessionId) ? rawSessionId : null;

  return { returned: true, cancelled: false, sessionId };
}

/**
 * True only for an `https://` URL on Stripe's own domain (or a subdomain).
 *
 * The server returns this URL, and it is still validated before navigation: an
 * `http://`, a look-alike (`stripe.com.evil.example`) or a `javascript:` URL is
 * never followed. That keeps the redirect constrained to Stripe even if a
 * response were ever tampered with or misconfigured.
 */
export function isTrustedStripeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "stripe.com" || host.endsWith(".stripe.com");
}

/**
 * Should the confirmation screen keep polling? Stops on fulfilment and after
 * `COIN_CHECKOUT_MAX_POLLS` attempts, so a slow webhook can never leave the page
 * polling forever.
 */
export function shouldPollCheckout(attempts: number, fulfilled: boolean): boolean {
  if (fulfilled) return false;
  return Number(attempts) < COIN_CHECKOUT_MAX_POLLS;
}
