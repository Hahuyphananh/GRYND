// src/lib/adEntitlement.ts
//
// Server-authoritative "is this viewer ad-free?" — the ONLY way the ad model
// decides whether to render ads.
//
// THE CLIENT IS NEVER ASKED. There is no `premium` prop, no localStorage flag,
// no cookie and no request field that can make a free account ad-free (or a
// paying member see ads) from the browser. The answer comes from Clerk's
// session plus the caller's own subscription row, exactly like
// /api/membership/status and every other GRYND PRO perk.
//
// FAILURE POLICY — FAILS OPEN (ads may show).
// If Clerk or the database is unreachable we cannot prove the caller is a
// member, so we treat them as free and ads may render. This matches the
// repository-wide convention established by /api/membership/status
// ("an unreadable subscription table means 'not a member'") and avoids the
// worse failure of granting the paid, ad-free entitlement to everyone on the
// internet during an outage. The exposure is bounded: a member might see an ad
// for the duration of the incident, and never more than that.

import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { getMembershipTier } from "./stripe/subscriptions";

/**
 * True when the current request belongs to an active GRYND PRO member, who
 * must never be shown an advertisement or loaded with ad code.
 *
 * Memoized per request with React's `cache`, so a page with several slots (plus
 * the AdSense loader) performs ONE membership lookup, not one per surface.
 */
export const isAdFreeViewer = cache(async (): Promise<boolean> => {
  try {
    const { userId } = await auth();
    if (!userId) return false;
    return (await getMembershipTier(userId)) === "pro";
  } catch (err) {
    console.error("[ads] Failed to resolve membership; treating as free:", err);
    return false;
  }
});
