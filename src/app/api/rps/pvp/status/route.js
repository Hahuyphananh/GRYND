import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { eq } from "drizzle-orm";

const HOUSE_EDGE_PERCENT = 10;

export async function GET(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(req.url);
  const gameId = Number(searchParams.get("gameId"));

  if (!Number.isFinite(gameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  const game = await db.query.rpsPvpGames.findFirst({
    where: eq(rpsPvpGames.id, gameId),
  });

  if (!game) {
    return NextResponse.json(
      { success: false, error: "Game not found" },
      { status: 404 },
    );
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  const myChoice =
    game.player1Id === userId ? game.player1Choice : game.player2Choice;
  const opponentChoice =
    game.player1Id === userId ? game.player2Choice : game.player1Choice;
  const [player1, player2] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.clerkId, game.player1Id),
      columns: { name: true },
    }),
    game.player2Id
      ? db.query.users.findFirst({
          where: eq(users.clerkId, game.player2Id),
          columns: { name: true },
        })
      : Promise.resolve(null),
  ]);

  let newBalance;
  if (game.status === "finished" || game.status === "cancelled") {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    newBalance = user ? Number(user.balance) : undefined;
  }

  const betAmount = Number(game.betAmount);
  const pot = Number((betAmount * 2).toFixed(2));
  const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
  const winnerPayout = Number((pot - houseFee).toFixed(2));
  const winnerProfit = Number((winnerPayout - betAmount).toFixed(2));
  const myName = game.player1Id === userId ? player1?.name : player2?.name;
  const opponentName =
    game.player1Id === userId ? player2?.name : player1?.name;

  return NextResponse.json({
    success: true,
    data: {
      gameId: game.id,
      status: game.status,
      player1Id: game.player1Id,
      player2Id: game.player2Id,
      player1Name: player1?.name ?? "Player 1",
      player2Name: player2?.name ?? "Player 2",
      myName: myName ?? "You",
      opponentName: opponentName ?? "Opponent",
      houseEdgePercent: HOUSE_EDGE_PERCENT,
      betAmount,
      pot,
      houseFee,
      winnerPayout,
      winnerProfit,
      myChoice,
      opponentChoice,
      outcome: game.outcome,
      winner:
        game.status === "finished"
          ? game.winnerId === userId
            ? "you"
            : game.winnerId
              ? "opponent"
              : "tie"
          : null,
      result: game.result,
      newBalance,
    },
  });
}
