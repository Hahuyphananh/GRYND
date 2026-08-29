import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { rpsPvpGames, users } from "../db/schema";

export async function createOrJoinRpsDestination({ userId, betAmount = 10 }) {
  const stake = Number(betAmount);
  if (!Number.isFinite(stake) || stake <= 0) return { error: "Invalid RPS bet", status: 400 };

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(rpsPvpGames).where(and(
      eq(rpsPvpGames.status, "active"),
      isNull(rpsPvpGames.player2Id),
      eq(rpsPvpGames.betAmount, stake.toFixed(2)),
    )).orderBy(asc(rpsPvpGames.createdAt)).for("update").limit(1);

    if (open && open.player1Id !== userId) {
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.betAmount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.betAmount}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const [matched] = await tx.update(rpsPvpGames).set({ player2Id: userId, status: "matched" }).where(and(eq(rpsPvpGames.id, open.id), eq(rpsPvpGames.status, "active"), isNull(rpsPvpGames.player2Id))).returning();
      if (!matched) return { error: "Game is no longer available", status: 409 };
      return { match: matched, joined: true };
    }

    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${stake}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const [created] = await tx.insert(rpsPvpGames).values({ player1Id: userId, betAmount: stake.toFixed(2), status: "active" }).returning();
    return { match: created, joined: false };
  });
}
