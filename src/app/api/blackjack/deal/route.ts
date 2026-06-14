import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
];

type Card = { suit: string; value: string };

/** Fisher-Yates shuffle */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build a full 52-card deck */
function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  return shuffle(deck);
}

/** Pop N cards from the deck (mutates the array) */
function drawCards(deck: Card[], count: number): Card[] {
  return deck.splice(0, count);
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Non authentifié" },
      { status: 401 },
    );
  }

  const deck = buildDeck();
  const playerCards = drawCards(deck, 2);
  const dealerCards = drawCards(deck, 2);

  return NextResponse.json({
    success: true,
    data: {
      playerCards,
      dealerCards,
      remainingDeck: deck,
    },
  });
}
