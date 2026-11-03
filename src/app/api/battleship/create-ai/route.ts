// src/app/api/battleship/create-ai/route.ts
//
// POST — start a FREE, UNRATED practice match against the built-in Battleship
// bot, following the same pattern as every other GRYND practice entry
// (`src/app/api/tic-tac-toe/create-ai/route.ts`).
//
// The gate is the shared practice gate, so a signed-out visitor can play: it
// mints/reuses a `guest_…` identity (src/lib/guestIdentity.ts) and the store
// seats that id in player 1. ONLINE play (`create-or-join`) keeps the age gate —
// a guest can only ever drive its own practice match, never a ranked one.
//
// The ONLY thing the body may choose is the tier, and it is validated against
// the canonical scale (`src/lib/aiDifficulty.ts`) rather than trusted: an
// unknown spelling is a 400, not a silent downgrade. The bot's fleet is dealt
// and stored server-side; no fleet and no coordinate appears in this response.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import {
  DEFAULT_AI_DIFFICULTY,
  isAiDifficulty,
} from "../../../../lib/aiDifficulty";
import { createAiMatch, matchDto } from "../../../../lib/battleship/serverStore";

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

  const body = (await req.json().catch(() => ({}))) as { difficulty?: unknown };
  if (body?.difficulty !== undefined && !isAiDifficulty(body.difficulty)) {
    return NextResponse.json(
      { success: false, error: "difficulty must be easy, normal or hard" },
      { status: 400 },
    );
  }

  try {
    const result = await createAiMatch({
      userId,
      difficulty: body?.difficulty ?? DEFAULT_AI_DIFFICULTY,
    });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // The bot is in seat 2 (`is_ai`), and `practice: true` tells the client to
    // drive the match through the practice routes from here on.
    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        practice: true,
        aiDifficulty: result.difficulty,
        match: matchDto(result.match, "player1"),
      },
    });
  } catch (error) {
    await logError({
      errorType: "battleship_create_ai_error",
      errorMessage:
        error instanceof Error ? error.message : "Battleship practice creation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/create-ai",
      game: "Battleship",
      metadata: { operation: "create_ai" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
