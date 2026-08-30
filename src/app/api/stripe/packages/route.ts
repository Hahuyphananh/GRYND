// src/app/api/stripe/packages/route.ts
//
// GET — list the currently enabled token packages for the Shop UI.
//
// Returns only display data (name, tokens, price, badge) — NEVER Stripe secret
// keys, webhook secrets, or `stripe_price_id`. Prices are fine to expose (they
// are what the customer sees); the actual charge + token award are resolved
// server-side again in /api/stripe/checkout and the webhook.

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { tokenPackages } from "../../../../db/schema";
import { resolvePackagePriceCents } from "../../../../lib/stripe/packages";

export const runtime = "nodejs";

export async function GET() {
  try {
    const rows = await db
      .select({
        id: tokenPackages.id,
        key: tokenPackages.key,
        name: tokenPackages.name,
        baseTokens: tokenPackages.tokenAmount,
        bonusTokens: tokenPackages.bonusTokens,
        priceCents: tokenPackages.priceCents,
        badge: tokenPackages.badge,
        featured: tokenPackages.featured,
        stripeProductId: tokenPackages.stripeProductId,
      })
      .from(tokenPackages)
      .where(eq(tokenPackages.enabled, true))
      .orderBy(asc(tokenPackages.sortOrder));

    // Resolve each offer's real price (Stripe-backed where possible).
    const resolved = await Promise.all(
      rows.map(async (r) => {
        const priceCents = await resolvePackagePriceCents({
          id: r.id,
          key: r.key,
          name: r.name,
          priceCents: Number(r.priceCents ?? 0),
          stripeProductId: r.stripeProductId,
          stripePriceId: null,
        });
        return {
          ...r,
          priceCents: Number(priceCents ?? 0),
          baseTokens: Number(r.baseTokens),
          bonusTokens: Number(r.bonusTokens),
        };
      })
    );

    const packages = resolved.map((r) => {
      const awardedTokens = r.baseTokens + r.bonusTokens;
      const priceCents = r.priceCents;
      // Value comparison: larger = more tokens per dollar spent.
      const tokensPerDollar = priceCents > 0 ? Math.round((awardedTokens * 100) / priceCents) : 0;
      return {
        key: r.key,
        name: r.name,
        baseTokens: Number(r.baseTokens),
        bonusTokens: Number(r.bonusTokens),
        awardedTokens,
        priceCents,
        priceUsd: (priceCents / 100).toFixed(2),
        badge: r.badge,
        featured: r.featured,
        tokensPerDollar,
      };
    });

    return NextResponse.json({ success: true, packages });
  } catch (err) {
    console.error("[stripe/packages] Failed to load packages:", err);
    return NextResponse.json({ success: false, error: "Failed to load packages" }, { status: 500 });
  }
}
