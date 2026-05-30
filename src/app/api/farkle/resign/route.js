import { NextResponse } from "next/server";
import { and, appendAction, db, eq, farkleRooms, loadRoom, recordFarkleLeaderboardResults, requireUser, sql, users } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId)
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;
      if (!state.players.some((p) => p.userId === userId)) throw new Error("Not a player in this room");
      if (state.state === "finished") return { state, winnerId: state.winnerId };

      const winner = state.players.find((p) => p.userId !== userId);
      if (!winner) throw new Error("Cannot resign before opponent joins");

      // Log the resign action
      await appendAction(tx, roomId, userId, "resign", {
        resignerScore: state.scores[userId] ?? 0,
        winnerScore: state.scores[winner.userId] ?? 0,
        scores: state.scores,
      });

      const payout = Math.floor(Number(room.pot || state.pot || 0) * 0.95);
      if (!winner.isAI) {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${payout}` })
          .where(eq(users.clerkId, winner.userId));
      }

      // The non-resigning player wins immediately.
      const finishedState = {
        ...state,
        winnerId: winner.userId,
        state: "finished",
        currentTurn: winner.userId,
      };

      await tx
        .update(farkleRooms)
        .set({ status: "finished", pot: 0, gameState: finishedState })
        .where(and(eq(farkleRooms.id, roomId), eq(farkleRooms.status, room.status)));

      return { state: finishedState, winnerId: winner.userId, payout };
    });
    if (result.payout !== undefined) {
      await recordFarkleLeaderboardResults(result);
    }

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to resign" },
      { status: 400 },
    );
  }
}
