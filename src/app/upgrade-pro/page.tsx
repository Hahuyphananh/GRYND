import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import PageClient from "./PageClient";
import {
  findActiveSubscription,
  getProPlanDisplay,
} from "../../lib/stripe/subscriptions";

export const metadata: Metadata = {
  title: "GRYND PRO | GRYND",
  description:
    "GRYND PRO — ad-free browsing, advanced statistics, advanced performance analytics and detailed match history. Monthly membership, cancel anytime. No tokens, no gameplay advantages.",
};

// The membership entitlement is per-caller, so this page must never be
// prerendered/shared between users.
export const dynamic = "force-dynamic";

/**
 * The single GRYND PRO upgrade surface (replaces the old token Shop).
 *
 * Everything authoritative is resolved HERE, on the server, and handed to the
 * client as props:
 *   * the plan (name, price, perks) from the plan catalog / bound Stripe price,
 *   * whether the caller already holds GRYND PRO.
 *
 * The client component only renders it and calls the existing Stripe
 * subscribe/portal endpoints — it never decides entitlement or price.
 */
export default async function UpgradeProPage() {
  const { userId } = await auth();
  const plan = await getProPlanDisplay();

  let subscription: {
    planKey: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null = null;

  if (userId) {
    try {
      const sub = await findActiveSubscription(userId);
      if (sub) {
        subscription = {
          planKey: sub.planKey,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd
            ? sub.currentPeriodEnd.toISOString()
            : null,
        };
      }
    } catch (err) {
      console.error("[upgrade-pro] Failed to load subscription:", err);
    }
  }

  return (
    <PageClient
      plan={plan}
      signedIn={Boolean(userId)}
      subscription={subscription}
    />
  );
}
