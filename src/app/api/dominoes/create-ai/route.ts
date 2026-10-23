// src/app/api/dominoes/create-ai/route.ts
//
// POST — start a free practice match against the built-in Dominoes bot.
//
// Practice is UNRATED: the row is marked `is_ai`, so settlement skips ratings,
// trophies and win counters entirely (see `settleMatch` in
// src/lib/dominoes/serverStore.ts). The bot occupies player2 immediately, so the
// match never appears in the open-lobby pool and cannot be joined by anyone else.
//
// The bot answers INSIDE the human's move transaction (server-side), so it can
// never be skipped by a client that fails to trigger it — and if the bot won the
// opening bid, its first turn is already played before this route answers.
//
// Open to signed-out guests, like every other game's practice route: this is the
// only Dominoes route that mints a guest identity. Online play
// (/api/dominoes/create-or-join) keeps the age gate, and every follow-up route
// authorises by seat, so a guest can only ever drive its own match.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { createAiMatch } from "../../../../lib/dominoes/serverStore";

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

  // The lobby's difficulty pick. Absent/invalid values coerce to the documented
  // default (`normal`) so an older client still starts a practice match.
  const body = (await req.json().catch(() => ({}))) as { difficulty?: unknown };

  try {
    const result = await createAiMatch({
      userId,
      difficulty: body?.difficulty,
    });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        status: result.match.status,
        practice: true,
        aiDifficulty: result.match.aiDifficulty ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "dominoes_create_ai_error",
      errorMessage:
        error instanceof Error ? error.message : "Dominoes practice failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dominoes/create-ai",
      game: "Dominoes",
      metadata: { operation: "create_ai" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
