import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { gameId } = await req.json();
  const parsedGameId = Number(gameId);

  if (!Number.isFinite(parsedGameId) || parsedGameId <= 0) {
    return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(chessGames)
        .where(
          and(
            eq(chessGames.id, parsedGameId),
            eq(chessGames.playerWhiteId, userId),
            eq(chessGames.status, "waiting"),
            eq(chessGames.isAiGame, false)
          )
        )
        .for("update");

      if (!game) {
        throw new Error("Waiting game not found or cannot be canceled");
      }

      await tx
        .update(chessGames)
        .set({ status: "expired" })
        .where(eq(chessGames.id, parsedGameId));

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${game.betAmount}` })
        .where(eq(users.clerkId, userId));

      return { gameId: parsedGameId };
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message || "Failed to cancel game" }, { status: 400 });
  }
}
