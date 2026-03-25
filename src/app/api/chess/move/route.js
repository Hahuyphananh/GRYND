import { Chess } from "chess.js";
import { auth } from "@clerk/nextjs/server";
import { asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves, users } from "../../../../db/schema";

const HOUSE_EDGE_PERCENT = 10;

async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (userRow?.id) aliases.add(String(userRow.id));
  return aliases;
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

    const userAliases = await getUserAliases(userId);

    const [game] = await db
      .select()
      .from(chessGames)
      .where(eq(chessGames.id, normalizedGameId))
      .limit(1);

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const isWhitePlayer = userAliases.has(String(game.playerWhiteId));
    const isBlackPlayer = userAliases.has(String(game.playerBlackId));
    if (!isWhitePlayer && !isBlackPlayer) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

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

    const isWhite = isWhitePlayer;
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
    console.error("chess move error", {
      message: error?.message,
      stack: error?.stack,
      cause: error?.cause,
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
