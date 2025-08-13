import { db } from "../../db/client";
import { users, unoGames } from "../../db/schema";
import { eq } from "drizzle-orm";

// Generates a new shuffled UNO deck
function generateUnoDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = [...Array(10).keys()].map(n => n.toString())
    .concat(["skip", "reverse", "+2", "wild", "+4"]);

  let deck = [];
  colors.forEach(color => {
    values.forEach(value => {
      const count = value === "0" || value.startsWith("+4") ? 1 : 2;
      for (let i = 0; i < count; i++) {
        deck.push({ color, value });
      }
    });
  });

  // Add extra +4 wilds
  deck.push(...Array(4).fill({ color: "wild", value: "+4" }));

  // Shuffle
  deck.sort(() => Math.random() - 0.5);
  return deck;
}

// ✅ Create a new game
export async function createUnoGame(userId, betAmount) {
  const deck = generateUnoDeck();
  const playerHand = deck.splice(0, 7);
  const aiHand = deck.splice(0, 7);
  const topCard = deck.shift();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("User not found");
  const newBalance = user.balance - betAmount;

  const [inserted] = await db.transaction(async tx => {
    await tx.update(users).set({ balance: newBalance.toString() }).where(eq(users.id, userId));
    return await tx.insert(unoGames).values({
      userId: userId.toString(),
      betAmount: betAmount.toString(),
      result: "pending",
      payout: "0",
      deck: JSON.stringify(deck),
      playerHand: JSON.stringify(playerHand),
      aiHand: JSON.stringify(aiHand),
      topCard: JSON.stringify(topCard),
      isPlayerTurn: true,
    }).returning();
  });

  return { gameId: inserted.id, newBalance, playerHand, aiHand, topCard };
}

// ✅ Get an existing game by ID
export async function getUnoGameById(gameId) {
  const game = await db.query.unoGames.findFirst({ where: eq(unoGames.id, gameId) });
  return game || null;
}

// Draw a card from the deck without affecting the topCard
export function drawUnoCard(game) {
  const deck = typeof game.deck === "string" ? JSON.parse(game.deck) : game.deck;
  if (deck.length === 0) throw new Error("Deck empty");
  const card = deck.shift();
  game.deck = deck;
  return card;
}
// ✅ Update game state in DB
export async function updateUnoGameState(gameId, updatedGame) {
  await db.update(unoGames).set({
    deck: JSON.stringify(updatedGame.deck),
    playerHand: JSON.stringify(updatedGame.playerHand),
    aiHand: JSON.stringify(updatedGame.aiHand),
    discardPile: JSON.stringify(updatedGame.discardPile),
    currentColor: updatedGame.currentColor,
    topCard: JSON.stringify(updatedGame.discardPile[updatedGame.discardPile.length - 1]),
    isPlayerTurn: updatedGame.isPlayerTurn,
  }).where(eq(unoGames.id, gameId));
}
