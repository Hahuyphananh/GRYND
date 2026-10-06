import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    // Free practice vs the built-in engine: a signed-out visitor is issued a
    // guest seat here (the only chess route that mints one). Chess vs AI is
    // unrated — the game row is flagged `isAiGame`, so settlement skips ELO,
    // trophies and counters. Online play (/api/chess/create-game, /join-game)
    // keeps the age gate.
    const gate = await requirePracticePlayer({ create: true });
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const difficultyLevel = Number(body.difficultyLevel) || 3;

    const [newGame] = await db
      .insert(chessGames)
      .values({
        playerWhiteId: userId,
        playerBlackId: null,
        betAmount: "0",
        timerMode: "blitz",
        initialTimeSeconds: 300,
        isAiGame: true,
        status: "in_progress",
      })
      .returning({ id: chessGames.id });

    return NextResponse.json({
      gameId: newGame.id,
      difficultyLevel,
    });
  } catch (err) {
    console.error("Create-AI-game error:", err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
