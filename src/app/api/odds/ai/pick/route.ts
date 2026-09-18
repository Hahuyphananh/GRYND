import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import {
  submitAIPick,
  submitAIPrediction,
  viewForPlayer,
} from "../../../../../lib/odds";
import type { InteractiveOddsState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body.gameId);
    const playerNumber =
      body.playerNumber == null ? undefined : Number(body.playerNumber);
    const prediction =
      body.prediction == null ? undefined : Number(body.prediction);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.player1Id !== userId) throw new Error("Not your game");
      if (game.status !== "playing") throw new Error("Game is not active");

      const state = game.gameState as InteractiveOddsState;
      if (!state || state.gameOver) throw new Error("Game is already over");

      const invalid = (v: number | undefined) =>
        v === undefined || !Number.isFinite(v) || !Number.isInteger(v);

      // ── Phase 1: lock in the player's number ──
      if (state.phase === "pick") {
        if (prediction !== undefined)
          throw Object.assign(
            new Error("Lock in your number before predicting"),
            { status: 400 },
          );
        if (invalid(playerNumber))
          throw Object.assign(new Error("Number must be a whole number"), { status: 400 });
        if (playerNumber! < 1 || playerNumber! > state.currentMax)
          throw Object.assign(
            new Error(`Number must be between 1 and ${state.currentMax}`),
            { status: 400 },
          );

        // The AI locks in its own hidden number immediately; only the
        // sanitized view (AI's number nulled) goes back to the client.
        const { updatedState } = submitAIPick(state, playerNumber!);
        await tx
          .update(oddsGames)
          .set({ gameState: updatedState })
          .where(eq(oddsGames.id, gameId));

        return {
          round: null,
          updatedState: viewForPlayer(updatedState, true),
          gameStatus: "playing" as const,
          player1Won: false,
          payout: 0,
        };
      }

      // ── Phase 2: player predicts the AI's number ──
      if (playerNumber !== undefined)
        throw Object.assign(
          new Error("Your number is locked in. Submit a prediction"),
          { status: 400 },
        );
      if (invalid(prediction))
        throw Object.assign(new Error("Prediction must be a whole number"), { status: 400 });
      if (prediction! < 1 || prediction! > state.currentMax)
        throw Object.assign(
          new Error(`Prediction must be between 1 and ${state.currentMax}`),
          { status: 400 },
        );

      const { round, updatedState: resolved } = submitAIPrediction(
        state,
        prediction!,
      );
      const payout = game.wager * 2;

      if (resolved.gameOver) {
        const player1Won = resolved.winner === "player1";
        const drew = resolved.winner === null;

        // AI games are free play — never credit payout on win, even if the
        // persisted `game.wager` is non-zero. This endpoint is only reached
        // for AI games (`game.isAi === true`), but the explicit guard keeps
        // the credit logic defensive in case the route is wired differently.
        if (player1Won && !game.isAi) {
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${payout}` })
            .where(eq(users.clerkId, userId));
        }

        // Record payout as 0 in AI mode so history reflects the free-play
        // outcome instead of a phantom double-the-wager credit.
        const recordedPayout = game.isAi ? 0 : player1Won ? payout : 0;

        await tx
          .update(oddsGames)
          .set({
            status: "finished",
            winner: resolved.winner,
            result: player1Won ? "won" : drew ? "draw" : "lost",
            payout: recordedPayout,
            gameState: resolved,
            endedAt: new Date(),
          })
          .where(eq(oddsGames.id, gameId));

        return {
          round,
          updatedState: viewForPlayer(resolved, true),
          gameStatus: "finished" as const,
          player1Won,
          payout: recordedPayout,
          wager: game.wager,
          isAi: game.isAi,
        };
      }

      // Game continues — just update the gameState
      await tx
        .update(oddsGames)
        .set({ gameState: resolved })
        .where(eq(oddsGames.id, gameId));

      return {
        round,
        updatedState: viewForPlayer(resolved, true),
        gameStatus: "playing" as const,
        player1Won: false,
        payout: 0,
      };
    });

    // Track leaderboard OUTSIDE the transaction to avoid deadlocks.
    // AI games are free play (wager never deducted) — skip the stats
    // pipeline so beating the AI no longer records a phantom loss
    // (payout 0) in user_stats / quests.
    if (result.gameStatus === "finished" && !(result as any).isAi) {
      await applyLeaderboardCounters({
        clerkId: userId,
        game: "odds",
        betAmount: (result as any).wager,
        payout: result.player1Won ? result.payout : 0,
      }).catch((err) => console.error("Leaderboard error:", err));
    }

    return NextResponse.json({
      success: true,
      data: {
        round: result.round,
        playerNumber,
        updatedState: result.updatedState,
        gameStatus: result.gameStatus,
        winner: result.updatedState.winner,
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
