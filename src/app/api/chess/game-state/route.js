import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves, users } from "../../../../db/schema";

async function resolveDisplayName(playerId) {
  if (!playerId) return null;

  const normalizedId = String(playerId);

  try {
    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(
        or(
          eq(users.clerkId, normalizedId),
          sql`${users.id}::text = ${normalizedId}`
        )
      )
      .limit(1);

    return user?.name ?? null;
  } catch (error) {
    // Prevent optional profile lookup failures from breaking game-state API.
    console.warn("chess game-state: failed to resolve display name", {
      playerId: normalizedId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function GET(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const gameId = Number(searchParams.get("gameId"));

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(chessGames)
      .where(
        and(
          eq(chessGames.id, gameId),
          or(
            sql`${chessGames.playerWhiteId}::text = ${userId}`,
            sql`${chessGames.playerBlackId}::text = ${userId}`
          )
        )
      )
      .limit(1);

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const moves = await db
      .select()
      .from(chessMoves)
      .where(eq(chessMoves.gameId, gameId))
      .orderBy(asc(chessMoves.id));

    const lastMove = moves[moves.length - 1] || null;
    const [whiteName, blackName] = await Promise.all([
      resolveDisplayName(game.playerWhiteId),
      resolveDisplayName(game.playerBlackId),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        status: game.status,
        betAmount: game.betAmount,
        whitePlayerId: game.playerWhiteId,
        blackPlayerId: game.playerBlackId,
        whitePlayerName: whiteName || "White",
        blackPlayerName: blackName || (game.isAiGame ? "Chess AI" : "Waiting..."),
        winnerId: game.winnerId,
        result: game.result,
        fen: lastMove?.fenAfter ?? null,
        moves: moves.map((m) => ({
          id: m.id,
          playedBy: m.playedBy,
          moveUci: m.moveUci,
          moveSan: m.moveSan,
          fenAfter: m.fenAfter,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("chess game-state error", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
