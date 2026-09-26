import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { rpsPvpGames } from "../db/schema";
import { normalizeStake } from "./games/stakes";

export async function createOrJoinRpsDestination({ userId, betAmount = 10 }) {
  const stake = normalizeStake(betAmount);

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(rpsPvpGames).where(and(
      eq(rpsPvpGames.status, "active"),
      isNull(rpsPvpGames.player2Id),
      eq(rpsPvpGames.betAmount, stake.toFixed(2)),
    )).orderBy(asc(rpsPvpGames.createdAt)).for("update").limit(1);

    if (open && open.player1Id !== userId) {
      const [matched] = await tx.update(rpsPvpGames).set({ player2Id: userId, status: "matched" }).where(and(eq(rpsPvpGames.id, open.id), eq(rpsPvpGames.status, "active"), isNull(rpsPvpGames.player2Id))).returning();
      if (!matched) return { error: "Game is no longer available", status: 409 };
      return { match: matched, joined: true };
    }

    const [created] = await tx.insert(rpsPvpGames).values({ player1Id: userId, betAmount: stake.toFixed(2), status: "active" }).returning();
    return { match: created, joined: false };
  });
}
