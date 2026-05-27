import { NextResponse } from "next/server";
import {
  and,
  db,
  eq,
  farklePlayers,
  farkleRooms,
  getDisplayName,
  loadRoom,
  lockBalance,
  requireUser,
} from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId)
      return NextResponse.json(
        { success: false, error: "roomId required" },
        { status: 400 },
      );

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      if (room.status !== "waiting") throw new Error("Room unavailable");

      await lockBalance(tx, userId, room.wager);

      const state = room.gameState;

      // Prevent duplicate joins (creator re-joining or same player joining twice)
      if (state.players.some((p) => p.userId === userId)) {
        throw new Error("You are already in this room");
      }

      const name = await getDisplayName(userId, tx);

      // Add second player to the game
      state.players.push({ userId, name, isAI: false });
      state.scores[userId] = 0;
      state.state = "playing";
      state.pot += room.wager;

      // Randomize who goes first
      if (Math.random() < 0.5) {
        state.currentTurn = userId;
      }

      // Initial roll for turn 1
      state.dice = Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1);

      await tx.insert(farklePlayers).values({
        roomId,
        userId,
        isAi: false,
        score: 0,
      });

      await tx
        .update(farkleRooms)
        .set({ status: "playing", pot: state.pot, gameState: state })
        .where(
          and(
            eq(farkleRooms.id, roomId),
            eq(farkleRooms.status, "waiting"),
          ),
        );

      return state;
    });

    return NextResponse.json({ success: true, state: result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to join" },
      { status: 400 },
    );
  }
}
