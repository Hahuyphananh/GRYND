// src/app/api/sudoku-duel/create-ai/route.ts
//
// POST — start a free practice match against the built-in Sudoku Duel bot.
//
// Practice is UNRATED: the row is marked `is_ai`, so finalization skips ratings,
// trophies, win counters and the queue mirror entirely (see `finalizeMatch` /
// `settleSudokuDuelMatch` in src/lib/sudoku-duel/serverStore.ts). The bot
// occupies player2 immediately, so the match never appears in the open-lobby
// pool and cannot be joined by anyone else.
//
// The puzzle is minted exactly as a real lobby's is, and the bot races the SAME
// puzzle from player2. Its board is advanced from the server clock on every read
// of the match, so it genuinely plays and can never be skipped by a client.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { createAiMatch } from "../../../../lib/sudoku-duel/serverStore";

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
  // older client still starts a practice match.
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
      errorType: "sudoku_duel_create_ai_error",
      errorMessage:
        error instanceof Error ? error.message : "Sudoku Duel practice failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/sudoku-duel/create-ai",
      game: "Sudoku Duel",
      metadata: { operation: "create_ai" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
