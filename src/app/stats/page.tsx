import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import PageClient from "./PageClient";
import { getMembershipTier, type MembershipTier } from "../../lib/stripe/subscriptions";
import { withTimeout } from "../../lib/security/withTimeout";

// A per-player dashboard: never indexed, never prerendered/shared between users.
export const metadata: Metadata = {
  title: "Performance statistics | GRYND",
  description:
    "GRYND PRO performance dashboard — your ranked record, per-game win rates, Elo and trophy progression, and how your overall ranking moves over time.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * A membership read may not hold the page hostage. The proxy bounds its own
 * DB lookups the same way (see src/proxy.ts) so a slow database can never turn
 * into a blank first byte; this page needs the same guarantee, because it
 * renders nothing at all until the tier is known.
 */
const MEMBERSHIP_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The GRYND PRO performance dashboard.
 *
 * The membership decision is made HERE, on the server, through the platform's
 * existing authoritative check (`getMembershipTier`, the same one
 * /api/membership/status and the ad entitlement use) and handed to the client
 * as a prop. That only decides what the FIRST paint shows — the analytics
 * themselves are protected by the API route, which re-resolves membership on
 * every request, so a client-side tamper gains nothing.
 *
 * An unreadable subscription state still grants nothing (the worse failure
 * would be showing a paying member's analytics to anyone when the database is
 * unreachable), but it is NOT reported to the client as "free": a failed
 * check and a real downgrade look identical on screen, and a member who paid
 * would be shown an upgrade prompt with no hint that the lookup failed. The
 * page passes `membershipUnavailable` so the dashboard can offer a retry
 * instead of pretending the membership is gone.
 */
export default async function StatsPage() {
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
        console.error("[stats] Membership lookup timed out");
      }
    } catch (error) {
      console.error("[stats] Failed to resolve membership:", error);
      pro = false;
      membershipUnavailable = true;
    }
  }

  return (
    <PageClient
      signedIn={Boolean(userId)}
      pro={pro}
      membershipUnavailable={membershipUnavailable}
    />
  );
}
