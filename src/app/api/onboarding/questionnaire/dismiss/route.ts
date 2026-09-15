// app/api/onboarding/questionnaire/dismiss/route.ts
//
// POST /api/onboarding/questionnaire/dismiss
//   → { success, dismissed: true, dismissedAt }
//
// "Maybe Later" for the questionnaire invitation. Stores the dismissal on the
// user row (users.questionnaire_dismissed_at, migration 0158) so the
// invitation is never shown again — across reloads, tabs, sessions and
// devices — instead of a per-browser flag that keeps re-asking.
//
// Important: this does NOT mark the questionnaire as completed. The two states
// stay separate, and the questionnaire remains reachable from Settings, so
// declining costs the player nothing.
//
// Security/auth: identical to /api/onboarding/questionnaire — Clerk `auth()`
// only, the caller's own row resolved from the session (a body-supplied user
// id is never read), no sensitive data involved. Idempotent: the first
// dismissal wins and later calls are safe no-ops that report the original
// timestamp.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../../../db";
import { users } from "../../../../../db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [user] = await db
      .select({
        id: users.id,
        questionnaireDismissedAt: users.questionnaireDismissedAt,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    // Only the first dismissal stamps the timestamp ("when did they decline").
    await db
      .update(users)
      .set({ questionnaireDismissedAt: new Date() })
      .where(and(eq(users.id, user.id), isNull(users.questionnaireDismissedAt)));

    const dismissedAt = user.questionnaireDismissedAt ?? new Date();

    return NextResponse.json({
      success: true,
      dismissed: true,
      dismissedAt: dismissedAt.toISOString(),
    });
  } catch (err) {
    console.error("[QUESTIONNAIRE_DISMISS_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Failed to save your choice" },
      { status: 500 }
    );
  }
}
