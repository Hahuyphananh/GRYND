import { db } from "../../db/client";
import { users, unoGames } from "../../db/schema";
import { eq } from "drizzle-orm";

// Generates a new shuffled UNO deck
function generateUnoDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = [...Array(10).keys()]
    .map((n) => n.toString())
    .concat(["skip", "reverse", "+2", "wild", "+4"]);

  let deck = [];
  colors.forEach((color) => {
    values.forEach((value) => {
      const count = value === "0" || value.startsWith("+4") ? 1 : 2;
      for (let i = 0; i < count; i++) {
        deck.push({ color, value });
      }
    });
  });

  // Add extra +4 wilds
  for (let i = 0; i < 4; i++) {
    deck.push({ color: "wild", value: "+4" });
  }

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

//  Create a new game
export async function createUnoGame(userId, betAmount) {
  const deck = generateUnoDeck();
  const playerHand = deck.splice(0, 7);
  const aiHand = deck.splice(0, 7);
  const topCard = deck.shift();
  const discardPile = [topCard]; // THIS is what prevents the top card from disappearing

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("User not found");
  const newBalance = user.balance - betAmount;

  const [inserted] = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ balance: newBalance.toString() })
      .where(eq(users.id, userId));
    return await tx
      .insert(unoGames)
      .values({
        userId: userId.toString(),
        betAmount: betAmount.toString(),
        result: "pending",
        payout: "0",
        deck: JSON.stringify(deck),
        playerHand: JSON.stringify(playerHand),
        aiHand: JSON.stringify(aiHand),

        discardPile: JSON.stringify(discardPile), // ADD THIS
        currentColor: topCard.color, // ADD THIS

        topCard: JSON.stringify(topCard), // optional but fine
        isPlayerTurn: true,
      })
      .returning();
  });

  return { gameId: inserted.id, newBalance, playerHand, aiHand, topCard };
}

//  Get an existing game by ID
export async function getUnoGameById(gameId) {
  const game = await db.query.unoGames.findFirst({
    where: eq(unoGames.id, gameId),
  });
  return game || null;
}

// Draw a card from the deck without affecting the topCard
export function drawUnoCard(deck) {
  if (!deck || deck.length === 0) {
    throw new Error("Deck empty");
  }

  const newDeck = [...deck]; // clone
  const card = newDeck.shift();

  return { card, deck: newDeck };
}

//  Update game state in DB
export async function updateUnoGameState(gameId, updatedGame) {
  await db
    .update(unoGames)
    .set({
      deck: JSON.stringify(updatedGame.deck),
      playerHand: JSON.stringify(updatedGame.playerHand),
      aiHand: JSON.stringify(updatedGame.aiHand),
      discardPile: JSON.stringify(updatedGame.discardPile),
      currentColor: updatedGame.currentColor,
      topCard: JSON.stringify(
        updatedGame.discardPile[updatedGame.discardPile.length - 1],
      ),
      turn: updatedGame.turn || (updatedGame.isPlayerTurn ? "player" : "ai"),
    })
    .where(eq(unoGames.id, gameId));
}
