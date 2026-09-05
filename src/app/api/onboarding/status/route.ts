// app/api/onboarding/status/route.ts
//
// GET /api/onboarding/status
//
// Returns whether the signed-in user has completed first-time onboarding
// (`onboarding_completed_at`) and whether they have finished the onboarding
// first free match (`first_game_completed_at`). Anonymous visitors are
// treated as completed (true / true) — onboarding only ever targets a
// signed-in brand-new account, and logged-out visitors must never be
// shunted into it. Existing accounts were backfilled as completed by
// migrations 0142 and 0143.

import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json({
        success: true,
        onboardingCompleted: true,
        firstGameCompleted: true,
      });
    }

    const rows = await db
      .select({
        onboardingCompletedAt: users.onboardingCompletedAt,
        firstGameCompletedAt: users.firstGameCompletedAt,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const completed = rows[0]?.onboardingCompletedAt != null;
    const firstGameCompleted = rows[0]?.firstGameCompletedAt != null;

    return Response.json({
      success: true,
      onboardingCompleted: completed,
      firstGameCompleted,
    });
  } catch (err) {
    console.error("[ONBOARDING_STATUS_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to load onboarding status" },
      { status: 500 },
    );
  }
}
