import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";

async function resolveGameIfReady(game) {
  if (game.status !== "matched") return game;

  const now = Date.now();
  const deadline = game.choiceDeadline
    ? new Date(game.choiceDeadline).getTime()
    : null;
  const bothChosen = Boolean(game.player1Choice && game.player2Choice);

  if (!bothChosen && deadline && now >= deadline) {
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(coinFlipGames)
        .where(eq(coinFlipGames.id, game.id))
        .for("update");

      if (!locked || locked.status !== "matched") return locked || game;

      let player1Choice = locked.player1Choice;
      let player2Choice = locked.player2Choice;

      // Force opposite choice if one player didn't choose
      if (player1Choice && !player2Choice) {
        player2Choice = player1Choice === "heads" ? "tails" : "heads";
      }

      if (player2Choice && !player1Choice) {
        player1Choice = player2Choice === "heads" ? "tails" : "heads";
      }

      // Save forced choice
      const [updated] = await tx
        .update(coinFlipGames)
        .set({
          player1Choice,
          player2Choice,
        })
        .where(eq(coinFlipGames.id, game.id))
        .returning();

      return updated;
    });
  }

  if (!bothChosen) return game;

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(coinFlipGames)
      .where(eq(coinFlipGames.id, game.id))
      .for("update");

    if (!locked || locked.status !== "matched") return locked || game;
    if (!(locked.player1Choice && locked.player2Choice)) return locked;

    const outcome = crypto.randomInt(0, 2) === 0 ? "heads" : "tails";
    const winnerId =
      outcome === locked.player1Choice ? locked.player1Id : locked.player2Id;
    const payout = Number(locked.betAmount) * 2;

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, winnerId));

    const [finished] = await tx
      .update(coinFlipGames)
      .set({
        outcome,
        winnerId,
        result: winnerId === locked.player1Id ? "player1" : "player2",
        status: "finished",
      })
      .where(eq(coinFlipGames.id, game.id))
      .returning();

    return finished;
  });
}

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

  let game = await db.query.coinFlipGames.findFirst({
    where: eq(coinFlipGames.id, gameId),
  });

  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  game = await resolveGameIfReady(game);

  return NextResponse.json({
    success: true,
    data: {
      status: game.status,
      player1Id: game.player1Id,
      player2Id: game.player2Id,
      player1Choice: game.player1Choice,
      player2Choice: game.player2Choice,
      choiceDeadline: game.choiceDeadline,
      outcome: game.outcome,
      winner:
        game.status === "finished"
          ? game.winnerId === userId
            ? "you"
            : "opponent"
          : null,
      result: game.result,
    },
  });
}
