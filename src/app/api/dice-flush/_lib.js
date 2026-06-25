import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { users, diceFlushActions, diceFlushPlayers, diceFlushRooms } from "../../../db/schema";
import { checkGameEnd, holdDice, nextTurn, rollDice, validateMove } from "../../../../game-engine/diceFlushEngine";
import { applyLeaderboardCounters } from "../../../lib/leaderboardCounters";

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
  const [room] = await tx.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId));
  if (!room) throw new Error("Room not found");
  return room;
}

export async function appendAction(tx, roomId, userId, actionType, payload) {
  await tx.insert(diceFlushActions).values({ roomId, userId, actionType, payload });
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
  await tx.update(diceFlushRooms).set({ status: "finished", gameState: state, pot: 0 }).where(eq(diceFlushRooms.id, roomRow.id));

  // Record leaderboard stats for winner and loser
  const wagerPerPlayer = state.wager || Math.floor(state.pot / (state.players?.length || 2));
  // Any player being AI means this was a free-play match: no wagers
  // ever moved on the ledger, so we must pass betAmount=0 to the
  // leaderboard counters — otherwise total_wagered / weekly_wagered
  // get inflated by phantom wagers and the player appears to have
  // wagered tokens they never actually risked.
  const isAiMatch = !!state.players?.some((p) => p.isAI);
  const betAmountForCounters = isAiMatch ? 0 : wagerPerPlayer;
  applyLeaderboardCounters({
    clerkId: ended.winnerId,
    game: "Dice Flush",
    betAmount: betAmountForCounters,
    payout,
    isPvpWin: state.players?.length > 1 && !isAiMatch,
  }).catch(() => {});

  // Record loss for other player(s)
  if (state.players) {
    for (const p of state.players) {
      if (p.userId !== ended.winnerId && !p.isAI) {
        applyLeaderboardCounters({
          clerkId: p.userId,
          game: "Dice Flush",
          betAmount: betAmountForCounters,
          payout: 0,
        }).catch(() => {});
      }
    }
  }

  return { state, ended: true, winnerId: ended.winnerId, payout, totals: ended.totals };
}

export { db, eq, and, asc, isNull, ne, sql, users, diceFlushRooms, diceFlushPlayers, rollDice, holdDice, validateMove, nextTurn };
