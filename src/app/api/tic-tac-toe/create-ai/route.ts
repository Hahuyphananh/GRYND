// src/app/api/tic-tac-toe/create-ai/route.ts
//
// POST — start a free practice match against the built-in Tic-Tac-Toe bot.
//
// Practice is UNRATED: the row is marked `is_ai`, so settlement skips ratings,
// trophies and win counters entirely (see `settleMatch` in
// src/lib/tic-tac-toe/serverStore.ts). The bot occupies player2 immediately, so
// the match never appears in the open-lobby pool and cannot be joined by anyone
// else.
//
// The bot answers INSIDE the human's move transaction (server-side), so it can
// never be skipped by a client that fails to trigger it.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { createAiMatch } from "../../../../lib/tic-tac-toe/serverStore";

export async function POST(req: Request) {
  // Free practice vs the bot is open to signed-out guests — this is the only
  // Tic-Tac-Toe route that mints a guest identity. Online play
  // (/api/tic-tac-toe/create-or-join) keeps the age gate, and every follow-up
  // route authorises by seat, so a guest can only ever drive its own match.
  const gate = await requirePracticePlayer({ create: true });
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  // The lobby's AI-difficulty and starting-mark picks. Absent/invalid values
  // coerce to the documented defaults (`normal`, and a SERVER-side `random`
  // roll) so an older client still starts a practice match.
  const body = (await req.json().catch(() => ({}))) as {
    difficulty?: unknown;
    mark?: unknown;
  };

  try {
    const { match, humanMark, humanSeat } = await createAiMatch({
      userId,
      difficulty: body?.difficulty,
      mark: body?.mark,
    });
    return NextResponse.json({
      success: true,
      data: {
        matchId: match.id,
        status: match.status,
        practice: true,
        aiDifficulty: match.aiDifficulty ?? null,
        // The SERVER's resolution of `random`, plus the seat it wrote the human
        // into. The client draws its mark from the snapshot; these are echoed so
        // a caller can label the match without a second read.
        humanMark,
        humanSeat,
      },
    });
  } catch (error) {
    await logError({
      errorType: "tic_tac_toe_create_ai_error",
      errorMessage:
        error instanceof Error ? error.message : "Ultimate Tic-Tac-Toe practice failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tic-tac-toe/create-ai",
      game: "Ultimate Tic-Tac-Toe",
      metadata: { operation: "create_ai" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
