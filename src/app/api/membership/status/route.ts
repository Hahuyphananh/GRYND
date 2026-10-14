// src/app/api/membership/status/route.ts
//
// GET — the authenticated user's GRYND PRO membership status. Single source of
// truth for the client-side membership surfaces (profile badge/title, chat
// badge, support widget attribute, shop state). Reads the active subscription
// row server-side; returns display data only.
//
// GRYND has exactly two membership states: `free` and `pro`. Any active
// Stripe subscription (including grandfathered legacy plans) resolves to
// `pro`.
//
//   * auth-required; signed-out callers get active: false (no 401) so client
//     widgets degrade gracefully.
//
// THE ENTITLEMENT IS SERVER-SIDE ONLY. `active` is derived from the caller's
// Stripe subscription row, never from anything the client sends, so a client
// cannot claim PRO status. The response also carries the plan display data
// (name / price / perks) resolved from the same catalog the checkout uses, so
// no client component needs to hardcode a price.

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import {
  findActiveSubscription,
  getProPlanDisplay,
} from "../../../../lib/stripe/subscriptions";
import { countryFromHeaders } from "../../../../lib/consentRegions";
import { currencyForCountry } from "../../../../lib/currency";

export const runtime = "nodejs";

// The single membership badge shown next to members' names. Module-local on
// purpose: a route module may only export its HTTP handler and the reserved
// route-config constants, so an extra named export fails Next's generated
// route type check.
const MEMBERSHIP_TITLE = "GRYND PRO";

export async function GET() {
  const { userId } = await auth();

  // The plan the upgrade surfaces sell. Same server-resolved price as the
  // Stripe checkout, so the advertised amount is always what gets charged.
  //
  // The price is presented in the visitor's own currency when (and only when)
  // the bound Stripe price carries a configured amount for it: the country
  // comes from the request's geo headers — never from anything the client
  // sends — so a client cannot shop a cheaper currency, and an unconfigured
  // currency degrades to the base (CAD) price rather than inventing one.
  const requestHeaders = await headers();
  const currency = currencyForCountry(countryFromHeaders(requestHeaders));
  const plan = await getProPlanDisplay(currency);

  if (!userId) {
    return NextResponse.json({
      success: true,
      signedIn: false,
      active: false,
      tier: "free",
      plan,
    });
  }

  // Fail closed: an unreadable subscription table means "not a member" for
  // this request, never "member". The client therefore cannot be told it has
  // PRO it might not have, and a paying member briefly sees the upgrade CTA
  // again rather than a broken page.
  const subscription = await findActiveSubscription(userId).catch((err) => {
    console.error("[membership/status] Failed to read subscription:", err);
    return null;
  });
  if (!subscription) {
    return NextResponse.json({
      success: true,
      signedIn: true,
      active: false,
      tier: "free",
      plan,
    });
  }

  // The user's saved chat color (PRO perk) so the profile picker can
  // initialize from it.
  const [userRow] = await db
    .select({ chatColor: users.chatColor })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  return NextResponse.json({
    success: true,
    signedIn: true,
    active: true,
    plan,
    planKey: subscription.planKey,
    tier: "pro",
    status: subscription.status,
    // The billing option this member is actually on (weekly | monthly |
    // yearly), for an accurate "renews …" line. Display only: the entitlement
    // above is derived from the subscription row, never from this value.
    billingInterval: subscription.billingInterval ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.toISOString()
      : null,
    title: MEMBERSHIP_TITLE,
    chatColor: userRow?.chatColor ?? null,
  });
}
