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
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import {
  findActiveSubscription,
  getProPlanDisplay,
} from "../../../../lib/stripe/subscriptions";

export const runtime = "nodejs";

/** The single membership badge shown next to members' names. */
export const MEMBERSHIP_TITLE = "GRYND PRO";

export async function GET() {
  const { userId } = await auth();

  // The plan the upgrade surfaces sell. Same server-resolved price as the
  // Stripe checkout, so the advertised amount is always what gets charged.
  const plan = await getProPlanDisplay();

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
    currentPeriodEnd: subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.toISOString()
      : null,
    title: MEMBERSHIP_TITLE,
    chatColor: userRow?.chatColor ?? null,
  });
}
