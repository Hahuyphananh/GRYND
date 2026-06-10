import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { processPvPOddsRound } from "../../../../../lib/odds";
import type { PvPInteractiveOddsState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";

/** Maximum time (ms) a player can stay inactive before being auto-forfeited */
const TIMEOUT_MS = 60_000;

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }


    const body = await req.json();
    const gameId = Number(body.gameId);
    const playerNumber = Number(body.playerNumber);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.status !== "playing")
        throw new Error("Game is not active");
      if (game.isAi) throw new Error("Use AI pick endpoint for AI games");

      const isPlayer1 = game.player1Id === userId;
      const isPlayer2 = game.player2Id === userId;
      if (!isPlayer1 && !isPlayer2)
        throw new Error("You are not part of this game");

      const state = game.gameState as PvPInteractiveOddsState;
      if (!state || state.gameOver) throw new Error("Game is already over");

      // Validate
      if (
        !Number.isFinite(playerNumber) ||
        !Number.isInteger(playerNumber)
      ) {
        throw Object.assign(
          new Error("Number must be a whole number"),
          { status: 400 },
        );
      }
      if (playerNumber < 1 || playerNumber > state.currentMax) {
        throw Object.assign(
          new Error(`Number must be between 1 and ${state.currentMax}`),
          { status: 400 },
        );
      }

      // ── Timeout check: auto-forfeit inactive opponent ──
      const now = Date.now();
      const roundAge = state.roundStartedAt ? now - state.roundStartedAt : 0;
      const oppHasPicked = isPlayer1 ? state.player2Pick !== null : state.player1Pick !== null;

      // Opponent picked long ago and I'm only picking now → auto-forfeit them
      if (roundAge > TIMEOUT_MS && oppHasPicked) {
        const forfeiterId = isPlayer1 ? game.player2Id : game.player1Id;
        const winnerId = userId;
        const payout = game.wager * 2;
        const winner: "player1" | "player2" = isPlayer1 ? "player1" : "player2";

        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${payout}` })
          .where(eq(users.clerkId, winnerId!));

        await tx
          .update(oddsGames)
          .set({
            status: "finished",
            winner,
            result: winner === "player1" ? "player1_won" : "player2_won",
            payout,
            endedAt: new Date(),
          })
          .where(eq(oddsGames.id, gameId));

        applyLeaderboardCounters({
          clerkId: winnerId,
          game: "odds",
          betAmount: game.wager,
          payout,
          isPvpWin: true,
        }).catch(() => {});
        applyLeaderboardCounters({
          clerkId: forfeiterId!,
          game: "odds",
          betAmount: game.wager,
          payout: 0,
          isPvpWin: false,
        }).catch(() => {});

        const forfeitedState: PvPInteractiveOddsState = {
          ...state,
          gameOver: true,
          winner,
        };

        return {
          resolved: true,
          gameState: forfeitedState,
          round: null,
          payout,
          winner,
        };
      }

      // Prevent double-picking
      if (isPlayer1 && state.player1Pick !== null)
        throw Object.assign(
          new Error("You already picked for this round"),
          { status: 400 },
        );
      if (isPlayer2 && state.player2Pick !== null)
        throw Object.assign(
          new Error("You already picked for this round"),
          { status: 400 },
        );

      // Store the pick
      const updatedState: PvPInteractiveOddsState = {
        ...state,
        player1Pick: isPlayer1 ? playerNumber : state.player1Pick,
        player2Pick: isPlayer2 ? playerNumber : state.player2Pick,
      };

      // Check if both players have picked
      if (
        updatedState.player1Pick === null ||
        updatedState.player2Pick === null
      ) {
        // Waiting for opponent — just save and return
        await tx
          .update(oddsGames)
          .set({ gameState: updatedState })
          .where(eq(oddsGames.id, gameId));

        return {
          resolved: false,
          gameState: updatedState,
          round: null,
          payout: 0,
          winner: null,
        };
      }

      // Both picks in — resolve the round
      const pickResult = processPvPOddsRound(updatedState);
      const payout = game.wager * 2;

      if (pickResult.updatedState.gameOver) {
        const winner = pickResult.updatedState.winner!;
        const player1Won = winner === "player1";
        const winnerId = player1Won ? game.player1Id : game.player2Id;

        // Pay winner
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${payout}` })
          .where(eq(users.clerkId, winnerId));

        await tx
          .update(oddsGames)
          .set({
            status: "finished",
            winner: winner,
            result: player1Won ? "player1_won" : "player2_won",
            payout,
            gameState: pickResult.updatedState,
            endedAt: new Date(),
          })
          .where(eq(oddsGames.id, gameId));

        // Apply leaderboard counters (fire-and-forget)
        const loserId = player1Won ? game.player2Id : game.player1Id;
        applyLeaderboardCounters({
          clerkId: winnerId!,
          game: "odds",
          betAmount: game.wager,
          payout,
          isPvpWin: true,
        }).catch(() => {});
        applyLeaderboardCounters({
          clerkId: loserId!,
          game: "odds",
          betAmount: game.wager,
          payout: 0,
          isPvpWin: false,
        }).catch(() => {});

        return {
          resolved: true,
          gameState: pickResult.updatedState,
          round: pickResult.round,
          payout,
          winner,
        };
      }

      // Round resolved but game continues
      await tx
        .update(oddsGames)
        .set({ gameState: pickResult.updatedState })
        .where(eq(oddsGames.id, gameId));

      return {
        resolved: true,
        gameState: pickResult.updatedState,
        round: pickResult.round,
        payout: 0,
        winner: null,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        resolved: result.resolved,
        round: result.round,
        gameState: result.gameState,
        winner: result.winner,
        payout: result.payout,
      },
    });
  } catch (error: any) {
    const status = error?.status === 400 ? 400 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to process pick" },
      { status },
    );
  }
}
