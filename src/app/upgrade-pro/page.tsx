import type { Metadata } from "next";
import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import PageClient from "./PageClient";
import {
  findActiveSubscription,
  getProPlanDisplay,
  hasPriorSubscription,
} from "../../lib/stripe/subscriptions";
import { countryFromHeaders } from "../../lib/consentRegions";
import { getApprovedReviews } from "../../lib/reviews";
import { pickFeaturedReview } from "../../lib/featuredReview";
import { currencyForCountry } from "../../lib/currency";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "GRYND PRO",
  description: "GRYND PRO — ad-free browsing, the full performance dashboard and unlimited match analysis. Monthly membership, cancel anytime. No tokens, no gameplay advantages.",
  path: "/upgrade-pro",
  image: DEFAULT_OG_IMAGE,
});

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
  // The price is presented in the visitor's own currency when the bound Stripe
  // price is configured for it (see lib/currency.ts + getProPlanDisplay). The
  // country comes from the request's geo headers, never from the client.
  const requestHeaders = await headers();
  const currency = currencyForCountry(countryFromHeaders(requestHeaders));
  const plan = await getProPlanDisplay(currency);

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

  // The free trial is once per customer, so the server decides eligibility
  // before the first paint: a returning canceled member must not see a promise
  // of a free week that checkout would not create. A failed check denies the
  // trial rather than advertising it.
  let trialEligible: boolean | null = userId ? false : true;
  if (userId && !subscription) {
    try {
      trialEligible = !(await hasPriorSubscription(userId));
    } catch (err) {
      console.error("[upgrade-pro] Failed to check trial eligibility:", err);
      trialEligible = false;
    }
  }

  // The best REAL approved review, picked from the same moderated feed the
  // /reviews wall publishes. A failed read means no testimonial — never a
  // placeholder quote.
  let testimonial = null;
  try {
    testimonial = pickFeaturedReview(await getApprovedReviews(12));
  } catch (err) {
    console.error("[upgrade-pro] Failed to load the featured review:", err);
  }

  return (
    <PageClient
      plan={plan}
      signedIn={Boolean(userId)}
      subscription={subscription}
      testimonial={testimonial}
      trialEligible={trialEligible}
    />
  );
}
