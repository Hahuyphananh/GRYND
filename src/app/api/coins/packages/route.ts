// src/app/api/coins/packages/route.ts
//
// GET — the public coin-shop catalog. READ-ONLY.
//
// It answers exactly one question: "may this visitor be shown coin offers, and
// if so, which ones at what price?" It NEVER creates a Stripe product, price,
// Checkout Session or balance movement.
//
// GATING (see src/lib/coinPurchases.ts):
//   * when COIN_PURCHASES_ENABLED is not exactly "1" the response is
//     `enabled: false` with an EMPTY offer list — the flag is off by default in
//     every environment, so the Shop surface renders nothing;
//   * `checkoutReady: false` means a purchase cannot be started at all yet (the
//     webhook cannot credit a one-time session), so even with the flag on the
//     client has no active purchase action to show.
//
// There is intentionally NO POST handler here and no /api/stripe/checkout
// route: payment fulfilment is not implemented yet, so nothing in this feature
// can take money. When it ships, the session creator belongs in a POST on this
// route (authenticated, catalog-resolved price, `mode: "payment"`, one
// `stripe_checkout_sessions` ledger row) and the credit belongs in the signed
// webhook — never in the client.
//
// AUTH: none required to READ the catalog (it is public marketing data, like
// /api/membership/status). Any future purchase action must authenticate.

import { NextResponse } from "next/server";
import {
  COIN_CHECKOUT_READY,
  COIN_PACKAGE_CURRENCY,
  isCoinPurchasesEnabled,
  resolveCoinOffers,
} from "../../../../lib/coinPurchases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Feature flag FIRST: a disabled deployment does no database work and never
  // exposes an offer the UI could turn into an action.
  if (!isCoinPurchasesEnabled()) {
    return NextResponse.json({
      success: true,
      enabled: false,
      checkoutReady: false,
      currency: COIN_PACKAGE_CURRENCY,
      offers: [],
    });
  }

  try {
    const { offers, currency, skipped } = await resolveCoinOffers();
    if (skipped.length > 0) {
      // Not an error: a disabled or malformed row is simply not for sale. Log
      // it so a catalog mistake is visible to an operator.
      console.warn(
        "[coins/packages] catalog rows not offered:",
        skipped.map((row) => `${row.key}: ${row.reason}`).join(", "),
      );
    }
    return NextResponse.json({
      success: true,
      enabled: true,
      checkoutReady: COIN_CHECKOUT_READY,
      currency,
      offers,
    });
  } catch (err) {
    // Fail closed: an unreadable catalog means "show nothing", never a
    // half-resolved price.
    console.error("[coins/packages] Failed to read the package catalog:", err);
    return NextResponse.json(
      { success: false, error: "Catalog unavailable" },
      { status: 503 },
    );
  }
}
