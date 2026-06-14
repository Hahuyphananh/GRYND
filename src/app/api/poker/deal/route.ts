import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

const SUITS = ["hearts", "diamonds", "clubs", "spades"];
const VALUES = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function createDeck() {
  const deck: { suit: string; value: string }[] = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { gameCode, action } = await req.json();

    if (!gameCode) {
      return NextResponse.json({ error: "Missing gameCode" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, gameCode));

    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const meta = (game.playerPositions ?? {}) as Record<string, unknown>;
    if (meta.hostClerkId && meta.hostClerkId !== userId) {
      return NextResponse.json({ error: "Only host can deal" }, { status: 403 });
    }

    if (action === "new_hand") {
      // Generate a new shuffled deck
      const deck = createDeck();
      const deckSymbols = deck.map((c) => ({
        ...c,
        suit:
          c.suit === "hearts" ? "♥" :
          c.suit === "diamonds" ? "♦" :
          c.suit === "clubs" ? "♣" : "♠",
      }));

      await db
        .update(pokerGames)
        .set({ deck: deck as any })
        .where(eq(pokerGames.gameCode, gameCode));

      return NextResponse.json({
        success: true,
        deck: deckSymbols,
        deckSize: deck.length,
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("Poker deal error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
