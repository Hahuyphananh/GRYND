import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const gameId = Number(searchParams.get("gameId"));

  if (!Number.isFinite(gameId)) {
    return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
  }

  const game = await db.query.rpsPvpGames.findFirst({
    where: eq(rpsPvpGames.id, gameId),
  });

  if (!game) {
    return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const myChoice = game.player1Id === userId ? game.player1Choice : game.player2Choice;
  const opponentChoice = game.player1Id === userId ? game.player2Choice : game.player1Choice;

  let newBalance;
  if (game.status === "finished" || game.status === "cancelled") {
    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    newBalance = user ? Number(user.balance) : undefined;
  }

  return NextResponse.json({
    success: true,
    data: {
      gameId: game.id,
      status: game.status,
      player1Id: game.player1Id,
      player2Id: game.player2Id,
      myChoice,
      opponentChoice,
      outcome: game.outcome,
      winner: game.status === "finished" ? (game.winnerId === userId ? "you" : game.winnerId ? "opponent" : "tie") : null,
      result: game.result,
      newBalance,
    },
  });
}
