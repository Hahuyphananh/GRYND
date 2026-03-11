import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames } from "../../../../../db/schema";
import { and, eq } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { gameId, choice } = await req.json();

  if (!Number.isFinite(Number(gameId))) {
    return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
  }

  if (!["heads", "tails"].includes(choice)) {
    return NextResponse.json({ error: "Invalid choice" }, { status: 400 });
  }

  try {
    const [updated] = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(coinFlipGames)
        .where(and(eq(coinFlipGames.id, Number(gameId)), eq(coinFlipGames.status, "matched")))
        .for("update");

      if (!game) throw new Error("Game is not waiting for choices");
      if (game.player1Id !== userId && game.player2Id !== userId) {
        throw new Error("Forbidden");
      }

      if (game.choiceDeadline && new Date(game.choiceDeadline).getTime() < Date.now()) {
        throw new Error("Choice timer expired");
      }

      const isPlayer1 = game.player1Id === userId;
      const ownChoice = isPlayer1 ? game.player1Choice : game.player2Choice;
      const otherChoice = isPlayer1 ? game.player2Choice : game.player1Choice;

      if (ownChoice) return [game];
      if (otherChoice === choice) {
        throw new Error("This side is already taken");
      }

      const [saved] = await tx
        .update(coinFlipGames)
        .set(isPlayer1 ? { player1Choice: choice } : { player2Choice: choice })
        .where(eq(coinFlipGames.id, Number(gameId)))
        .returning();

      return [saved];
    });

    return NextResponse.json({
      success: true,
      data: {
        player1Choice: updated.player1Choice,
        player2Choice: updated.player2Choice,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
