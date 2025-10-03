import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq, and } from "drizzle-orm";

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0","1","2","3","4","5","6","7","8","9","Skip","Reverse","Draw Two"];
  const wilds = ["Wild","Wild Draw Four"];
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

  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
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

    // check for waiting game
    const openGame = await db.query.unoGames.findFirst({
      where: and(eq(unoGames.status, "waiting"), eq(unoGames.betAmount, betAmount)),
    });

    if (openGame) {
      // 🎯 Join as player2
      const deck = JSON.parse(openGame.deck);
      const player2Hand = deck.splice(0, 7);

      const updated = await db.transaction(async (tx) => {
        await tx.update(users)
          .set({ balance: (balance - betAmount).toFixed(2) })
          .where(eq(users.clerkId, userId));

        const [game] = await tx.update(unoGames)
          .set({
            player2Id: user.id,
            player2Hand: JSON.stringify(player2Hand),
            deck: JSON.stringify(deck),
            status: "active",
            turn: Math.random() > 0.5 ? "player1" : "player2",
          })
          .where(eq(unoGames.id, openGame.id))
          .returning();

        return game;
      });

      return new Response(JSON.stringify({
        success: true,
        data: {
          id: updated.id,
          newBalance: (balance - betAmount).toFixed(2),
          playerHand: player2Hand,
          opponentHandCount: JSON.parse(openGame.player1Hand).length,
          topCard: JSON.parse(openGame.topCard),
          currentColor: openGame.currentColor,
          turn: updated.turn,
        }
      }), { status: 200 });

    } else {
      // 🎯 No opponent → create waiting game
      const deck = generateDeck();
      const player1Hand = deck.splice(0, 7);

      // Pick non-wild top card
      let topCard;
      do { topCard = deck.pop(); } while (topCard.value === "Wild" || topCard.value === "Wild Draw Four");

      const discardPile = [topCard];
      const currentColor = topCard.color;
      const pot = (betAmount * 2).toFixed(2);

      const [inserted] = await db.transaction(async (tx) => {
        await tx.update(users)
          .set({ balance: (balance - betAmount).toFixed(2) })
          .where(eq(users.clerkId, userId));

        return await tx.insert(unoGames).values({
  userId: user.id,
  betAmount: betAmount.toFixed(2),
  pot,
  result: "pending",
  payout: "0.00",
  player_hand: JSON.stringify([]), // satisfies NOT NULL
ai_hand: JSON.stringify([]),              // satisfies NOT NULL
player1_hand: JSON.stringify(player1Hand),
player2_hand: JSON.stringify([]),          // empty until joined
  deck: JSON.stringify(deck),
  discardPile: JSON.stringify(discardPile),
  topCard: JSON.stringify(topCard),
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
}), { status: 200 });
    }

  } catch (err) {
    console.error("UNO online error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), { status: 500 });
  }
}
