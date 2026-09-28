// src/app/api/mini-golf/create-ai/route.ts
//
// POST — start a free practice match against the built-in Mini Golf bot.
//
// Practice is UNRATED: the row is marked `is_ai`, so settlement skips ratings
// and trophies entirely (see `settleMatch` in src/lib/mini-golf/serverStore.ts).
// It never touches the open-lobby pool either, so a practice match cannot be
// joined by, or shown to, another player.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createAiMatch } from "../../../../lib/mini-golf/serverStore";

export async function POST(req: Request) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  // The lobby's AI-difficulty pick. Absent/invalid coerces to the mini-golf
  // default, so an older client still starts a practice match.
  const body = (await req.json().catch(() => ({}))) as { difficulty?: unknown };

  try {
    const { match } = await createAiMatch({
      userId,
      difficulty: body?.difficulty,
    });
    return NextResponse.json({
      success: true,
      data: {
        matchId: match.id,
        status: match.status,
        practice: true,
        aiDifficulty: match.aiDifficulty ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "mini_golf_create_ai_error",
      errorMessage:
        error instanceof Error ? error.message : "Mini Golf practice match failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/mini-golf/create-ai",
      game: "Mini Golf",
      metadata: { operation: "create_ai" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
