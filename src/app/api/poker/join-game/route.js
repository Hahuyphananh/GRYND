import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function createDeck() {
  return SUITS.flatMap(suit => VALUES.map(value => ({ suit, value })));
}

function shuffle(deck) {
  return deck.sort(() => Math.random() - 0.5);
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");

    if (!code)
      return NextResponse.json({ error: "Missing invite code" }, { status: 400 });

    // 1️⃣ Fetch game
    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, code));

    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    // 2️⃣ Determine new player ID
    const existingPlayers = Array.isArray(game.players) ? game.players : [];
    const numJoined = existingPlayers.filter(p => p.id.startsWith("playerjoin")).length;
    const playerId = `playerjoin${numJoined + 1}`;

    // 3️⃣ Prepare deck and remove already-dealt cards
    const deck = shuffle(createDeck());
    existingPlayers.forEach(p => {
      p.hand.forEach(card => {
        const index = deck.findIndex(c => c.suit === card.suit && c.value === card.value);
        if (index !== -1) deck.splice(index, 1);
      });
    });

    // 4️⃣ Create new player with hand
    const newPlayer = {
      id: playerId,
      name: "You", // could be replaced by frontend-provided name
      stack: 1000,
      hand: [deck.pop(), deck.pop()],
      isAI: false,
      hasFolded: false,
      currentBet: 0,
      lastAction: "",
      isReady: false,
    };

    // 5️⃣ Save updated players to DB
    const updatedPlayers = [...existingPlayers, newPlayer];
    const [updatedGame] = await db
      .update(pokerGames)
      .set({ players: updatedPlayers })
      .where(eq(pokerGames.gameCode, code))
      .returning();

    return NextResponse.json({
      success: true,
      game: updatedGame,
    });
  } catch (err) {
    console.error("JOIN GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
