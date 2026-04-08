import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { connectFourGames } from "../../../../db/schema";
import { checkWinner, getDropRow, isBoardFull } from "../../../../lib/connectFour";
import { ensureBoard, getPlayerRole, getUserAliases, nextMoveDeadline, settleConnectFourGame } from "../../../../lib/connectFourServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body?.gameId);
    const column = Number(body?.column);

    if (!Number.isFinite(gameId) || gameId <= 0 || !Number.isInteger(column) || column < 0 || column > 6) {
      return NextResponse.json({ error: "Invalid move payload" }, { status: 400 });
    }

    const userAliases = await getUserAliases(userId);

    const result = await db.transaction(async (tx) => {
      const [game] = await tx.select().from(connectFourGames).where(eq(connectFourGames.id, gameId)).for("update");
      if (!game) throw new Error("Game not found");
      if (game.status !== "in_progress") throw new Error("Game is not active");

      if (game.moveDeadlineAt && Date.now() > new Date(game.moveDeadlineAt).getTime()) {
        throw new Error("Move timer expired");
      }

      const role = getPlayerRole(game, userAliases);
      if (!role) throw new Error("Game not found");
      if (game.currentTurn !== role) throw new Error("Not your turn");

      const board = ensureBoard(game.board);
      const row = getDropRow(board, column);
      if (row < 0) throw new Error("Column is full");

      const disc = role === "host" ? 1 : 2;
      board[row][column] = disc;

      const hostDiscsUsed = Number(game.hostDiscsUsed || 0) + (role === "host" ? 1 : 0);
      const guestDiscsUsed = Number(game.guestDiscsUsed || 0) + (role === "guest" ? 1 : 0);
      const connected = checkWinner(board, row, column, disc);
      const fullBoard = isBoardFull(board);
      const nextTurn = role === "host" ? "guest" : "host";

      await tx
        .update(connectFourGames)
        .set({
          board,
          hostDiscsUsed,
          guestDiscsUsed,
          currentTurn: nextTurn,
          moveDeadlineAt: nextMoveDeadline(),
        })
        .where(eq(connectFourGames.id, game.id));

      return { connected, fullBoard, role, hostClerkId: game.hostClerkId, guestClerkId: game.guestClerkId };
    });

    if (result.connected) {
      const winnerClerkId = result.role === "host" ? result.hostClerkId : result.guestClerkId;
      await settleConnectFourGame(gameId, winnerClerkId, "win");
    } else if (result.fullBoard) {
      await settleConnectFourGame(gameId, null, "draw");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error?.message || "Failed to play move" }, { status: 400 });
  }
}
