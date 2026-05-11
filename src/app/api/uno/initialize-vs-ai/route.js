import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Skip",
    "Reverse",
    "Draw Two",
  ];
  const wilds = ["Wild", "Wild Draw Four"];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push({ color, value });
      if (value !== "0") deck.push({ color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    for (const wild of wilds) deck.push({ color: "black", value: wild });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function cardStrength(card) {
  const value = card.value.toLowerCase();
  if (value === "wild draw four") return 10;
  if (value === "draw two") return 8;
  if (value === "wild") return 7;
  if (value === "skip" || value === "reverse") return 6;
  if (/^\d+$/.test(card.value)) return 2 + (9 - Number(card.value)) / 10;
  return 1;
}

function slightlyBoostAiOpeningHand(deck, playerHand, aiHand) {
  const shouldBoost = Math.random() < 0.65;
  if (!shouldBoost || deck.length < 8) return { deck, playerHand, aiHand };

  const weakAiIndex = aiHand
    .map((card, index) => ({ card, index }))
    .sort((a, b) => cardStrength(a.card) - cardStrength(b.card))[0]?.index;

  const strongDeckIndex = deck
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardStrength(card) >= 6)
    .sort((a, b) => cardStrength(b.card) - cardStrength(a.card))[0]?.index;

  if (weakAiIndex === undefined || strongDeckIndex === undefined) {
    return { deck, playerHand, aiHand };
  }

  const incomingCard = deck[strongDeckIndex];
  const outgoingCard = aiHand[weakAiIndex];

  aiHand[weakAiIndex] = incomingCard;
  deck[strongDeckIndex] = outgoingCard;

  return { deck, playerHand, aiHand };
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId)
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );

  const { betAmount } = await request.json();
  if (!betAmount || isNaN(betAmount) || betAmount <= 0 || betAmount > 1000) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid bet amount" }),
      { status: 400 },
    );
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user)
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 },
      );

    const balance = parseFloat(user.balance);
    if (balance < betAmount)
      return new Response(
        JSON.stringify({ success: false, error: "Insufficient balance" }),
        { status: 400 },
      );

    let deck = generateDeck();
    const playerHand = deck.splice(0, 7);
    let aiHand = deck.splice(0, 7);

    ({ deck, aiHand } = slightlyBoostAiOpeningHand(deck, playerHand, aiHand));

    let topCard;
    do {
      topCard = deck.pop();
    } while (topCard.value === "Wild" || topCard.value === "Wild Draw Four");

    const discardPile = [topCard];
    const currentColor = topCard.color;
    const pot = (betAmount * 2).toFixed(2);

    const result = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ balance: (balance - betAmount).toFixed(2) })
        .where(eq(users.clerkId, userId));

      const inserted = await tx
        .insert(unoGames)
        .values({
          userId: user.id,
          betAmount: betAmount.toFixed(2),
          pot,
          result: "pending",
          payout: "0.00",
          playerHand,
          aiHand,
          deck,
          discardPile,
          topCard,
          currentColor,
          turn: "player",
          status: "active",
          winner: "pending",
        })
        .returning();

      return inserted[0];
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          id: result.id,
          newBalance: (balance - betAmount).toFixed(2),
          playerHand,
          aiHand: ["?", "?", "?", "?", "?", "?", "?"],
          discardPile,
          topCard,
          currentColor,
          turn: "player",
          pot,
        },
      }),
      { status: 200 },
    );
  } catch (err) {
    console.error("UNO AI init error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500 },
    );
  }
}
