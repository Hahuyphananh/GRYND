// app/api/onboarding/progress/route.ts
//
// POST /api/onboarding/progress
//   Body: { event: "welcome_started" | "tutorial_started" | "tutorial_completed" | "tutorial_skipped" }
//   → { success, event }
//
// Fine-grained onboarding progress for the Solitaire-first flow, tracked
// SEPARATELY from completion:
//
//   * this route NEVER sets onboarding_completed_at — that stays the exclusive
//     job of /api/onboarding/complete, called only by the final CTA or Skip;
//   * tutorial_completed_at and tutorial_skipped_at are distinct columns, so a
//     skipped tutorial can never be read as a completed one;
//   * every write is `WHERE <column> IS NULL`, which makes the endpoint
//     idempotent (refreshes, double taps, several tabs) and keeps the FIRST
//     occurrence — the honest timestamp — rather than the last view.
//
// A failed write is non-fatal for the player: the welcome page calls this
// fire-and-forget, and onboarding continues regardless.
//
// Auth: the Clerk session identifies the row; no client-supplied id is read.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** event → the column it may stamp (once). */
const EVENT_COLUMNS = {
  welcome_started: "onboardingStartedAt",
  tutorial_started: "tutorialStartedAt",
  tutorial_completed: "tutorialCompletedAt",
  tutorial_skipped: "tutorialSkippedAt",
} as const;

type ProgressEvent = keyof typeof EVENT_COLUMNS;

function isProgressEvent(value: unknown): value is ProgressEvent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EVENT_COLUMNS, value);
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { event?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isProgressEvent(body?.event)) {
    return NextResponse.json(
      { success: false, error: "Unknown onboarding progress event" },
      { status: 400 },
    );
  }

  const column = EVENT_COLUMNS[body.event];
  const value = new Date();

  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    await db
      .update(users)
      .set({ [column]: value })
      .where(and(eq(users.id, user.id), isNull(users[column])));

    return NextResponse.json({ success: true, event: body.event });
  } catch (err) {
    console.error("[ONBOARDING_PROGRESS_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Failed to save onboarding progress" },
      { status: 500 },
    );
  }
}
