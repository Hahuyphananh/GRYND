import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chessGames } from "../db/schema";
import { normalizeStake } from "./games/stakes";

export async function createOrJoinChessDestination({ userId, betAmount = 10, timerMode = "5min", initialTimeSeconds = 300 }) {
  const stake = normalizeStake(betAmount);
  const seconds = Number(initialTimeSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return { error: "Invalid Chess settings", status: 400 };
  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(chessGames).where(and(eq(chessGames.status, "waiting"), isNull(chessGames.playerBlackId), eq(chessGames.isAiGame, false), eq(chessGames.betAmount, stake.toFixed(2)))).for("update").limit(1);
    if (open && open.playerWhiteId !== userId) {
      const [matched] = await tx.update(chessGames).set({ playerBlackId: userId, status: "in_progress", startedAt: new Date() }).where(and(eq(chessGames.id, open.id), eq(chessGames.status, "waiting"), isNull(chessGames.playerBlackId))).returning();
      if (!matched) return { error: "Game is no longer available", status: 409 };
      return { match: matched, joined: true };
    }
    const [created] = await tx.insert(chessGames).values({ playerWhiteId: userId, betAmount: stake.toFixed(2), timerMode, initialTimeSeconds: Math.floor(seconds), status: "waiting", isAiGame: false }).returning();
    return { match: created, joined: false };
  });
}
