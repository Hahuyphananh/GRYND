// app/api/onboarding/complete/route.ts
//
// POST /api/onboarding/complete
//
// Permanently marks the signed-in user's onboarding as completed (sets
// `onboarding_completed_at`). Idempotent: finishing or skipping the welcome
// flow multiple times (double-taps, refreshes, several tabs) is a safe no-op
// once the timestamp is set.

import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    await db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(eq(users.clerkId, userId));

    return Response.json({ success: true });
  } catch (err) {
    console.error("[ONBOARDING_COMPLETE_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to save onboarding progress" },
      { status: 500 },
    );
  }
}
