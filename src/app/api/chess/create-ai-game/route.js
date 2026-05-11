import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const tableAmount = Number(body.tableAmount) || 0;

    const [newGame] = await db
      .insert(chessGames)
      .values({
        playerWhiteId: userId, // always user for AI games (you can randomize later if needed)
        playerBlackId: null, // AI takes this spot
        betAmount: tableAmount,
        isAiGame: true,
        status: "in_progress",
      })
      .returning({ id: chessGames.id });

    return NextResponse.json({ gameId: newGame.id });
  } catch (err) {
    console.error("Create-AI-game error:", err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
