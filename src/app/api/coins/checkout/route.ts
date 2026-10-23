// src/app/api/coins/checkout/route.ts
//
// POST — start ONE one-time Stripe Checkout Session for a coin package.
//
// This endpoint CREATES A SESSION ONLY. It never credits coins, never writes a
// balance and never marks anything fulfilled: the balance move belongs to the
// signed Stripe webhook (src/lib/tokens/coinFulfillment.ts). The route refuses
// to run until `COIN_CHECKOUT_READY` is true AND the deployment sets
// COIN_PURCHASES_ENABLED=1 — both are server-side gates, so a client that
// bypasses the UI still cannot start a purchase.
//
// Server-authoritative rules (mirrors /api/stripe/subscribe):
//   * the caller must be authenticated (Clerk); the user id comes from the
//     session, never from the body,
//   * the client may send exactly ONE field — `packageKey`. Any other field
//     (an amount, a price id, a currency, a redirect) is rejected outright by
//     the shared validator, so a tampered client has nothing to tamper with,
//   * the package, its price, currency and coin award are resolved from
//     `token_packages` (see lib/coinPurchases.resolveCoinCheckoutPackage),
//   * the Stripe price is the persisted/synchronised one (`ensurePackageStripe`)
//     and is then VERIFIED against the catalog amount + currency before a
//     session is created (`verifyPackagePrice`) — a stale price refuses the
//     sale instead of charging something the Shop did not display,
//   * the `one_time` restriction is enforced from the fulfilled ledger,
//   * the `stripe_checkout_sessions` ledger row is written BEFORE the caller is
//     redirected, so reconciliation never depends on the browser returning,
//   * a deterministic Stripe idempotency key collapses retries within a short
//     window into one session,
//   * the response carries only the hosted Checkout URL.
//
// The GRYND PRO subscription checkout (/api/stripe/subscribe) is untouched.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { stripeCheckoutSessions } from "../../../../db/schema";
import { getStripe, getReturnBaseUrl } from "../../../../lib/stripe";
import {
  PACKAGE_CURRENCY,
  ensurePackageStripe,
  verifyPackagePrice,
} from "../../../../lib/stripe/packages";
import { createBrandedCheckoutSession } from "../../../../lib/stripe/checkoutBranding";
import {
  COIN_CHECKOUT_READY,
  buildCoinCheckoutSession,
  hasFulfilledPackagePurchase,
  isCoinPurchasesEnabled,
  resolveCoinCheckoutPackage,
} from "../../../../lib/coinPurchases";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";
import { auditLog } from "../../../../lib/security/auditLog";
import { logError } from "../../../../lib/logError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // 1. The feature flag. Off by default in EVERY environment; a disabled
  //    deployment answers like a route that does not exist.
  if (!isCoinPurchasesEnabled()) {
    return NextResponse.json(
      { success: false, error: "Coin purchases are not available" },
      { status: 404 },
    );
  }

  // 2. The go-live switch. Both gates must be open: this constant (flipped at
  //    launch, and the place to turn sales off again) and the env flag the
  //    packages route already checked. Taking money for a shop that is not
  //    open is never an acceptable failure mode.
  if (!COIN_CHECKOUT_READY) {
    return NextResponse.json(
      { success: false, error: "Coin purchases are not open yet" },
      { status: 503 },
    );
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: "Stripe is not configured" },
      { status: 503 },
    );
  }

  // 3. Per-user limit. Opening a Checkout Session is a Stripe API call; a
  //    retry loop must not be able to fan out sessions.
  const limit = await consumeRateLimit(`coins:checkout:${userId}`, {
    windowMs: 60_000,
    max: 10,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many requests, please try again later" },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(limit.limit),
          "X-RateLimit-Remaining": String(limit.remaining),
          "X-RateLimit-Reset": String(limit.resetAt),
        },
      },
    );
  }

  // 4. Body: `packageKey` and NOTHING else. `parseAndValidateJson` rejects any
  //    unexpected field, so `{ packageKey, amount }` is a 400 — there is no
  //    code path that could read a client amount, price or currency.
  const parsed = await parseAndValidateJson(request, {
    packageKey: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 120,
      pattern: /^[a-z0-9-]+$/,
    },
  });
  if (!parsed.ok) return parsed.response;

  const packageKey = parsed.data.packageKey as string;

  try {
    // 5. Resolve the package from the server catalog. Unknown, disabled,
    //    malformed and out-of-ladder keys are all the same answer.
    const pkg = await resolveCoinCheckoutPackage(packageKey);
    if (!pkg) {
      return NextResponse.json(
        { success: false, error: "Unknown or unavailable package" },
        { status: 404 },
      );
    }

    // 6. One-time-per-user offers are spent by a FULFILLED purchase only, read
    //    from our own ledger — never from a client claim.
    if (pkg.oneTime && (await hasFulfilledPackagePurchase(userId, pkg.key))) {
      return NextResponse.json(
        { success: false, error: "You have already purchased this pack" },
        { status: 409 },
      );
    }

    // 7. Return URLs come from the trusted origin resolver, never from input.
    const baseUrl = getReturnBaseUrl(request);
    if (!baseUrl) {
      return NextResponse.json(
        { success: false, error: "Base URL is not configured" },
        { status: 500 },
      );
    }

    // 8. The real Stripe Price for this package (created/synchronised here if
    //    needed), then verified against the catalog amount AND currency.
    let priceId: string;
    try {
      const resolved = await ensurePackageStripe({
        id: pkg.id,
        key: pkg.key,
        name: pkg.name,
        priceCents: pkg.priceCents,
        stripeProductId: pkg.stripeProductId,
        stripePriceId: pkg.stripePriceId,
      });
      priceId = resolved.priceId;
    } catch (err) {
      console.error("[coins/checkout] Failed to ensure the package price:", err);
      return NextResponse.json(
        { success: false, error: "Stripe is not configured correctly" },
        { status: 503 },
      );
    }

    const verified = await verifyPackagePrice(priceId, {
      amountCents: pkg.priceCents,
      currency: PACKAGE_CURRENCY,
    });
    if (!verified.ok) {
      // Never sell at a price/currency the Shop did not advertise.
      console.warn(
        `[coins/checkout] Refusing checkout for ${pkg.key}: ${"reason" in verified ? verified.reason : "price mismatch"}`,
      );
      return NextResponse.json(
        { success: false, error: "This pack is temporarily unavailable" },
        { status: 503 },
      );
    }

    // 9. Build the session from server-resolved values only. (`in` guards are
    //    used because this project compiles with `strict` off, where `!x.ok`
    //    does not narrow the discriminated union — same note as
    //    lib/tokens/wager.ts.)
    const plan = buildCoinCheckoutSession({
      clerkId: userId,
      pkg,
      priceId,
      charge: {
        currency: "currency" in verified ? verified.currency : PACKAGE_CURRENCY,
        amountCents: "amountCents" in verified ? verified.amountCents : 0,
      },
      baseUrl,
    });

    const session = await createBrandedCheckoutSession(
      getStripe(),
      plan.params,
      baseUrl,
      {
        requestOptions: { idempotencyKey: plan.idempotencyKey },
        displayName: "GRYND Coins",
      },
    );

    if (!session.url) {
      await logError({
        errorType: "coin_checkout_no_url",
        errorMessage: "Stripe returned a Checkout Session without a URL",
        endpoint: "/api/coins/checkout",
        metadata: { sessionId: session.id, packageKey: pkg.key },
      });
      return NextResponse.json(
        { success: false, error: "Checkout could not be started" },
        { status: 502 },
      );
    }

    // 10. Durable ledger BEFORE the redirect. `session_id` is UNIQUE, so a
    //     replayed idempotent response cannot write a second row.
    await db
      .insert(stripeCheckoutSessions)
      .values({
        sessionId: session.id,
        ...plan.ledger,
      })
      .onConflictDoNothing({ target: stripeCheckoutSessions.sessionId });

    auditLog("stripe_coin_checkout_created", {
      userId,
      packageKey: pkg.key,
      sessionId: session.id,
      amountCents: plan.ledger.amountCents,
      currency: plan.ledger.currency,
      coins: plan.ledger.tokenAmount,
    });

    // 11. Only what the browser needs to redirect. No session object, no price
    //     ids, no internal ids.
    return NextResponse.json({ success: true, url: session.url });
  } catch (err) {
    await logError({
      errorType: "coin_checkout_error",
      errorMessage: err instanceof Error ? err.message : "Coin checkout failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/coins/checkout",
      metadata: { packageKey },
    });
    return NextResponse.json(
      { success: false, error: "Checkout could not be started" },
      { status: 500 },
    );
  }
}
