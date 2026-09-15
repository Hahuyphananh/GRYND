// app/api/onboarding/questionnaire/route.ts
//
// GET  /api/onboarding/questionnaire
//   → { success, completed, completedAt, version, answers, onboardingCompleted }
//     The caller's own questionnaire state + answers, in the client shape
//     (`{ motivation: ["competition"], experience: "new" }`). Used to prefill
//     the flow (resume/edit) and to decide whether to prompt a returning user.
//
// PUT / POST /api/onboarding/questionnaire
//   Body: { answers: { <questionKey>: <value> | [<value>, ...] } }
//   → { success, completed: true, completedAt, version, answers }
//
//     Replaces the caller's answers atomically (delete + insert in ONE
//     transaction) and stamps users.questionnaire_completed_at on the first
//     successful submission. Idempotent: re-sending the same payload is a
//     safe no-op, and later submissions overwrite earlier ones — so both the
//     first submit and a later Settings edit go through this single route.
//
// Auth/security:
//   * Authentication comes from Clerk via `auth()` — the same server pattern
//     /api/onboarding/complete and /api/user/default-wagers use.
//   * Any client-supplied user id is IGNORED: the row written is looked up
//     from the Clerk session's clerkId, never from the request body.
//   * Question keys, answer values, required questions, multi-select limits
//     and duplicate answers are validated against the shared catalog in
//     src/lib/onboardingQuestionnaire.js before anything touches the DB.
//   * No sensitive data is collected or stored — game preferences only.
//
// Important: this route NEVER writes onboarding_completed_at. The welcome
// tutorial and the questionnaire are independent states.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../../db";
import { onboardingResponses, users } from "../../../../db/schema";
import {
  QUESTIONNAIRE_VERSION,
  groupStoredResponses,
  validateQuestionnaireAnswers,
} from "../../../../lib/onboardingQuestionnaire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoredRow = { questionKey: string; answer: string };

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

async function loadUser(clerkId: string) {
  const [row] = await db
    .select({
      id: users.id,
      questionnaireCompletedAt: users.questionnaireCompletedAt,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  return row ?? null;
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return unauthorized();

  try {
    const user = await loadUser(userId);
    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    const rows = await db
      .select({
        questionKey: onboardingResponses.questionKey,
        answer: onboardingResponses.answer,
      })
      .from(onboardingResponses)
      .where(eq(onboardingResponses.userId, user.id));

    return NextResponse.json({
      success: true,
      completed: user.questionnaireCompletedAt != null,
      completedAt: user.questionnaireCompletedAt
        ? user.questionnaireCompletedAt.toISOString()
        : null,
      version: QUESTIONNAIRE_VERSION,
      answers: groupStoredResponses(rows),
      onboardingCompleted: user.onboardingCompletedAt != null,
    });
  } catch (err) {
    console.error("[ONBOARDING_QUESTIONNAIRE_GET_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Failed to load questionnaire state" },
      { status: 500 }
    );
  }
}

async function submit(request: Request) {
  const { userId } = await auth();
  if (!userId) return unauthorized();

  let body: { answers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  // A client-supplied user id (if any) is deliberately never read: the target
  // row always comes from the authenticated Clerk session.
  const validation = validateQuestionnaireAnswers(body?.answers);
  if (!validation.ok) {
    return NextResponse.json(
      {
        success: false,
        error: validation.error,
        code: validation.code,
        questionKey: validation.questionKey ?? null,
      },
      { status: 400 }
    );
  }

  const normalized = validation.answers as Record<string, string[]>;
  const rows: StoredRow[] = Object.entries(normalized).flatMap(([questionKey, values]) =>
    values.map((answer) => ({ questionKey, answer }))
  );

  try {
    const user = await loadUser(userId);
    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      // Replace: one delete keeps re-submissions idempotent and guarantees
      // the unique (user, question, answer) index can't be violated.
      await tx.delete(onboardingResponses).where(eq(onboardingResponses.userId, user.id));

      if (rows.length > 0) {
        await tx.insert(onboardingResponses).values(
          rows.map((row) => ({
            userId: user.id,
            questionKey: row.questionKey,
            answer: row.answer,
            createdAt: new Date(),
            updatedAt: new Date(),
          }))
        );
      }

      // First submission stamps completion; later edits keep the original
      // timestamp (so "when did they first answer" stays meaningful).
      await tx
        .update(users)
        .set({ questionnaireCompletedAt: new Date() })
        .where(and(eq(users.id, user.id), isNull(users.questionnaireCompletedAt)));
    });

    const completedAt = user.questionnaireCompletedAt ?? new Date();

    return NextResponse.json({
      success: true,
      completed: true,
      completedAt: completedAt.toISOString(),
      version: QUESTIONNAIRE_VERSION,
      answers: groupStoredResponses(rows),
    });
  } catch (err) {
    console.error("[ONBOARDING_QUESTIONNAIRE_SUBMIT_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Failed to save questionnaire answers" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return submit(request);
}

export async function PUT(request: Request) {
  return submit(request);
}
