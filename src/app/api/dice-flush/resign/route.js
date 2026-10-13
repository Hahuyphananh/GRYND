import { NextResponse } from "next/server";
import { and, assertRoomSeat, db, eq, errorStatus, loadRoom, payPvpPot, diceFlushRooms } from "../_lib";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";

export async function POST(req) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { roomId } = await req.json();
    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;
      assertRoomSeat(state, userId);
      if (state.state === "finished") return { state };
      const winner = state.players.find((p) => p.userId !== userId);
      if (!winner) throw new Error("Cannot resign before opponent joins");
      const isAiMatch = !!state.players?.some((p) => p.isAI);
      const staked = !isAiMatch && Number(room.wager) > 0;
      // Stamp the finished state BEFORE writing it, then let the conditional
      // UPDATE act as the settlement claim: only the first resignation from
      // this room state can claim the row, so the payout below can never run
      // twice (and a resignation from a finished room returned above).
      state.state = "finished";
      state.currentTurn = winner.userId;
      const [claimed] = await tx.update(diceFlushRooms).set({ status: "finished", pot: 0, gameState: state }).where(and(eq(diceFlushRooms.id, roomId), eq(diceFlushRooms.status, room.status))).returning({ id: diceFlushRooms.id });
      let payout = 0;
      if (claimed && staked) {
        // The winner banks the pot out of the escrow both seats funded at join;
        // the resigner's stake is forfeit by definition.
        payout = await payPvpPot({
          tx,
          gameKey: "dice-flush",
          matchId: roomId,
          winnerClerkId: winner.userId,
          stake: Number(room.wager),
        });
      }
      return { state, winnerId: winner.userId, payout };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to resign" }, { status: errorStatus(e) });
  }
}
