import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { diceLobbies, diceMatches, users } from "../db/schema";

export async function createOrJoinDiceDuelDestination({ userId, wager = 10 }) {
  const amount = Number(wager);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid Dice Duel wager", status: 400 };

  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(diceLobbies).where(and(eq(diceLobbies.status, "waiting"), isNull(diceLobbies.opponentUserId), ne(diceLobbies.hostUserId, userId), eq(diceLobbies.wager, Math.trunc(amount)))).orderBy(asc(diceLobbies.createdAt)).for("update").limit(1);
    if (open) {
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.wager}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.wager}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const [lobby] = await tx.update(diceLobbies).set({ opponentUserId: userId, status: "active" }).where(and(eq(diceLobbies.id, open.id), eq(diceLobbies.status, "waiting"), isNull(diceLobbies.opponentUserId))).returning();
      if (!lobby) return { error: "Lobby is no longer available", status: 409 };
      const turnUserId = Math.random() < 0.5 ? lobby.hostUserId : userId;
      const [match] = await tx.insert(diceMatches).values({ lobbyId: lobby.id, player1Id: lobby.hostUserId, player2Id: userId, wager: lobby.wager, houseFee: sql`(${lobby.wager} * 2 * 2) / 100`, prizePaid: 0, hp1: 20, hp2: 20, turnUserId, round: 1, status: "active" }).returning();
      return { match, joined: true };
    }

    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${Math.trunc(amount)}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${Math.trunc(amount)}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const [lobby] = await tx.insert(diceLobbies).values({ hostUserId: userId, wager: Math.trunc(amount), status: "waiting" }).returning();
    return { match: { id: lobby.id }, joined: false };
  });
}
