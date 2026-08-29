import { and, asc, eq, isNull, not, sql } from "drizzle-orm";
import { db } from "../db";
import { hexDuelGames, users } from "../db/schema";

export async function createOrJoinHexDuelDestination({ userId, wager = 10 }) {
  const amount = Number(wager);
  if (!Number.isFinite(amount) || amount < 0) return { error: "Invalid Hex Duel wager", status: 400 };
  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(hexDuelGames).where(and(eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id), not(eq(hexDuelGames.player1Id, userId)), eq(hexDuelGames.wagerAmount, amount.toFixed(2)))).orderBy(asc(hexDuelGames.createdAt)).for("update").limit(1);
    if (open) {
      if (amount > 0) {
        const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.wagerAmount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.wagerAmount}`)).returning({ balance: users.balance });
        if (!funded) return { error: "Insufficient balance", status: 400 };
      }
      const [matched] = await tx.update(hexDuelGames).set({ player2Id: userId, status: "in_progress", currentTurn: "player1", lastActionSeq: 0, startedAt: new Date() }).where(and(eq(hexDuelGames.id, open.id), eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id))).returning();
      if (!matched) return { error: "Game is no longer available", status: 409 };
      return { match: matched, joined: true };
    }
    if (amount > 0) {
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${amount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${amount}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
    }
    const [created] = await tx.insert(hexDuelGames).values({ player1Id: userId, wagerAmount: amount.toFixed(2), winner: "pending", result: "pending", status: "waiting", isAiGame: false }).returning();
    return { match: created, joined: false };
  });
}
