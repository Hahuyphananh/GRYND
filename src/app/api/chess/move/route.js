import { Chess } from "chess.js";
import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves, users } from "../../../../db/schema";

const HOUSE_EDGE_PERCENT = 10;

async function ensureChessMovesTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chess_moves (
      id serial PRIMARY KEY,
      game_id integer NOT NULL REFERENCES chess_games(id) ON DELETE CASCADE,
      played_by varchar(255) NOT NULL,
      move_uci varchar(10) NOT NULL,
      move_san varchar(20) NOT NULL,
      fen_after text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `);
}

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

    await ensureChessMovesTable();

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
      const isDraw =
        chess.isDraw() || chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition();
      const winnerId = isDraw ? null : userId;

      await db.transaction(async (tx) => {
        const [lockedGame] = await tx.select().from(chessGames).where(eq(chessGames.id, normalizedGameId)).for("update");
        if (!lockedGame || lockedGame.status === "finished") return;

        if (isDraw) {
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${lockedGame.betAmount}` })
            .where(eq(users.clerkId, lockedGame.playerWhiteId));

          if (lockedGame.playerBlackId) {
            await tx
              .update(users)
              .set({ balance: sql`${users.balance} + ${lockedGame.betAmount}` })
              .where(eq(users.clerkId, lockedGame.playerBlackId));
          }
        } else {
          const pot = Number(lockedGame.betAmount) * 2;
          const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
          const winnerPayout = Number((pot - houseFee).toFixed(2));

          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${winnerPayout}` })
            .where(eq(users.clerkId, winnerId));
        }

        await tx
          .update(chessGames)
          .set({
            status: "finished",
            winnerId,
            result: isDraw ? "draw" : "win",
          })
          .where(eq(chessGames.id, normalizedGameId));
      });
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
