import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");

    if (!code)
      return NextResponse.json({ error: "Missing invite code" }, { status: 400 });

    // Fetch game by code
    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, code));

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    // In this simplified version, we just create a "virtual" player list
    // There is no DB persistence of players
    const playerId = `player-${Date.now()}`;
    const playerName = "You"; // Replace with Clerk name if available

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

    // Just return this one player as the game "players"
    const players = [newPlayer];

    return NextResponse.json({
      success: true,
      game: {
        ...game,
        players,
      },
    });
  } catch (err) {
    console.error("JOIN GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
