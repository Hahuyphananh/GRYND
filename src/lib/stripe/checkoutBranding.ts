// src/lib/stripe/checkoutBranding.ts
//
// GRYND's own look applied to the Stripe-hosted Checkout page.
//
// Checkout is a page Stripe renders on its own domain, so the only way to make
// it match the app is the `branding_settings` parameter (API 2025-09-30.clover
// and later; supported by the `stripe` SDK this repo pins). It controls the
// backdrop, the confirmation button, the corner style, the font, the name at
// the top of the page and the icon — not the layout.
//
// The palette is the same one every GRYND PRO surface already uses
// (UpgradeProContent.tsx, /upgrade-pro, globals.css):
//
//   deep navy backdrop   #071536   mid stop of the app's page gradient
//   brand yellow         #f5ff3b   same fill as the "Upgrade to GRYND PRO" CTA
//   rounded corners                the app's rounded-xl / rounded-2xl language
//   Inter                          closest supported UI face (the app's Orbitron
//                                  display face is not in Stripe's font list)
//
// Stripe validates these values (the icon URL must be publicly reachable, the
// colours must be legible together) and the rules are per-account and can
// change. A rejected brand value must NEVER stop a customer from paying, so
// `createBrandedCheckoutSession` degrades in steps instead of failing.

import type Stripe from "stripe";

/** The design tokens shared with the rest of the GRYND PRO surfaces. */
export const CHECKOUT_BRAND = {
  /** Top-of-page name. The plan is the product, so the page says so. */
  displayName: "GRYND PRO",
  /** Deep navy — reads as "the GRYND app", not as a stock Stripe form. */
  backgroundColor: "#071536",
  /** Brand yellow with dark text, matching the in-app upgrade CTA. */
  buttonColor: "#f5ff3b",
  /** The app's corner language. */
  borderStyle: "rounded",
  /** Modern UI face; Orbitron isn't in Stripe's supported font families. */
  fontFamily: "inter",
  /** Square app icon, already served from our own /public. */
  iconPath: "/icon-192.png",
} as const;

/**
 * The Checkout Session branding for our own site origin.
 *
 * The icon is only attached when `baseUrl` is an absolute URL: Stripe fetches
 * the image itself at render time, so a relative path (or an empty origin)
 * would be a guaranteed rejection — better to brand the colours than to fail.
 */
export function getCheckoutBranding(
  baseUrl: string,
): Stripe.Checkout.SessionCreateParams.BrandingSettings {
  const branding: Stripe.Checkout.SessionCreateParams.BrandingSettings = {
    display_name: CHECKOUT_BRAND.displayName,
    background_color: CHECKOUT_BRAND.backgroundColor,
    button_color: CHECKOUT_BRAND.buttonColor,
    border_style: CHECKOUT_BRAND.borderStyle,
    font_family: CHECKOUT_BRAND.fontFamily,
  };

  if (/^https?:\/\//i.test(baseUrl)) {
    branding.icon = {
      type: "url",
      url: `${baseUrl.replace(/\/+$/, "")}${CHECKOUT_BRAND.iconPath}`,
    };
  }

  return branding;
}

/**
 * True when retrying without our branding is the safe next step.
 *
 * Stripe doesn't always label a rejected brand value as a branding problem — a
 * bad icon URL comes back as a plain invalid-request error — and treating one
 * as fatal would leave the customer on a page they cannot pay on. So an
 * invalid-request error is assumed possibly-branding and retried without it.
 * The fallback sends the caller's own parameters (byte-for-byte what these
 * routes sent before branding existed), and if it fails too its error is
 * rethrown: a genuine failure is never masked, it just costs one extra call.
 *
 * Duck-typed on purpose: the Stripe error classes are not stable across SDK
 * majors, but the `StripeInvalidRequestError` name/type and the offending
 * parameter name always are.
 */
function isBrandingRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, type, message, param } = err as {
    name?: string;
    type?: string;
    message?: string;
    param?: string;
  };
  if (name === "StripeInvalidRequestError" || type === "StripeInvalidRequestError") {
    return true;
  }
  return /branding/i.test(`${message ?? ""} ${param ?? ""}`);
}

/**
 * Create a Checkout Session with the GRYND branding applied.
 *
 * Degradation ladder (each step only runs after Stripe rejected the previous
 * one, so a healthy account always gets the fully branded page):
 *
 *   1. full branding (colours + font + rounded corners + icon),
 *   2. branding without the remote icon (the most common rejection: an
 *      unreachable or oversized image),
 *   3. the caller's plain parameters — an unbranded page beats no page.
 *
 * A non-branding failure is rethrown from whichever attempt hit it, so the
 * route still reports real Stripe problems honestly.
 */
export async function createBrandedCheckoutSession(
  stripe: Stripe,
  params: Stripe.Checkout.SessionCreateParams,
  baseUrl: string,
): Promise<Stripe.Checkout.Session> {
  const branding = getCheckoutBranding(baseUrl);

  try {
    return await stripe.checkout.sessions.create({
      ...params,
      branding_settings: branding,
    });
  } catch (err) {
    if (!isBrandingRetryable(err)) throw err;
    console.error("[stripe/checkout] Branding with icon rejected, retrying:", err);
  }

  const withoutIcon: Stripe.Checkout.SessionCreateParams.BrandingSettings = {
    ...branding,
  };
  delete withoutIcon.icon;

  try {
    return await stripe.checkout.sessions.create({
      ...params,
      branding_settings: withoutIcon,
    });
  } catch (err) {
    if (!isBrandingRetryable(err)) throw err;
    console.error("[stripe/checkout] Branding rejected entirely, using Stripe's defaults:", err);
  }

  return stripe.checkout.sessions.create(params);
}
