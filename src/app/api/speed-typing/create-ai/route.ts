// src/app/api/speed-typing/create-ai/route.ts
//
// POST — start a free practice race against the built-in Speed Typing bot.
//
// Practice is UNRATED: the row is marked `is_ai`, so settlement skips ratings,
// trophies and win counters entirely (see `settleFinishedRace` in
// src/lib/speed-typing/serverStore.ts). The bot occupies player2 immediately,
// so the match never appears in the open-lobby pool and cannot be joined by
// anyone else.
//
// The race is armed here exactly as a real join arms it, so both seats race the
// same passage off the same absolute GO instant. The bot's cursor is then
// advanced from the server clock on every read of the match, so it genuinely
// races and can never be skipped by a client.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { createAiMatch } from "../../../../lib/speed-typing/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePracticePlayer({ create: true });
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  // The lobby's AI-difficulty pick. Absent/invalid coerces to the default so an
  // older client still starts a practice race.
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
      errorType: "speed_typing_create_ai_error",
      errorMessage:
        error instanceof Error ? error.message : "Speed Typing practice failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/speed-typing/create-ai",
      game: "Speed Typing",
      metadata: { operation: "create_ai" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
