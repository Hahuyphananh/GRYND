import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";

export async function POST(req) {
  try {
    const body = await req.json();
    const maxPlayers = body.maxPlayers ?? 5;
    const isPrivate = body.isPrivate ?? true;
    const playerName = body.playerName ?? "Player";

    // 1️⃣ Generate game code
    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // 2️⃣ Insert game into DB with player array containing the creator
    const [newGame] = await db
      .insert(pokerGames)
      .values({
        maxPlayers,
        isPrivate,
        gameCode,
        pot: 0,
        stage: "pre-flop",
        community: [],
        players: [
          {
            id: "player",           // ✅ fixed to match frontend
            name: playerName,       // real player name
            stack: 1000,
            hand: [],
            isAI: false,
            hasFolded: false,
            currentBet: 0,
            lastAction: "",
            isReady: false,
          },
        ],
      })
      .returning();

    return NextResponse.json({
      success: true,
      game: newGame,
      gameCode: newGame.gameCode,   // ✅ renamed to match frontend
    });
  } catch (err) {
    console.error("CREATE GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
