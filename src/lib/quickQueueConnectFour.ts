import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { connectFourGames, users } from "../db/schema";
import { getGameMoveSeconds, nextMoveDeadline } from "./connectFourServer";

export async function createOrJoinConnectFourDestination({ userId, betAmount = 10, timerSeconds = 60 }) {
  const stake = Number(betAmount);
  if (!Number.isFinite(stake) || stake <= 0) return { error: "Invalid Connect Four bet", status: 400 };
  const timer = [10, 30, 60, 120].includes(Number(timerSeconds)) ? Number(timerSeconds) : 60;

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(connectFourGames).where(and(
      eq(connectFourGames.status, "waiting"),
      isNull(connectFourGames.guestClerkId),
      ne(connectFourGames.hostClerkId, userId),
      eq(connectFourGames.betAmount, stake.toFixed(2)),
    )).orderBy(asc(connectFourGames.createdAt)).for("update").limit(1);

    if (open) {
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.betAmount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.betAmount}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const [joined] = await tx.update(connectFourGames).set({ guestClerkId: userId, status: "in_progress", startedAt: new Date(), currentTurn: "host", moveDeadlineAt: nextMoveDeadline(getGameMoveSeconds(open)) }).where(and(eq(connectFourGames.id, open.id), eq(connectFourGames.status, "waiting"), isNull(connectFourGames.guestClerkId))).returning();
      if (!joined) return { error: "Game is no longer available", status: 409 };
      return { match: joined, joined: true };
    }

    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${stake}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const [created] = await tx.insert(connectFourGames).values({ hostClerkId: userId, betAmount: stake.toFixed(2), status: "waiting", timerSeconds: timer }).returning();
    return { match: created, joined: false };
  });
}
