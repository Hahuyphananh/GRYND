import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

function safeParse(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { gameId } = await req.json();
    if (!gameId) {
      return NextResponse.json({ error: "Missing gameId" }, { status: 400 });
    }

    const game = await db.query.unoGames.findFirst({
      where: eq(unoGames.id, gameId),
    });
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const requester = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!requester) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const isMultiplayer = Boolean(game.player2Id);

    if (game.result !== "pending" && game.winner && game.winner !== "pending") {
      return NextResponse.json({
        success: true,
        winner: game.winner,
        result: game.result,
        newBalance: parseFloat(requester.balance),
        message: "Winner already determined.",
      });
    }

    if (isMultiplayer) {
      const role =
        game.userId === requester.id
          ? "player1"
          : game.player2Id === requester.id
            ? "player2"
            : null;
      if (!role) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      const player1Cards = safeParse(game.player1Hand, []);
      const player2Cards = safeParse(game.player2Hand, []);

      let winner = null;
      if (player1Cards.length === 0) winner = "player1";
      else if (player2Cards.length === 0) winner = "player2";

      if (!winner) {
        return NextResponse.json({
          success: true,
          winner: null,
          result: "pending",
          message: "Game still in progress.",
        });
      }

      const winnerUserId = winner === "player1" ? game.userId : game.player2Id;
      const winnerUser = await db.query.users.findFirst({
        where: eq(users.id, winnerUserId),
      });

      if (!winnerUser) {
        return NextResponse.json(
          { error: "Winner not found" },
          { status: 404 },
        );
      }

      const payout = (parseFloat(game.pot || "0") * 0.95).toFixed(2);

      const didFinalize = await db.transaction(async (tx) => {
        const finalized = await tx
          .update(unoGames)
          .set({
            winner,
            result: "finished",
            status: "finished",
            payout,
          })
          .where(
            and(
              eq(unoGames.id, gameId),
              eq(unoGames.result, "pending"),
              eq(unoGames.winner, "pending"),
            ),
          )
          .returning({ id: unoGames.id });

        if (finalized.length === 0) {
          return false;
        }

        await tx
          .update(users)
          .set({
            balance: (
              parseFloat(winnerUser.balance) + parseFloat(payout)
            ).toFixed(2),
          })
          .where(eq(users.id, winnerUserId));

        return true;
      });

      if (!didFinalize) {
        const refreshedGame = await db.query.unoGames.findFirst({
          where: eq(unoGames.id, gameId),
        });
        const requesterRole = role;
        const alreadyWinner = refreshedGame?.winner || winner;
        const didRequesterWin = alreadyWinner === requesterRole;

        return NextResponse.json({
          success: true,
          winner: alreadyWinner,
          result: didRequesterWin ? "win" : "lose",
          newBalance: parseFloat(requester.balance),
          message: "Winner already determined.",
        });
      }

      await applyLeaderboardCounters({
        clerkId: winnerUser.clerkId,
        game: "uno",
        betAmount: Number(game.betAmount || 0),
        payout: Number(payout),
        isPvpWin: true,
      });

      const didRequesterWin = winner === role;
      const updatedRequester = didRequesterWin
        ? parseFloat(requester.balance) + parseFloat(payout)
        : parseFloat(requester.balance);

      return NextResponse.json({
        success: true,
        winner,
        result: didRequesterWin ? "win" : "lose",
        newBalance: updatedRequester,
        message: didRequesterWin
    ? `You won! Payout after tax: ${payout}`
    : "Opponent won. You lost your bet.",
      });
    }

    // AI mode is free play — `initialize-vs-ai` already stored `pot = 0`,
    // so `parseFloat(game.pot) * 0.95` is also 0 and `newBalance` does not
    // move on a player win. We deliberately do NOT credit any tokens here:
    // a human-vs-AI win must not pay out, otherwise the AI free-play path
    // becomes a free-token credit tap.
    const playerCards = safeParse(game.playerHand, []);
    const aiCards = safeParse(game.aiHand, []);

    let winner = null;
    let result = "pending";

    if (playerCards.length === 0) {
      winner = "player";
      result = "win";
    } else if (aiCards.length === 0) {
      winner = "ai";
      result = "lose";
    } else {
      return NextResponse.json({
        success: true,
        winner: null,
        result: "pending",
        message: "Game still in progress.",
      });
    }

    const finalizedAiGame = await db
      .update(unoGames)
      .set({
        winner,
        result,
        status: "finished",
        // Payout is always 0 in AI mode — even if a legacy row somehow has
        // `pot > 0`, this free-play path never credits it.
        payout: "0.00",
      })
      .where(
        and(
          eq(unoGames.id, gameId),
          eq(unoGames.result, "pending"),
          eq(unoGames.winner, "pending"),
        ),
      )
      .returning({ id: unoGames.id });

    if (finalizedAiGame.length === 0) {
      return NextResponse.json({
        success: true,
        winner: game.winner,
        result: game.result,
        newBalance: parseFloat(requester.balance),
        message: "Winner already determined.",
      });
    }

    // No `users.balance` update and no payout credit for AI games.
    // (Stats/wager values are still tracked for visibility.)
    //
    // Note: we deliberately no longer call `applyLeaderboardCounters` here.
    // The AI free-play path doesn't move real tokens, so leaderboard
    // counters would inflate `total_wagered`/`total_won` with phantom
    // stats. The classic multiplayer path below still counts wins/losses.

    return NextResponse.json({
      success: true,
      winner,
      result,
      newBalance: parseFloat(requester.balance),
      message:
        result === "win"
    ? "You won!"
    : "The AI won. Better luck next time!",
    });
  } catch (error) {
    console.error("Error determining UNO winner:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
