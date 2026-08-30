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
import { findActiveSubscription } from "../../../../lib/stripe/subscriptions";

export const runtime = "nodejs";

/** Title shown next to members' names (Grynd+ exclusive). */
export const MEMBERSHIP_TITLE = "GRYND+ Elite";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: true, active: false });
  }

  const subscription = await findActiveSubscription(userId);
  if (!subscription) {
    return NextResponse.json({ success: true, active: false });
  }

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
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.toISOString()
      : null,
    title: MEMBERSHIP_TITLE,
    chatColor: userRow?.chatColor ?? null,
  });
}
