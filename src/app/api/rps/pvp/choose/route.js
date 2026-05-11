import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { eq, sql } from "drizzle-orm";

const HOUSE_EDGE_PERCENT = 10;

function evaluateChoices(choice1, choice2) {
  if (choice1 === choice2) return "tie";
  if (
    (choice1 === "rock" && choice2 === "scissors") ||
    (choice1 === "paper" && choice2 === "rock") ||
    (choice1 === "scissors" && choice2 === "paper")
  ) {
    return "player1";
  }
  return "player2";
}

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { gameId, choice } = await req.json();
  const parsedGameId = Number(gameId);

  if (!Number.isFinite(parsedGameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  if (!["rock", "paper", "scissors"].includes(choice)) {
    return NextResponse.json(
      { success: false, error: "Invalid choice" },
      { status: 400 },
    );
  }

  try {
    const game = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(rpsPvpGames)
        .where(eq(rpsPvpGames.id, parsedGameId))
        .for("update");

      if (!locked) throw new Error("Game not found");
      if (locked.status !== "matched")
        throw new Error("Game is not ready for choices");
      if (locked.player1Id !== userId && locked.player2Id !== userId)
        throw new Error("Forbidden");

      if (locked.player1Id === userId && locked.player1Choice)
        throw new Error("Choice already locked");
      if (locked.player2Id === userId && locked.player2Choice)
        throw new Error("Choice already locked");

      const updatePayload =
        locked.player1Id === userId
          ? { player1Choice: choice }
          : { player2Choice: choice };

      const [updatedGame] = await tx
        .update(rpsPvpGames)
        .set(updatePayload)
        .where(eq(rpsPvpGames.id, parsedGameId))
        .returning();

      if (!(updatedGame.player1Choice && updatedGame.player2Choice)) {
        return updatedGame;
      }

      const outcome = evaluateChoices(
        updatedGame.player1Choice,
        updatedGame.player2Choice,
      );
      const pot = Number(updatedGame.betAmount) * 2;
      const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
      const winnerPayout = Number((pot - houseFee).toFixed(2));

      let winnerId = null;
      if (outcome === "player1") winnerId = updatedGame.player1Id;
      if (outcome === "player2") winnerId = updatedGame.player2Id;

      if (winnerId) {
        await applyLeaderboardCounters({
          clerkId: winnerId,
          game: "rps-pvp",
          betAmount: Number(updatedGame.betAmount),
          payout: winnerPayout,
          isPvpWin: true,
        });

        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${winnerPayout}` })
          .where(eq(users.clerkId, winnerId));
      } else {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${updatedGame.betAmount}` })
          .where(eq(users.clerkId, updatedGame.player1Id));

        if (updatedGame.player2Id) {
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${updatedGame.betAmount}` })
            .where(eq(users.clerkId, updatedGame.player2Id));
        }
      }

      const [finished] = await tx
        .update(rpsPvpGames)
        .set({
          outcome,
          winnerId,
          result: outcome,
          status: "finished",
        })
        .where(eq(rpsPvpGames.id, parsedGameId))
        .returning();

      return finished;
    });

    return NextResponse.json({ success: true, data: game });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to submit choice" },
      { status: 400 },
    );
  }
}
