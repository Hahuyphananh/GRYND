import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { db as drizzleDb } from "../../../db/client";
import { users, farkleActions, farklePlayers, farkleRooms } from "../../../db/schema";
import {
  checkWinCondition,
  processRollResult,
  validateMove,
} from "../../../../game-engine/farkleEngine";
import { applyLeaderboardCounters } from "../../../lib/leaderboardCounters";

/** Create initial Farkle game state. */
export function initialState(roomId, creatorId, creatorName, wager) {
  return {
    id: roomId,
    game: "farkle",
    players: [{ userId: creatorId, name: creatorName }],
    ai: false,
    wager,
    pot: wager,
    state: "waiting",
    currentTurn: creatorId,
    turnNumber: 1,
    dice: Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1),
    turnScore: 0,
    rollsThisTurn: 0,
    scores: { [creatorId]: 0 },
    hasHotDice: false,
  };
}

/** Authenticate the current user via Clerk. */
export async function requireUser() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

/** Load a Farkle room from the database, throwing if not found. */
export async function loadRoom(roomId, tx = drizzleDb) {
  const [room] = await tx.select().from(farkleRooms).where(eq(farkleRooms.id, roomId));
  if (!room) throw new Error("Room not found");
  return room;
}

/** Append an action log entry for the room. */
export async function appendAction(tx, roomId, userId, actionType, payload) {
  await tx.insert(farkleActions).values({ roomId, userId, actionType, payload });
}

/** Deduct wager from user balance atomically. Throws if insufficient funds. */
export async function lockBalance(tx, userId, amount) {
  const [updated] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${amount}` })
    .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${amount}`))
    .returning({ balance: users.balance });
  if (!updated) throw new Error("Insufficient balance");
  return Number(updated.balance);
}

/** Get the display name for a user. */
export async function getDisplayName(userId, tx = drizzleDb) {
  const [u] = await tx
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);
  return u?.name || "Player";
}

/**
 * Check if the game has ended and, if so, pay out the winner
 * and mark the room as finished.
 * Per cardgames.io rules: first player to reach 10,000+ wins immediately.
 */
export async function settleIfEnded(tx, roomRow, state) {
  const ended = checkWinCondition(state);
  if (!ended.ended) return { state, ended: false };

  const payout = Math.floor(state.pot * 0.95);
  const winnerPlayer = state.players.find((p) => p.userId === ended.winnerId);
  if (winnerPlayer && !winnerPlayer.isAI) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, ended.winnerId));
  }

  state.winnerId = ended.winnerId;
  state.state = "finished";
  await tx
    .update(farkleRooms)
    .set({ status: "finished", gameState: state, pot: 0 })
    .where(eq(farkleRooms.id, roomRow.id));

  return {
    state,
    ended: true,
    winnerId: ended.winnerId,
    payout,
    scores: ended.scores,
  };
}


/**
 * Record leaderboard stats after the authoritative Farkle transaction commits.
 * This intentionally runs outside the game-state transaction because the
 * leaderboard helper uses its own DB connection and also updates users rows.
 */
export async function recordFarkleLeaderboardResults({ state, winnerId, payout = 0 }) {
  if (!state || !winnerId) return;

  try {
    const winnerPlayer = state.players?.find((p) => p.userId === winnerId);
    const loser = state.players?.find((p) => !p.isAI && p.userId !== winnerId);
    const isPvp = !state.ai && (state.players?.length ?? 0) >= 2;

    if (winnerPlayer && !winnerPlayer.isAI) {
      await applyLeaderboardCounters({
        clerkId: winnerId,
        game: "farkle",
        betAmount: state.wager,
        payout,
        isPvpWin: isPvp,
      });
    }

    if (loser) {
      await applyLeaderboardCounters({
        clerkId: loser.userId,
        game: "farkle",
        betAmount: state.wager,
        payout: 0,
      });
    }
  } catch (err) {
    console.error("Failed to update Farkle leaderboard counters", err);
  }
}

export {
  drizzleDb as db,
  eq,
  and,
  asc,
  sql,
  users,
  farkleRooms,
  farklePlayers,
  farkleActions,
  processRollResult,
  validateMove,
};
