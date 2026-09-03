import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { applyPrestigeResult } from "../../../../../lib/prestige";
import { eq, sql } from "drizzle-orm";

// Harmonized to the shared 5% PvP rake (must match PVP_RAKE_PCT in
// src/lib/games/economy.ts). Winner keeps 95% of the pot.
const HOUSE_EDGE_PERCENT = 5;
// Best-of-7 — first player to ROUNDS_TO_WIN decided rounds takes the match.
const ROUNDS_TO_WIN = 4;

const VALID_CHOICES = ["rock", "paper", "scissors"];

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

  if (!VALID_CHOICES.includes(choice)) {
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

      // Round not decided yet — the other player still has to choose.
      if (!(updatedGame.player1Choice && updatedGame.player2Choice)) {
        return updatedGame;
      }

      // ── Round resolved: evaluate, tally, and either advance or finish ──
      const roundOutcome = evaluateChoices(
        updatedGame.player1Choice,
        updatedGame.player2Choice,
      );

      const roundsWon1 = Number(updatedGame.roundsWon1 || 0);
      const roundsWon2 = Number(updatedGame.roundsWon2 || 0);
      const currentRound = Number(updatedGame.currentRound || 1);
      const history = Array.isArray(updatedGame.roundHistory)
        ? updatedGame.roundHistory
        : [];

      // Ties are replayed — they never consume a round or a dot.
      if (roundOutcome === "tie") {
        const [tiedGame] = await tx
          .update(rpsPvpGames)
          .set({
            player1Choice: null,
            player2Choice: null,
            roundHistory: [
              ...history,
              {
                round: currentRound,
                player1Choice: updatedGame.player1Choice,
                player2Choice: updatedGame.player2Choice,
                winner: "tie",
              },
            ],
          })
          .where(eq(rpsPvpGames.id, parsedGameId))
          .returning();
        return tiedGame;
      }

      const nextWon1 = roundOutcome === "player1" ? roundsWon1 + 1 : roundsWon1;
      const nextWon2 = roundOutcome === "player2" ? roundsWon2 + 1 : roundsWon2;
      const matchOver = nextWon1 >= ROUNDS_TO_WIN || nextWon2 >= ROUNDS_TO_WIN;

      const nextHistory = [
        ...history,
        {
          round: currentRound,
          player1Choice: updatedGame.player1Choice,
          player2Choice: updatedGame.player2Choice,
          winner: roundOutcome,
        },
      ];

      if (matchOver) {
        const pot = Number(updatedGame.betAmount) * 2;
        const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
        const winnerPayout = Number((pot - houseFee).toFixed(2));

        const winnerId = nextWon1 >= ROUNDS_TO_WIN
          ? updatedGame.player1Id
          : updatedGame.player2Id;

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

        // Permanent Prestige — competitive best-of-7 finish: the match
        // winner earns +1 and the opponent records a -1 loss.
        const prestigeLoserId =
          updatedGame.player1Id === winnerId
            ? updatedGame.player2Id
            : updatedGame.player1Id;
        await applyPrestigeResult({
          tx,
          clerkId: winnerId,
          outcome: "win",
          source: "rps-pvp",
          sourceId: String(parsedGameId),
        }).catch(() => {});
        if (prestigeLoserId) {
          await applyPrestigeResult({
            tx,
            clerkId: prestigeLoserId,
            outcome: "loss",
            source: "rps-pvp",
            sourceId: String(parsedGameId),
          }).catch(() => {});
        }

        const [finished] = await tx
          .update(rpsPvpGames)
          .set({
            player1Choice: null,
            player2Choice: null,
            roundsWon1: nextWon1,
            roundsWon2: nextWon2,
            roundHistory: nextHistory,
            outcome: roundOutcome,
            winnerId,
            result: roundOutcome,
            status: "finished",
          })
          .where(eq(rpsPvpGames.id, parsedGameId))
          .returning();

        return finished;
      }

      // Round decided, match continues — clear choices for the next round.
      const [advanced] = await tx
        .update(rpsPvpGames)
        .set({
          player1Choice: null,
          player2Choice: null,
          roundsWon1: nextWon1,
          roundsWon2: nextWon2,
          currentRound: currentRound + 1,
          roundHistory: nextHistory,
        })
        .where(eq(rpsPvpGames.id, parsedGameId))
        .returning();

      return advanced;
    });

    return NextResponse.json({ success: true, data: game });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to submit choice" },
      { status: 400 },
    );
  }
}
