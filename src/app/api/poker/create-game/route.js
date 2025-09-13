import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";

export async function POST(req) {
  try {
    const body = await req.json();
    const maxPlayers = body.maxPlayers ?? 5;
    const isPrivate = body.isPrivate ?? false;

    // 1️⃣ Generate game code
    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // 2️⃣ Insert into DB using correct column name
    const [newGame] = await db
      .insert(pokerGames)
      .values({
        maxPlayers,
        isPrivate,
        game_code: gameCode, // ✅ match your Neon column
        pot: 0,
        stage: "pre-flop",
        community: [],
      })
      .returning();

    // 3️⃣ Return to frontend using the same variable name
    return NextResponse.json({
      success: true,
      game: newGame,
      inviteCode: newGame.gameCode, // frontend can keep using inviteCode
    });
  } catch (err) {
    console.error("CREATE GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
