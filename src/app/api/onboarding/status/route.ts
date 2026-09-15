// app/api/onboarding/status/route.ts
//
// GET /api/onboarding/status
//
// Returns the caller's onboarding state, as four INDEPENDENT facts:
//
//   onboardingCompleted    the existing welcome/tutorial (0142)
//   firstGameCompleted     the existing onboarding RPS match (0143)
//   questionnaireCompleted the personalization questionnaire (0157)
//   questionnaireDismissed the invitation was declined (0158)
//
// Every consumer (lobby card, /welcome hand-off, questionnaire page) decides
// from these flags through src/lib/onboardingFlow.js, so the states are never
// conflated. Anonymous visitors report every flag as completed/true — 
// onboarding only ever targets a signed-in brand-new account, and logged-out
// visitors must never be shunted into it (or prompted). Existing accounts
// were backfilled as completed by 0142/0143; the questionnaire flags are
// deliberately NOT backfilled (0157/0158) because "never answered, never
// dismissed" is exactly what makes an existing player eligible for the
// one-time invitation.

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
        questionnaireCompleted: true,
        questionnaireDismissed: true,
      });
    }

    const rows = await db
      .select({
        onboardingCompletedAt: users.onboardingCompletedAt,
        firstGameCompletedAt: users.firstGameCompletedAt,
        questionnaireCompletedAt: users.questionnaireCompletedAt,
        questionnaireDismissedAt: users.questionnaireDismissedAt,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const completed = rows[0]?.onboardingCompletedAt != null;
    const firstGameCompleted = rows[0]?.firstGameCompletedAt != null;
    // Independent of the two flags above — answering the questionnaire never
    // marks the welcome tutorial complete, and vice-versa.
    const questionnaireCompleted = rows[0]?.questionnaireCompletedAt != null;
    const questionnaireDismissed = rows[0]?.questionnaireDismissedAt != null;

    return Response.json({
      success: true,
      onboardingCompleted: completed,
      firstGameCompleted,
      questionnaireCompleted,
      questionnaireDismissed,
    });
  } catch (err) {
    console.error("[ONBOARDING_STATUS_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to load onboarding status" },
      { status: 500 },
    );
  }
}
