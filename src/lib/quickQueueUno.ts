import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/client";
import { unoGames } from "../db/schema";
import { normalizeStake } from "./games/stakes";

function createDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw Two"];
  const deck = [];
  for (const color of colors) for (const value of values) {
    deck.push({ color, value });
    if (value !== "0") deck.push({ color, value });
  }
  for (let i = 0; i < 4; i++) for (const value of ["Wild", "Wild Draw Four"]) deck.push({ color: "black", value });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

export async function createOrJoinUnoDestination({ userId, betAmount = 10 }) {
  const stake = normalizeStake(betAmount);

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(unoGames).where(and(eq(unoGames.status, "waiting"), isNull(unoGames.player2Id), ne(unoGames.userId, userId), eq(unoGames.betAmount, stake.toFixed(2)))).orderBy(asc(unoGames.createdAt)).for("update").limit(1);
    if (open) {
      const deck = Array.isArray(open.deck) ? [...open.deck] : JSON.parse(String(open.deck || "[]"));
      const player2Hand = deck.splice(0, 7);
      const [matched] = await tx.update(unoGames).set({ player2Id: userId, player2Hand, deck, status: "active", turn: Math.random() > 0.5 ? "player1" : "player2" }).where(and(eq(unoGames.id, open.id), eq(unoGames.status, "waiting"), isNull(unoGames.player2Id))).returning();
      if (!matched) return { error: "Game is no longer available", status: 409 };
      return { match: matched, joined: true };
    }
    const deck = createDeck();
    const player1Hand = deck.splice(0, 7);
    let topCard = deck.pop();
    while (topCard && (topCard.value === "Wild" || topCard.value === "Wild Draw Four")) topCard = deck.pop();
    const [created] = await tx.insert(unoGames).values({ userId, player2Id: null, betAmount: stake.toFixed(2), pot: "0.00", result: "pending", payout: "0.00", winner: "pending", playerHand: [], aiHand: [], player1Hand, player2Hand: [], deck, discardPile: [topCard], topCard, currentColor: topCard?.color, turn: "player1", status: "waiting" }).returning();
    return { match: created, joined: false };
  });
}
