import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import PageClient from "./PageClient";
import { getMembershipTier } from "../../lib/stripe/subscriptions";

// A per-player dashboard: never indexed, never prerendered/shared between users.
export const metadata: Metadata = {
  title: "Performance statistics | GRYND",
  description:
    "GRYND PRO performance dashboard — your ranked record, per-game win rates, Elo and trophy progression, and how your overall ranking moves over time.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

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
 * An unreadable subscription state counts as "not a member", matching
 * /api/membership/status: the worse failure would be showing a paying member's
 * analytics to anyone when the database is unreachable.
 */
export default async function StatsPage() {
  const { userId } = await auth();

  let pro = false;
  if (userId) {
    try {
      pro = (await getMembershipTier(userId)) === "pro";
    } catch (error) {
      console.error("[stats] Failed to resolve membership:", error);
      pro = false;
    }
  }

  return <PageClient signedIn={Boolean(userId)} pro={pro} />;
}
