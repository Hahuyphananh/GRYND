import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
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

    // 2️⃣ Create a temporary joining player
    const playerId = `player-${Date.now()}`;
    const player = {
      id: playerId,
      name: "You",         // or get from Clerk if logged in
      stack: 1000,
      hand: [],
      isAI: false,
      hasFolded: false,
      currentBet: 0,
      lastAction: "",
    };

    // 3️⃣ Return the game + the new player
    return NextResponse.json({
      success: true,
      game: {
        ...game,
        players: [player], // frontend can merge with existing players if needed
      },
    });
  } catch (err) {
    console.error("JOIN GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
