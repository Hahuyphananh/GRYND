import type { Metadata } from "next";
import { and, asc, eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import ShopBuyClient, {
  type ShopPackage,
  type SubscriptionPlan,
} from "../../components/ShopBuyClient";
import ShopItemsClient from "../../components/ShopItemsClient";
import { db } from "../../db";
import { tokenPackages, stripeCheckoutSessions, tokenSubscriptionPlans } from "../../db/schema";
import { resolvePackagePriceCents } from "../../lib/stripe/packages";
import {
  findActiveSubscription,
  resolveSubscriptionPlanPriceCents,
} from "../../lib/stripe/subscriptions";

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
        oneTime: tokenPackages.oneTime,
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
        oneTime: r.oneTime,
        tokensPerDollar,
      };
    });
  } catch (err) {
    console.error("[shop] Failed to load token packages:", err);
    return [];
  }
}

// Loads the enabled subscription plans (Grynd+) server-side, resolving the
// display price from Stripe where the plan is bound to a real product.
async function loadSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  try {
    const rows = await db
      .select({
        id: tokenSubscriptionPlans.id,
        key: tokenSubscriptionPlans.key,
        name: tokenSubscriptionPlans.name,
        monthlyTokens: tokenSubscriptionPlans.monthlyTokens,
        priceCents: tokenSubscriptionPlans.priceCents,
        badge: tokenSubscriptionPlans.badge,
        perks: tokenSubscriptionPlans.perks,
        featured: tokenSubscriptionPlans.featured,
        stripeProductId: tokenSubscriptionPlans.stripeProductId,
        stripePriceId: tokenSubscriptionPlans.stripePriceId,
      })
      .from(tokenSubscriptionPlans)
      .where(eq(tokenSubscriptionPlans.enabled, true))
      .orderBy(asc(tokenSubscriptionPlans.sortOrder));

    const offers = await Promise.all(
      rows.map(async (r) => {
        const priceCents = await resolveSubscriptionPlanPriceCents({
          id: r.id,
          key: r.key,
          name: r.name,
          monthlyTokens: Number(r.monthlyTokens ?? 0),
          priceCents: Number(r.priceCents ?? 0),
          stripeProductId: r.stripeProductId,
          stripePriceId: r.stripePriceId,
        });
        return { ...r, priceCents };
      })
    );

    return offers.map((r) => ({
      key: r.key,
      name: r.name,
      monthlyTokens: Number(r.monthlyTokens ?? 0),
      priceUsd: (Number(r.priceCents ?? 0) / 100).toFixed(2),
      badge: r.badge,
      perks: Array.isArray(r.perks) ? r.perks.filter((p): p is string => Boolean(p)) : [],
      featured: r.featured,
    }));
  } catch (err) {
    console.error("[shop] Failed to load subscription plans:", err);
    return [];
  }
}

export default async function ShopPage() {
  const [packages, subscriptionPlans] = await Promise.all([
    loadPackages(),
    loadSubscriptionPlans(),
  ]);

  // Which one-time offers this user has already bought (only relevant for
  // signed-in users; guests get the full catalog and are asked to sign in
  // when they try to buy).
  const { userId } = await auth();
  let purchasedKeys: string[] = [];
  let activeSubscription: {
    planKey: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null = null;

  if (userId) {
    try {
      const purchasedRows = await db
        .select({ packageKey: stripeCheckoutSessions.packageKey })
        .from(stripeCheckoutSessions)
        .where(
          and(
            eq(stripeCheckoutSessions.clerkId, userId),
            eq(stripeCheckoutSessions.fulfilled, true)
          )
        );
      purchasedKeys = purchasedRows
        .map((r) => r.packageKey)
        .filter((k): k is string => Boolean(k));
    } catch (err) {
      console.error("[shop] Failed to load purchase history:", err);
    }

    try {
      const sub = await findActiveSubscription(userId);
      if (sub) {
        activeSubscription = {
          planKey: sub.planKey,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd
            ? sub.currentPeriodEnd.toISOString()
            : null,
        };
      }
    } catch (err) {
      console.error("[shop] Failed to load subscription:", err);
    }
  }

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/shop" />
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-20 pt-24">
        {packages.length > 0 || subscriptionPlans.length > 0 ? (
          <>
            <ShopBuyClient
              packages={packages}
              purchasedKeys={purchasedKeys}
              subscriptionPlans={subscriptionPlans}
              activeSubscription={activeSubscription}
            />
            <p className="mt-4 text-center text-xs text-[#9dd8ff]/50">
              Purchases are processed securely by Stripe. Grynd tokens are virtual and have no cash
              value — non-refundable.
            </p>
            <ShopItemsClient />
            <p className="mt-4 text-center text-xs text-[#9dd8ff]/50">
              Item Shop purchases are paid with Grynd tokens and have no cash value — non-refundable.
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
