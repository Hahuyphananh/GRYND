import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq, and, ne, isNull } from "drizzle-orm";

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw Two"];
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

function safeParse(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });

  const { betAmount } = await request.json();
  if (!betAmount || isNaN(betAmount) || betAmount <= 0 || betAmount > 1000) {
    return new Response(JSON.stringify({ success: false, error: "Invalid bet amount" }), { status: 400 });
  }

  try {
    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });

    const balance = parseFloat(user.balance);
    if (balance < betAmount) return new Response(JSON.stringify({ success: false, error: "Insufficient balance" }), { status: 400 });

    const openGame = await db.query.unoGames.findFirst({
      where: and(
        eq(unoGames.status, "waiting"),
        eq(unoGames.betAmount, betAmount.toFixed(2)),
        isNull(unoGames.player2Id),
        ne(unoGames.userId, user.id)
      ),
    });

    if (openGame) {
      const deck = safeParse(openGame.deck, []);
      const player1Hand = safeParse(openGame.player1Hand, []);
      const player2Hand = deck.splice(0, 7);

      const updated = await db.transaction(async (tx) => {
        await tx.update(users)
          .set({ balance: (balance - betAmount).toFixed(2) })
          .where(eq(users.clerkId, userId));

        const [game] = await tx.update(unoGames)
          .set({
            player2Id: user.id,
            player2Hand,
            deck,
            status: "active",
            turn: Math.random() > 0.5 ? "player1" : "player2",
          })
          .where(and(eq(unoGames.id, openGame.id), isNull(unoGames.player2Id), eq(unoGames.status, "waiting")))
          .returning();

        if (!game) throw new Error("Game just got filled");
        return game;
      });

      return new Response(JSON.stringify({
        success: true,
        data: {
          id: updated.id,
          mode: "online",
          role: "player2",
          newBalance: (balance - betAmount).toFixed(2),
          playerHand: player2Hand,
          opponentHandCount: player1Hand.length,
          topCard: safeParse(updated.topCard, null),
          currentColor: updated.currentColor,
          turn: updated.turn,
        }
      }), { status: 200 });
    }

    const deck = generateDeck();
    const player1Hand = deck.splice(0, 7);

    let topCard;
    do {
      topCard = deck.pop();
    } while (topCard.value === "Wild" || topCard.value === "Wild Draw Four");

    const discardPile = [topCard];
    const currentColor = topCard.color;
    const pot = (betAmount * 2).toFixed(2);

    const [inserted] = await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ balance: (balance - betAmount).toFixed(2) })
        .where(eq(users.clerkId, userId));

      return await tx.insert(unoGames).values({
        userId: user.id,
        player2Id: null,
        betAmount: betAmount.toFixed(2),
        pot,
        result: "pending",
        payout: "0.00",
        winner: "pending",
        playerHand: [],
        aiHand: [],
        player1Hand,
        player2Hand: [],
        deck,
        discardPile,
        topCard,
        currentColor,
        turn: "player1",
        status: "waiting",
      }).returning();
    });

    return new Response(JSON.stringify({
      success: true,
      waiting: true,
      message: "⏳ Waiting for another player to join...",
      gameId: inserted.id,
      newBalance: (balance - betAmount).toFixed(2),
      role: "player1",
    }), { status: 200 });
  } catch (err) {
    console.error("UNO online error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), { status: 500 });
  }
}
