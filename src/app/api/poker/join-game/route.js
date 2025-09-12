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
    const players = await db.select().from(pokerPlayerPositions).where(eq(pokerPlayerPositions.gameId, game.id));
    if (players.length >= game.maxPlayers) {
      return NextResponse.json({ error: "Game is full" }, { status: 400 });
    }

    // 3️⃣ Add the joining player
    // Replace with Clerk user ID or temp ID if not logged in
    const playerId = `player-${Date.now()}`;

await db.insert(pokerPlayerPositions).values({
  gameId: game.id,        // ✅ number
  playerId,               // ✅ string | null
  position: players.length, 
  stack: "1000.00",       // ✅ MUST be string
  currentBet: "0.00",     // ✅ MUST be string
  hasFolded: false,
  isAllIn: false,
  isAI: false,
  hand: [],
  isTurn: false,
  lastAction: "",
  isReady: false,
});


    // Return game info + existing players
    return NextResponse.json({
      success: true,
      game: {
        ...game,
        players: [...players, { playerId, stack: 1000, isAI: false }],
      },
    });
  } catch (err) {
    console.error("JOIN GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
