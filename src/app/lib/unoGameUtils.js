import { db } from "../../db/client";
import { users, unoGames } from "../../db/schema";
import { eq } from "drizzle-orm";

function generateUnoDeck() {
  const colors = ["red","yellow","green","blue"];
  const values = [...Array(10).keys()].map(n => n.toString())
    .concat(["skip","reverse","+2","wild","+4"]);
  let deck = [];
  colors.forEach(color => values.forEach(value => {
    const count = value === "0" || value.startsWith("+4") ? 1 : 2;
    for (let i = 0; i < count; i++) deck.push({ color, value });
  }));
  deck = deck.concat(Array(4).fill({ color: "wild", value: "+4" }));
  deck = deck.sort(() => Math.random() - 0.5);
  return deck;
}

export async function createUnoGame(userId, betAmount) {
  const deck = generateUnoDeck();
  const playerHand = deck.splice(0, 7);
  const aiHand = deck.splice(0, 7);
  const topCard = deck.shift();

  const newBalance = (await db.query.users.findFirst({ where: eq(users.id, userId) })).balance - betAmount;

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

  return {
    gameId: inserted.id,
    newBalance,
    playerHand,
    aiHand,
    topCard
  };
}
