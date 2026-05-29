import { NextResponse } from "next/server";
import { and, appendAction, db, eq, farkleRooms, loadRoom, requireUser, sql, users } from "../_lib";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;
      if (state.state === "finished") return { state };
      const winner = state.players.find((p) => p.userId !== userId);
      if (!winner) throw new Error("Cannot resign before opponent joins");

      // Log the resign action
      await appendAction(tx, roomId, userId, "resign", {
        resignerScore: state.scores[userId] ?? 0,
        winnerScore: state.scores[winner.userId] ?? 0,
        scores: state.scores,
      });

      const payout = Math.floor(Number(room.pot || state.pot || 0) * 0.95);
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, winner.userId));

      // Record the resigned game in leaderboard stats (only for human players)
      const isPvp = !state.ai && state.players.length >= 2;
      if (!winner.isAI) {
        await applyLeaderboardCounters({
          clerkId: winner.userId,
          game: "farkle",
          betAmount: state.wager,
          payout,
          isPvpWin: isPvp,
        });
      }
      await applyLeaderboardCounters({
        clerkId: userId,
        game: "farkle",
        betAmount: state.wager,
        payout: 0,
      });

      // The non-resigning player wins
      state.state = "finished";
      state.currentTurn = winner.userId;
      await tx
        .update(farkleRooms)
        .set({ status: "finished", pot: 0, gameState: state })
        .where(and(eq(farkleRooms.id, roomId), eq(farkleRooms.status, room.status)));
      return { state, winnerId: winner.userId, payout };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to resign" },
      { status: 400 },
    );
  }
}
