import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { dotsAndBoxesGames, users } from "../db/schema";
import { READY_WINDOW_MS } from "./dotsAndBoxesServer";

export async function createOrJoinDotsAndBoxesDestination({ userId, betAmount = 10, timerSeconds = 20 }) {
  const stake = Number(betAmount);
  if (!Number.isFinite(stake) || stake <= 0) return { error: "Invalid Dots and Boxes bet", status: 400 };
  const timer = Number.isInteger(Number(timerSeconds)) ? Math.min(120, Math.max(5, Number(timerSeconds))) : 20;

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(dotsAndBoxesGames).where(and(
      eq(dotsAndBoxesGames.status, "waiting"),
      isNull(dotsAndBoxesGames.guestClerkId),
      ne(dotsAndBoxesGames.hostClerkId, userId),
      eq(dotsAndBoxesGames.betAmount, stake.toFixed(2)),
    )).orderBy(asc(dotsAndBoxesGames.createdAt)).for("update").limit(1);

    if (open) {
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.betAmount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.betAmount}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const [joined] = await tx.update(dotsAndBoxesGames).set({
        guestClerkId: userId,
        // Both players present — brief "Match found!" ready window;
        // advanceReadyIfNeeded flips to in_progress once it passes.
        status: "ready",
        readyDeadlineAt: new Date(Date.now() + READY_WINDOW_MS),
      }).where(and(eq(dotsAndBoxesGames.id, open.id), eq(dotsAndBoxesGames.status, "waiting"), isNull(dotsAndBoxesGames.guestClerkId))).returning();
      if (!joined) return { error: "Game is no longer available", status: 409 };
      return { match: joined, joined: true };
    }

    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${stake}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const [created] = await tx.insert(dotsAndBoxesGames).values({ hostClerkId: userId, betAmount: stake.toFixed(2), status: "waiting", timerSeconds: timer }).returning();
    return { match: created, joined: false };
  });
}
