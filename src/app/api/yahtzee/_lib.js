import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { users, yahtzeeActions, yahtzeePlayers, yahtzeeRooms } from "../../../db/schema";
import { checkGameEnd, holdDice, nextTurn, rollDice, validateMove } from "../../../../game-engine/yahtzeeEngine";

export function initialState(roomId, creatorId, creatorName, wager) {
  return {
    id: roomId,
    game: "yahtzee",
    players: [{ userId: creatorId, name: creatorName }],
    ai: false,
    wager,
    pot: wager,
    state: "waiting",
    currentTurn: creatorId,
    turnNumber: 1,
    rollsThisTurn: 0,
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    scorecards: { [creatorId]: {} },
  };
}

export async function requireUser() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

export async function loadRoom(roomId, tx = db) {
  const [room] = await tx.select().from(yahtzeeRooms).where(eq(yahtzeeRooms.id, roomId));
  if (!room) throw new Error("Room not found");
  return room;
}

export async function appendAction(tx, roomId, userId, actionType, payload) {
  await tx.insert(yahtzeeActions).values({ roomId, userId, actionType, payload });
}

export async function lockBalance(tx, userId, amount) {
  const [updated] = await tx.update(users).set({ balance: sql`${users.balance} - ${amount}` }).where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${amount}`)).returning({ balance: users.balance });
  if (!updated) throw new Error("Insufficient balance");
  return Number(updated.balance);
}

export async function getDisplayName(userId, tx = db) {
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.clerkId, userId)).limit(1);
  return u?.name || "Player";
}

export async function settleIfEnded(tx, roomRow, state) {
  const ended = checkGameEnd(state);
  if (!ended.ended) return { state, ended: false };
  const payout = Math.floor(state.pot * 0.95);
  await tx.update(users).set({ balance: sql`${users.balance} + ${payout}` }).where(eq(users.clerkId, ended.winnerId));
  state.state = "finished";
  await tx.update(yahtzeeRooms).set({ status: "finished", gameState: state, pot: 0 }).where(eq(yahtzeeRooms.id, roomRow.id));
  return { state, ended: true, winnerId: ended.winnerId, payout, totals: ended.totals };
}

export { db, eq, and, asc, isNull, ne, sql, users, yahtzeeRooms, yahtzeePlayers, rollDice, holdDice, validateMove, nextTurn };
