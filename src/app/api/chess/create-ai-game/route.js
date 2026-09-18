import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
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
