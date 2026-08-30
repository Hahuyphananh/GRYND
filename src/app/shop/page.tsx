import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import ShopBuyClient, { type ShopPackage } from "../../components/ShopBuyClient";
import { db } from "../../db";
import { tokenPackages } from "../../db/schema";
import { resolvePackagePriceCents } from "../../lib/stripe/packages";

export const metadata: Metadata = {
  title: "Shop | GRYND",
  description: "Grynd Shop",
};

// Loads the enabled token catalog server-side so the client never sees Stripe
// secret/customer identifiers — only display data (name, tokens, price, badge).
// For offers bound to a real Stripe product (stripe_product_id set) the price
// is resolved live from Stripe; otherwise the catalog's stored price is used.
async function loadPackages(): Promise<ShopPackage[]> {
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
        stripePriceId: tokenPackages.stripePriceId,
      })
      .from(tokenPackages)
      .where(eq(tokenPackages.enabled, true))
      .orderBy(asc(tokenPackages.sortOrder));

    // Resolve each offer's price (Stripe-backed where possible) in parallel.
    const offers = await Promise.all(
      rows.map(async (r) => {
        const priceCents = await resolvePackagePriceCents({
          id: r.id,
          key: r.key,
          name: r.name,
          priceCents: Number(r.priceCents ?? 0),
          stripeProductId: r.stripeProductId,
          stripePriceId: r.stripePriceId,
        });
        return { ...r, priceCents };
      })
    );

    return offers.map((r) => {
      const baseTokens = Number(r.baseTokens ?? 0);
      const bonusTokens = Number(r.bonusTokens ?? 0);
      const awardedTokens = baseTokens + bonusTokens;
      const priceCents = Number(r.priceCents ?? 0);
      const tokensPerDollar = priceCents > 0 ? Math.round((awardedTokens * 100) / priceCents) : 0;
      return {
        key: r.key,
        name: r.name,
        baseTokens,
        bonusTokens,
        awardedTokens,
        priceUsd: (priceCents / 100).toFixed(2),
        badge: r.badge,
        featured: r.featured,
        tokensPerDollar,
      };
    });
  } catch (err) {
    console.error("[shop] Failed to load token packages:", err);
    return [];
  }
}

export default async function ShopPage() {
  const packages = await loadPackages();

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/shop" />
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-20 pt-24">
        {packages.length > 0 ? (
          <>
            <ShopBuyClient packages={packages} />
            <p className="mt-4 text-center text-xs text-[#9dd8ff]/50">
              Purchases are processed securely by Stripe. Grynd tokens are virtual and have no cash
              value — non-refundable.
            </p>
          </>
        ) : (
          <p className="pt-16 text-center text-lg text-[#9dd8ff]/70">
            Token offers are coming soon.
          </p>
        )}
      </main>
      <Footer />
    </div>
  );
}
