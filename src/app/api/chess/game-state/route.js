import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves, users } from "../../../../db/schema";

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
          or(eq(chessGames.playerWhiteId, userId), eq(chessGames.playerBlackId, userId))
        )
      )
      .limit(1);

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    let moves = [];
    try {
      moves = await db
        .select()
        .from(chessMoves)
        .where(eq(chessMoves.gameId, gameId))
        .orderBy(asc(chessMoves.id));
    } catch (movesError) {
      console.error("chess game-state moves query failed", movesError);
      moves = [];
    }

    const lastMove = moves[moves.length - 1] || null;
    let whiteUser = null;
    let blackUser = null;
    try {
      [whiteUser] = game.playerWhiteId
        ? await db.select({ name: users.name }).from(users).where(eq(users.clerkId, game.playerWhiteId)).limit(1)
        : [null];
      [blackUser] = game.playerBlackId
        ? await db.select({ name: users.name }).from(users).where(eq(users.clerkId, game.playerBlackId)).limit(1)
        : [null];
    } catch (userLookupError) {
      console.error("chess game-state user lookup failed", userLookupError);
    }

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        status: game.status,
        betAmount: game.betAmount,
        whitePlayerId: game.playerWhiteId,
        blackPlayerId: game.playerBlackId,
        whitePlayerName: whiteUser?.name || "White",
        blackPlayerName: blackUser?.name || (game.isAiGame ? "Chess AI" : "Waiting..."),
        winnerId: game.winnerId,
        result: game.result,
        fen: lastMove?.fenAfter ?? "start",
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
