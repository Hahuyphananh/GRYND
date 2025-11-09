import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq, and, lt, sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const body = await req.json();
    const playerName = body.playerName ?? "Player";

    // 1️⃣ Get all public games that are not full
    const availableGames = await db
      .select()
      .from(pokerGames)
      .where(
        and(
          eq(pokerGames.isPrivate, false),
          lt(sql`jsonb_array_length(${pokerGames.players})`, pokerGames.maxPlayers)
        )
      );

    if (!availableGames || availableGames.length === 0) {
      return NextResponse.json(
        { error: "No available public games" },
        { status: 404 }
      );
    }

    // 2️⃣ Pick a random available game
    const randomGame = availableGames[Math.floor(Math.random() * availableGames.length)];

    // 3️⃣ Safely parse existing data
    const existingPlayers = Array.isArray(randomGame.players) ? randomGame.players : [];
    const community = Array.isArray(randomGame.community) ? randomGame.community : [];

    // 4️⃣ Prevent duplicate player name in that game
    if (existingPlayers.some((p) => p.name === playerName)) {
      return NextResponse.json(
        { error: "Player name already taken in this game" },
        { status: 400 }
      );
    }

    // 5️⃣ Assign player ID
    const playerId = `player${existingPlayers.length + 1}`;

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

    // 6️⃣ Update the selected game
    const [updatedGame] = await db
      .update(pokerGames)
      .set({
        players: updatedPlayers,
        community,
        lastUpdated: new Date(),
      })
      .where(eq(pokerGames.gameCode, randomGame.gameCode))
      .returning();

    // 7️⃣ Return safe, full response
    const safeGame = {
      ...updatedGame,
      players: updatedPlayers,
      community,
      pot: updatedGame.pot ?? 0,
      deck: updatedGame.deck ?? [],
      stage: updatedGame.stage ?? "pre-flop",
    };

    return NextResponse.json({
      success: true,
      game: safeGame,
      gameCode: safeGame.gameCode,
    });
  } catch (err) {
    console.error("JOIN PUBLIC GAME ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
