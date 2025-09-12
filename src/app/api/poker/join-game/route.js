import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames, pokerPlayerPositions } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");

    if (!code) {
      return NextResponse.json({ error: "Missing invite code" }, { status: 400 });
    }

    // 1️⃣ Find game by invite_code
    const [game] = await db.select().from(pokerGames).where(eq(pokerGames.inviteCode, code));
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    // 2️⃣ Count current players
    const playersDb = await db.select().from(pokerPlayerPositions).where(eq(pokerPlayerPositions.gameId, game.id));
    if (playersDb.length >= game.maxPlayers) {
      return NextResponse.json({ error: "Game is full" }, { status: 400 });
    }

    // 3️⃣ Add the joining player
    const playerId = `player-${Date.now()}`;
    const playerName = "You"; // or get from Clerk if logged in

    await db.insert(pokerPlayerPositions).values({
      gameId: game.id,
      playerId,
      position: playersDb.length,
      stack: "1000.00",     // string
      currentBet: "0.00",   // string
      hasFolded: false,
      isAllIn: false,
      isAI: false,
      hand: [],
      isTurn: false,
      lastAction: "",
      isReady: false,
    });

    // 4️⃣ Return game info + existing players, formatted for frontend
    const players = playersDb.map(p => ({
      id: p.playerId,
      name: p.name || "AI",
      stack: parseFloat(p.stack),
      hand: p.hand || [],
      isAI: p.isAI,
      hasFolded: p.hasFolded,
      currentBet: parseFloat(p.currentBet),
      lastAction: p.lastAction,
    }));

    // add joining player
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
