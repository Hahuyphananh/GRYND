import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { diceFlushPlayers, diceFlushRooms, users } from "../db/schema";
import { initialState } from "../app/api/dice-flush/_lib";

export async function createOrJoinDiceFlushDestination({ userId, wager = 10 }) {
  const amount = Number(wager);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid Dice Flush wager", status: 400 };

  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(diceFlushRooms)
      .where(and(eq(diceFlushRooms.status, "waiting"), eq(diceFlushRooms.wager, amount), ne(diceFlushRooms.id, "")))
      .orderBy(asc(diceFlushRooms.createdAt))
      .for("update")
      .limit(1);

    if (open) {
      const [existing] = await tx.select({ id: diceFlushPlayers.id }).from(diceFlushPlayers).where(and(eq(diceFlushPlayers.roomId, open.id), eq(diceFlushPlayers.userId, userId))).limit(1);
      if (existing) return { error: "Cannot join your own Dice Flush room", status: 400 };
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${open.wager}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${open.wager}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const state = typeof open.gameState === "object" && open.gameState ? { ...(open.gameState as Record<string, any>) } as any : null;
      if (!state || !Array.isArray(state.players) || state.players.length !== 1) return { error: "Dice Flush room is invalid", status: 409 };
      state.players = [...state.players, { userId, name: "Quick Queue Player" }];
      state.state = "playing";
      state.currentTurn = Math.random() < 0.5 ? state.players[0].userId : userId;
      state.turnDeadline = Date.now() + 20000;
      state.pot = Number(open.pot) + amount;
      const [matched] = await tx.update(diceFlushRooms).set({ status: "playing", pot: state.pot, gameState: state }).where(and(eq(diceFlushRooms.id, open.id), eq(diceFlushRooms.status, "waiting"))).returning();
      if (!matched) return { error: "Room is no longer available", status: 409 };
      await tx.insert(diceFlushPlayers).values({ roomId: open.id, userId, isAi: false, score: 0 });
      return { match: { ...matched, id: open.id }, joined: true };
    }

    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${amount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${amount}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const roomId = `yahtzee:quick-queue:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
    const state = initialState(roomId, userId, "Quick Queue Player", amount);
    await tx.insert(diceFlushRooms).values({ id: roomId, status: "waiting", wager: amount, pot: amount, gameState: state });
    await tx.insert(diceFlushPlayers).values({ roomId, userId, isAi: false, score: 0 });
    const [created] = await tx.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId)).limit(1);
    return { match: { ...created, id: roomId }, joined: false };
  });
}
