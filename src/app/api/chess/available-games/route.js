import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, isNull, desc } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db
      .select({
        id: chessGames.id,
        betAmount: chessGames.betAmount,
        timerMode: chessGames.timerMode,
        createdAt: chessGames.createdAt,
        playerWhiteId: chessGames.playerWhiteId,
        hostName: users.name,
      })
      .from(chessGames)
      .leftJoin(users, eq(users.clerkId, chessGames.playerWhiteId))
      .where(
        and(
          eq(chessGames.status, "waiting"),
          isNull(chessGames.playerBlackId),
          eq(chessGames.isAiGame, false),
        ),
      )
      .orderBy(desc(chessGames.createdAt))
      .limit(30);

    return NextResponse.json({ success: true, data: { games } });
  } catch (error) {
    console.error("chess available-games error", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
