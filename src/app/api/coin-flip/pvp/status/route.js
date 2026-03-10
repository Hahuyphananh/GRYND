import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames } from "../../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const gameId = Number(searchParams.get("gameId"));

  if (!Number.isFinite(gameId)) {
    return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
  }

  const game = await db.query.coinFlipGames.findFirst({
    where: eq(coinFlipGames.id, gameId),
  });

  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (game.status !== "finished") {
    return NextResponse.json({
      success: true,
      data: {
        status: game.status,
      },
    });
  }

  return NextResponse.json({
    success: true,
    data: {
      status: game.status,
      outcome: game.outcome,
      winner: game.winnerId === userId ? "you" : "opponent",
    },
  });
}
