import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";

const HOUSE_EDGE_PERCENT = 10;

export async function GET(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;

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
  // Full seat identity (real username + official icon + equipped name
  // color) for both seats — one query via the shared resolver. A seat
  // with no user row (never happens in RPS PvP, but defensively) falls
  // back to null and the client keeps its label.
  const identity = await getSeatIdentity(game.player1Id, game.player2Id);
  const player1 = identity.player1;
  const player2 = identity.player2;

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
  const myIconKey = game.player1Id === userId ? player1?.iconKey : player2?.iconKey;
  const myNameColor = game.player1Id === userId ? player1?.nameColor : player2?.nameColor;
  const opponentIconKey =
    game.player1Id === userId ? player2?.iconKey : player1?.iconKey;
  const opponentNameColor =
    game.player1Id === userId ? player2?.nameColor : player1?.nameColor;

  return NextResponse.json({
    success: true,
    data: {
      gameId: game.id,
      status: game.status,
      player1Id: game.player1Id,
      player2Id: game.player2Id,
      player1Name: player1?.name ?? "Player 1",
      player2Name: player2?.name ?? "Player 2",
      player1IconKey: player1?.iconKey ?? null,
      player2IconKey: player2?.iconKey ?? null,
      player1NameColor: player1?.nameColor ?? null,
      player2NameColor: player2?.nameColor ?? null,
      myName: myName ?? "You",
      opponentName: opponentName ?? "Opponent",
      myIconKey: myIconKey ?? null,
      myNameColor: myNameColor ?? null,
      opponentIconKey: opponentIconKey ?? null,
      opponentNameColor: opponentNameColor ?? null,
      houseEdgePercent: HOUSE_EDGE_PERCENT,
      betAmount,
      pot,
      houseFee,
      winnerPayout,
      winnerProfit,
      myChoice,
      opponentChoice,
      // ── Best-of-7 match state ──────────────────────────────────────
      roundsWon1: Number(game.roundsWon1 || 0),
      roundsWon2: Number(game.roundsWon2 || 0),
      currentRound: Number(game.currentRound || 1),
      roundHistory: Array.isArray(game.roundHistory) ? game.roundHistory : [],
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
