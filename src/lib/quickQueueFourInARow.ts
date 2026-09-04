import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { fourInARowGames, users } from "../db/schema";
import { READY_WINDOW_MS } from "./fourInARowServer";

export async function createOrJoinFourInARowDestination({ userId, betAmount = 10, timerSeconds = 60 }) {
  const stake = Number(betAmount);
  if (!Number.isFinite(stake) || stake <= 0) return { error: "Invalid Four-In-A-Row bet", status: 400 };
  const timer = [10, 30, 60, 120].includes(Number(timerSeconds)) ? Number(timerSeconds) : 60;

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(fourInARowGames).where(and(
      eq(fourInARowGames.status, "waiting"),
      isNull(fourInARowGames.guestClerkId),
      ne(fourInARowGames.hostClerkId, userId),
      eq(fourInARowGames.betAmount, stake.toFixed(2)),
    )).orderBy(asc(fourInARowGames.createdAt)).for("update").limit(1);

    if (open) {
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.betAmount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.betAmount}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const [joined] = await tx.update(fourInARowGames).set({
        guestClerkId: userId,
        // Both players present — brief "Match found!" ready window;
        // advanceReadyIfNeeded flips to in_progress once it passes.
        status: "ready",
        readyDeadlineAt: new Date(Date.now() + READY_WINDOW_MS),
      }).where(and(eq(fourInARowGames.id, open.id), eq(fourInARowGames.status, "waiting"), isNull(fourInARowGames.guestClerkId))).returning();
      if (!joined) return { error: "Game is no longer available", status: 409 };
      return { match: joined, joined: true };
    }

    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${stake}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const [created] = await tx.insert(fourInARowGames).values({ hostClerkId: userId, betAmount: stake.toFixed(2), status: "waiting", timerSeconds: timer }).returning();
    return { match: created, joined: false };
  });
}
