// app/api/onboarding/recommendations/route.ts
//
// GET /api/onboarding/recommendations
//   → { success, personalized, complete, source, preferences, recommendations,
//       primaryGameIds, messageKey, experienceMessageKey }
//
// The caller's own personalized game ranking, produced by the deterministic
// engine in src/lib/gameRecommendations.js from their questionnaire answers.
// `recommendations` always contains EVERY game (ranked, never filtered) —
// personalization reorders the lobby, it never hides anything from a player.
// `personalized && complete` is the contract a UI must check before showing a
// personalized surface: partial answers still rank, but they are not a stated
// preference (see src/lib/gameRecommendations.js).
//
// Auth / security:
//   * The audience comes from Clerk via `auth()` — the same server pattern
//     /api/onboarding/questionnaire and /api/onboarding/status use. There is
//     deliberately NO user id parameter (query or body): one user can never
//     request another user's preferences, because the row is chosen by the
//     session's clerkId and nothing else. The route reads no request input at
//     all.
//   * A signed-out visitor is not an error: they get the DEFAULT order
//     (`personalized: false`), which is what the backwards-compatibility
//     requirement asks for and leaks nothing — no user row is looked up.
//
// Query cost: a signed-in player with no questionnaire answers costs ONE
// query (the user row decides). The responses are only read when the user has
// actually completed the questionnaire.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { onboardingResponses, users } from "../../../../db/schema";
import { groupStoredResponses } from "../../../../lib/onboardingQuestionnaire";
import { recommendGames } from "../../../../lib/gameRecommendations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoredRow = { questionKey: string; answer: string };

/** The engine payload for a set of answers (null → default order). */
function payload(answers: Parameters<typeof recommendGames>[0]) {
  return NextResponse.json({ success: true, ...recommendGames(answers) });
}

export async function GET() {
  const { userId } = await auth();

  // Signed out: the default lobby order, exactly as an unanswered player gets.
  if (!userId) return payload(null);

  try {
    const [user] = await db
      .select({
        id: users.id,
        questionnaireCompletedAt: users.questionnaireCompletedAt,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    // Never answered → default order, and no second query.
    if (user.questionnaireCompletedAt == null) return payload(null);

    const rows: StoredRow[] = await db
      .select({
        questionKey: onboardingResponses.questionKey,
        answer: onboardingResponses.answer,
      })
      .from(onboardingResponses)
      .where(eq(onboardingResponses.userId, user.id));

    return payload(groupStoredResponses(rows));
  } catch (err) {
    console.error("[ONBOARDING_RECOMMENDATIONS_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Failed to load recommendations" },
      { status: 500 }
    );
  }
}
