import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/client";
import { fourInARowGames } from "../db/schema";
import { READY_WINDOW_MS } from "./fourInARowServer";
import { normalizeStake } from "./games/stakes";

export async function createOrJoinFourInARowDestination({ userId, betAmount = 10, timerSeconds = 60 }) {
  const stake = normalizeStake(betAmount);
  const timer = [10, 30, 60, 120].includes(Number(timerSeconds)) ? Number(timerSeconds) : 60;

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(fourInARowGames).where(and(
      eq(fourInARowGames.status, "waiting"),
      isNull(fourInARowGames.guestClerkId),
      ne(fourInARowGames.hostClerkId, userId),
      eq(fourInARowGames.betAmount, stake.toFixed(2)),
    )).orderBy(asc(fourInARowGames.createdAt)).for("update").limit(1);

    if (open) {
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

    const [created] = await tx.insert(fourInARowGames).values({ hostClerkId: userId, betAmount: stake.toFixed(2), status: "waiting", timerSeconds: timer }).returning();
    return { match: created, joined: false };
  });
}
