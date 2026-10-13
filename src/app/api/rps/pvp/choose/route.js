import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { rpsPvpGames } from "../../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { payRpsPvpWinner } from "../../../../../lib/rps-pvp/serverStore";
import { eq } from "drizzle-orm";

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
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;

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

  // Set inside the settlement branch (0 for every other transition): what the
  // winner was actually paid, echoed back on the finishing response.
  let finishPayout = 0;

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
        const winnerId = nextWon1 >= ROUNDS_TO_WIN
          ? updatedGame.player1Id
          : updatedGame.player2Id;

        // The pot is paid from the escrow both seats took at join, in THIS
        // transaction, so the coins commit with the round that won them. The
        // row lock above plus the `status = 'matched'` guard make this the
        // single settlement of the match (and the ledger keys it per seat).
        const winnerPayout = await payRpsPvpWinner({
          tx,
          gameId: parsedGameId,
          winnerId,
          betAmount: updatedGame.betAmount,
        });
        // Report the real prize so the finishing client can show it without
        // re-deriving the pot.
        finishPayout = winnerPayout;

        await applyLeaderboardCounters({
          clerkId: winnerId,
          game: "rps-pvp",
          outcome: "win",
          isPvpWin: true,
        });

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
            endedAt: new Date(),
          })
          .where(eq(rpsPvpGames.id, parsedGameId))
          .returning();

        // The loser takes the loss on the same authoritative path as the win,
        // so win_rate / streaks stay in sync with the match (mirrors the
        // forfeit settlement in the store).
        const loserId =
          winnerId === finished.player1Id
            ? finished.player2Id
            : finished.player1Id;
        if (loserId) {
          applyLeaderboardCounters({
            clerkId: loserId,
            game: "rps-pvp",
            outcome: "loss",
          }).catch(() => {});
        }

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

    return NextResponse.json({ success: true, data: game, winnerPayout: finishPayout });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to submit choice" },
      { status: 400 },
    );
  }
}
