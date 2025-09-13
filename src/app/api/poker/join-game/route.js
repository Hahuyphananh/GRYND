import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames, pokerPlayerPositions } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");

    if (!code) return NextResponse.json({ error: "Missing invite code" }, { status: 400 });

    const [game] = await db.select().from(pokerGames).where(eq(pokerGames.gameCode, code));
    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const playersDb = await db
      .select()
      .from(pokerPlayerPositions)
      .where(eq(pokerPlayerPositions.gameId, game.id));

    if (playersDb.length >= game.maxPlayers)
      return NextResponse.json({ error: "Game is full" }, { status: 400 });

    // Add joining player
    const playerId = `player-${Date.now()}`;
    const playerName = "You"; // replace with Clerk name if available

    await db.insert(pokerPlayerPositions).values({
      gameId: game.id,
      playerId,
      position: playersDb.length,
      stack: "1000.00",
      currentBet: "0.00",
      hasFolded: false,
      isAllIn: false,
      isAI: false,
      hand: [],
      isTurn: false,
      lastAction: "",
      isReady: false,
    });

    // Format players for frontend
    const players = playersDb.map(p => ({
      id: p.playerId,
      name: p.playerName || "AI",
      stack: parseFloat(p.stack),
      hand: p.hand || [],
      isAI: p.isAI,
      hasFolded: p.hasFolded,
      currentBet: parseFloat(p.currentBet),
      lastAction: p.lastAction,
    }));

    players.push({
      id: playerId,
      name: playerName,
      stack: 1000,
      hand: [],
      isAI: false,
      hasFolded: false,
      currentBet: 0,
      lastAction: "",
    });

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
