// src/app/api/membership/status/route.ts
//
// GET — the authenticated user's Grynd+ membership status. Single source of
// truth for the client-side perk surfaces (profile badge/title, chat badge,
// support widget attribute, shop state). Reads the active subscription row
// server-side; returns display data only.
//
//   * auth-required; signed-out callers get active: false (no 401) so client
//     widgets degrade gracefully.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { findActiveSubscription, TIER_BY_PLAN_KEY } from "../../../../lib/stripe/subscriptions";

export const runtime = "nodejs";

/** Titles shown next to members' names, by tier. */
export const MEMBERSHIP_TITLES = {
  grynd_plus: "GRYND+ Elite",
  pro: "GRYND PRO",
  high_roller: "GRYND HIGH ROLLER",
} as const;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: true, active: false });
  }

  const subscription = await findActiveSubscription(userId);
  if (!subscription) {
    return NextResponse.json({ success: true, active: false });
  }

  // Tier from the plan key — unknown keys still count as the base tier so a
  // paying member is never silently downgraded.
  const tier = TIER_BY_PLAN_KEY[subscription.planKey] ?? "grynd_plus";

  // The user's saved chat color (Grynd+ perk) so the profile picker can
  // initialize from it.
  const [userRow] = await db
    .select({ chatColor: users.chatColor })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  return NextResponse.json({
    success: true,
    active: true,
    planKey: subscription.planKey,
    tier,
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.toISOString()
      : null,
    title: MEMBERSHIP_TITLES[tier],
    chatColor: userRow?.chatColor ?? null,
  });
}
