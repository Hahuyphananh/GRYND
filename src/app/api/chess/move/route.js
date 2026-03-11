import { Chess } from "chess.js";
import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves } from "../../../../db/schema";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { gameId, from, to, promotion = "q" } = await req.json();
    const normalizedGameId = Number(gameId);

    if (!Number.isFinite(normalizedGameId) || !from || !to) {
      return NextResponse.json({ error: "Invalid move payload" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(chessGames)
      .where(
        and(
          eq(chessGames.id, normalizedGameId),
          or(eq(chessGames.playerWhiteId, userId), eq(chessGames.playerBlackId, userId))
        )
      )
      .limit(1);

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });
    if (game.status !== "in_progress") {
      return NextResponse.json({ error: "Game is not active" }, { status: 400 });
    }

    const moves = await db
      .select()
      .from(chessMoves)
      .where(eq(chessMoves.gameId, normalizedGameId))
      .orderBy(asc(chessMoves.id));

    const lastFen = moves.length > 0 ? moves[moves.length - 1].fenAfter : undefined;
    const chess = new Chess(lastFen);

    const isWhite = game.playerWhiteId === userId;
    const expectedTurn = isWhite ? "w" : "b";
    if (chess.turn() !== expectedTurn) {
      return NextResponse.json({ error: "Not your turn" }, { status: 409 });
    }

    const playedMove = chess.move({ from, to, promotion });
    if (!playedMove) {
      return NextResponse.json({ error: "Illegal move" }, { status: 400 });
    }

    await db.insert(chessMoves).values({
      gameId: normalizedGameId,
      playedBy: userId,
      moveUci: `${from}${to}${promotion || ""}`,
      moveSan: playedMove.san,
      fenAfter: chess.fen(),
    });

    if (chess.isGameOver()) {
      const isDraw = chess.isDraw() || chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition();
      const winnerId = isDraw ? null : userId;

      await db
        .update(chessGames)
        .set({
          status: "finished",
          winnerId,
          result: isDraw ? "draw" : "win",
        })
        .where(eq(chessGames.id, normalizedGameId));
    }

    return NextResponse.json({
      success: true,
      data: {
        fen: chess.fen(),
        move: playedMove.san,
        isGameOver: chess.isGameOver(),
      },
    });
  } catch (error) {
    console.error("chess move error", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
