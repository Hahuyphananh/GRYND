import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq, and, lt } from "drizzle-orm";

export async function POST(req) {
  try {
    const body = await req.json();
    const playerName = body.playerName ?? "Player";

    // 1️⃣ Find a public game that is not full
    const [game] = await db
      .select()
      .from(pokerGames)
      .where(
        and(
          eq(pokerGames.isPrivate, false),
          lt(pokerGames.players.length, pokerGames.maxPlayers) // not full
        )
      )
      .limit(1);

    if (!game) {
      return NextResponse.json(
        { error: "No available public games" },
        { status: 404 }
      );
    }

    // 2️⃣ Assign player ID
    const existingPlayers = Array.isArray(game.players) ? game.players : [];
    const numJoined = existingPlayers.length;
    const playerId = `playerjoin${numJoined}`;

    const newPlayer = {
      id: playerId,
      name: playerName,
      stack: 1000,
      hand: [],
      isAI: false,
      hasFolded: false,
      currentBet: 0,
      lastAction: "",
      isReady: false,
    };

    const updatedPlayers = [...existingPlayers, newPlayer];

    // 3️⃣ Update DB
    const [updatedGame] = await db
      .update(pokerGames)
      .set({ players: updatedPlayers })
      .where(eq(pokerGames.gameCode, game.gameCode))
      .returning();

    return NextResponse.json({
      success: true,
      game: updatedGame,
      gameCode: updatedGame.gameCode,
    });
  } catch (err) {
    console.error("JOIN PUBLIC GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
