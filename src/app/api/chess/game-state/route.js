import { auth } from "@clerk/nextjs/server";
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves, users } from "../../../../db/schema";

async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (userRow?.id) aliases.add(String(userRow.id));
  return aliases;
}

async function resolveDisplayName(playerId) {
  if (!playerId) return null;

  const normalizedId = String(playerId);
  const [byClerk] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, normalizedId))
    .limit(1);

  if (byClerk?.name) return byClerk.name;

  const numericId = Number(normalizedId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  const [byNumericId] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, numericId))
    .limit(1);

  return byNumericId?.name ?? null;
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

    const userAliases = await getUserAliases(userId);

    const [game] = await db
      .select()
      .from(chessGames)
      .where(eq(chessGames.id, gameId))
      .limit(1);

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const canAccess = userAliases.has(String(game.playerWhiteId)) || userAliases.has(String(game.playerBlackId));
    if (!canAccess) {
      console.warn("chess game-state forbidden", {
        gameId,
        requester: userId,
        requesterAliases: Array.from(userAliases),
        playerWhiteId: game.playerWhiteId,
        playerBlackId: game.playerBlackId,
      });
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

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
    console.error("chess game-state error", {
      message: error?.message,
      stack: error?.stack,
      cause: error?.cause,
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
