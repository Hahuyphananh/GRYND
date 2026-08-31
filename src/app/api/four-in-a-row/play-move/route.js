import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { fourInARowGames } from "../../../../db/schema";
import {
  checkWinner,
  getDropRow,
  isBoardFull,
} from "../../../../lib/fourInARow";
import {
  ensureBoard,
  getGameMoveSeconds,
  getPlayerRole,
  getUserAliases,
  nextMoveDeadline,
  settleFourInARowGame,
} from "../../../../lib/fourInARowServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body?.gameId);
    const column = Number(body?.column);

    if (
      !Number.isFinite(gameId) ||
      gameId <= 0 ||
      !Number.isInteger(column) ||
      column < 0 ||
      column > 6
    ) {
      return NextResponse.json(
        { error: "Invalid move payload" },
        { status: 400 },
      );
    }

    const userAliases = await getUserAliases(userId);

    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(fourInARowGames)
        .where(eq(fourInARowGames.id, gameId))
        .for("update");
      if (!game) throw new Error("Game not found");
      if (game.status !== "in_progress") throw new Error("Game is not active");

      if (
        game.moveDeadlineAt &&
        Date.now() > new Date(game.moveDeadlineAt).getTime()
      ) {
        return {
          timeout: true,
          role: null,
          hostClerkId: game.hostClerkId,
          guestClerkId: game.guestClerkId,
        };
      }

      const role = getPlayerRole(game, userAliases);
      if (!role) throw new Error("Game not found");
      if (game.currentTurn !== role) {
        return { ignored: true };
      }

      const board = ensureBoard(game.board);
      const row = getDropRow(board, column);
      if (row < 0) throw new Error("Column is full");

      const disc = role === "host" ? 1 : 2;
      board[row][column] = disc;

      const hostDiscsUsed =
        Number(game.hostDiscsUsed || 0) + (role === "host" ? 1 : 0);
      const guestDiscsUsed =
        Number(game.guestDiscsUsed || 0) + (role === "guest" ? 1 : 0);
      const connected = checkWinner(board, row, column, disc);
      const fullBoard = isBoardFull(board);
      const nextTurn = role === "host" ? "guest" : "host";

      await tx
        .update(fourInARowGames)
        .set({
          board,
          hostDiscsUsed,
          guestDiscsUsed,
          currentTurn: nextTurn,
          moveDeadlineAt: nextMoveDeadline(getGameMoveSeconds(game)),
        })
        .where(eq(fourInARowGames.id, game.id));

      return {
        connected,
        fullBoard,
        role,
        hostClerkId: game.hostClerkId,
        guestClerkId: game.guestClerkId,
      };
    });

    if (result?.timeout) {
      const winnerClerkId =
        result.hostClerkId && result.guestClerkId
          ? result.hostClerkId === userId
            ? result.guestClerkId
            : result.hostClerkId
          : null;
      if (winnerClerkId)
        await settleFourInARowGame(gameId, winnerClerkId, "timeout");
      return NextResponse.json({
        success: true,
        ignored: true,
        reason: "timeout_resolved",
      });
    }

    if (result?.ignored) {
      return NextResponse.json({
        success: true,
        ignored: true,
        reason: "stale_turn",
      });
    }

    if (result.connected) {
      const winnerClerkId =
        result.role === "host" ? result.hostClerkId : result.guestClerkId;
      await settleFourInARowGame(gameId, winnerClerkId, "win");
    } else if (result.fullBoard) {
      await settleFourInARowGame(gameId, null, "draw");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to play move" },
      { status: 400 },
    );
  }
}
