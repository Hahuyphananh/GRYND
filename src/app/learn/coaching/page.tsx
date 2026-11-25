import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";

import LearnCoachingPage from "../../../components/learn/LearnCoachingPage";
import { withTimeout } from "../../../lib/security/withTimeout";
import {
  getMembershipTier,
  type MembershipTier,
} from "../../../lib/stripe/subscriptions";

// A per-player coaching view: never indexed, never prerendered/shared.
export const metadata: Metadata = {
  title: "Coaching — GRYND Academy",
  description:
    "GRYND Pro advanced coaching: personal practice analytics, targeted recommendations and a short daily training plan. All courses, lessons and basic practice stay free.",
  alternates: { canonical: "/learn/coaching" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** A membership read may not hold the page hostage (same bound as /stats). */
const MEMBERSHIP_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The server decides what the FIRST paint shows, through the platform's
 * existing entitlement source (`getMembershipTier`). This is presentation only:
 * the report itself is built by /api/learn/coaching, which re-resolves
 * membership on every request, so a client-side tamper gains nothing.
 *
 * An unreadable subscription state grants nothing but is reported as
 * `membershipUnavailable`, not as a downgrade, so a paying member sees a retry
 * instead of an upgrade prompt.
 */
export default async function LearnCoachingRoute() {
  const { userId } = await auth();

  let pro = false;
  let membershipUnavailable = false;
  if (userId) {
    try {
      const tier = await withTimeout<MembershipTier | null>(
        getMembershipTier(userId),
        MEMBERSHIP_LOOKUP_TIMEOUT_MS,
        null,
      );
      pro = tier === "pro";
      membershipUnavailable = tier === null;
      if (membershipUnavailable) {
        console.error("[learn/coaching] Membership lookup timed out");
      }
    } catch (error) {
      console.error("[learn/coaching] Failed to resolve membership:", error);
      pro = false;
      membershipUnavailable = true;
    }
  }

  return (
    <LearnCoachingPage
      signedIn={Boolean(userId)}
      pro={pro}
      membershipUnavailable={membershipUnavailable}
    />
  );
}
