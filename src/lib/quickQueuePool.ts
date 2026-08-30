import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { poolLobbies, poolMatches } from "../db/schema";

export async function createOrJoinPoolDestination({ userId, wager = 10 }) {
  const amount = Math.trunc(Number(wager));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid Pool Masters wager", status: 400 };
  // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
  if (amount > 100000) return { error: "Wager exceeds the maximum of 100,000 tokens", status: 400 };

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(poolLobbies).where(and(eq(poolLobbies.status, "waiting"), eq(poolLobbies.gameMode, "pvp"), ne(poolLobbies.hostUserId, userId), eq(poolLobbies.wager, amount))).orderBy(asc(poolLobbies.createdAt)).for("update").limit(1);
    if (open) {
      const [lobby] = await tx.update(poolLobbies).set({ status: "active", opponentUserId: userId }).where(and(eq(poolLobbies.id, open.id), eq(poolLobbies.status, "waiting"), ne(poolLobbies.hostUserId, userId))).returning();
      if (!lobby) return { error: "Lobby is no longer available", status: 409 };
      const firstTurnSeat = Math.random() < 0.5 ? 1 : 2;
      const firstTurnUserId = firstTurnSeat === 1 ? lobby.hostUserId : userId;
      const [match] = await tx.insert(poolMatches).values({ id: crypto.randomUUID(), lobbyId: lobby.id, player1Id: lobby.hostUserId, player2Id: userId, wager: lobby.wager, status: "active", gameState: { started: true, turn: firstTurnSeat, version: Date.now() }, currentTurnUserId: firstTurnUserId }).returning();
      return { match, joined: true };
    }
    const [lobby] = await tx.insert(poolLobbies).values({ id: crypto.randomUUID(), hostUserId: userId, wager: amount, gameMode: "pvp", status: "waiting" }).returning();
    return { match: { id: lobby.id }, joined: false };
  });
}
