import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import {
  resolvePvPRound,
  submitPick,
  submitPrediction,
  viewForPlayer,
} from "../../../../../lib/odds";
import type { PvPInteractiveOddsState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../../lib/rating";
import { applyTrophyResult } from "../../../../../lib/trophyStore";

/** Maximum time (ms) a player can stay inactive before being auto-forfeited */
const TIMEOUT_MS = 120_000;

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

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
    const playerNumber =
      body.playerNumber == null ? undefined : Number(body.playerNumber);
    const prediction =
      body.prediction == null ? undefined : Number(body.prediction);

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

      // ── Timeout check: auto-forfeit an opponent who finished their
      // part of the phase long ago and went away ──
      const now = Date.now();
      const roundAge = state.roundStartedAt ? now - state.roundStartedAt : 0;
      const oppDone =
        state.phase === "predict"
          ? isPlayer1
            ? state.player2Prediction !== null
            : state.player1Prediction !== null
          : isPlayer1
            ? state.player2Pick !== null
            : state.player1Pick !== null;

      if (roundAge > TIMEOUT_MS && oppDone) {
        const forfeiterId = isPlayer1 ? game.player2Id : game.player1Id;
        const winnerId = userId;
        // 5% house rake (winner gets 95% of the 2x pot = 1.9x wager).
        const payout = game.wager * 1.9;
        const winner: "player1" | "player2" = isPlayer1 ? "player1" : "player2";
        // Persist the game-over state so the opponent's polls/socket
        // refetches reflect the match ending (not just the submitter).
        const forfeitedState: PvPInteractiveOddsState = {
          ...state,
          gameOver: true,
          winner,
        };

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
            gameState: forfeitedState,
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

        // Per-game Elo — timeout forfeit: the opponent wins, resolved
        // server-side from the game row's seat columns.
        applyRatingResult({
          gameKey: "odds-pvp",
          matchId: String(gameId),
          winnerClerkId: winnerId,
          loserClerkId: forfeiterId,
        }).catch(() => {});
        // Per-game trophies — the same authoritative forfeit (+30 / −30).
        applyTrophyResult({
          gameKey: "odds-pvp",
          matchId: String(gameId),
          winnerClerkId: winnerId,
          loserClerkId: forfeiterId,
        }).catch(() => {});

        return {
          resolved: true,
          phase: forfeitedState.phase,
          gameState: viewForPlayer(forfeitedState, isPlayer1),
          round: null,
          payout,
          winner,
        };
      }

      // Prevent double-submitting — once locked in, it cannot change.
      const myDone =
        state.phase === "predict"
          ? isPlayer1
            ? state.player1Prediction !== null
            : state.player2Prediction !== null
          : isPlayer1
            ? state.player1Pick !== null
            : state.player2Pick !== null;
      if (myDone)
        throw Object.assign(
          new Error("You already submitted for this round"),
          { status: 400 },
        );

      const invalid = (v: number | undefined) =>
        v === undefined || !Number.isFinite(v) || !Number.isInteger(v);

      // ── Phase 1: lock in your own number ──
      if (state.phase === "pick") {
        if (prediction !== undefined)
          throw Object.assign(
            new Error("Lock in your number before predicting"),
            { status: 400 },
          );
        if (invalid(playerNumber))
          throw Object.assign(
            new Error("Number must be a whole number"),
            { status: 400 },
          );
        if (playerNumber! < 1 || playerNumber! > state.currentMax)
          throw Object.assign(
            new Error(`Number must be between 1 and ${state.currentMax}`),
            { status: 400 },
          );

        const { updatedState } = submitPick(
          state,
          isPlayer1 ? "player1" : "player2",
          playerNumber!,
        );

        // Save regardless — the opponent's number stays hidden (null)
        // until they submit theirs too.
        await tx
          .update(oddsGames)
          .set({ gameState: updatedState })
          .where(eq(oddsGames.id, gameId));

        return {
          resolved: false,
          phase: updatedState.phase,
          gameState: viewForPlayer(updatedState, isPlayer1),
          round: null,
          payout: 0,
          winner: null,
        };
      }

      // ── Phase 2: predict the opponent's number ──
      if (playerNumber !== undefined)
        throw Object.assign(
          new Error("Your number is locked in. Submit a prediction"),
          { status: 400 },
        );
      if (invalid(prediction))
        throw Object.assign(
          new Error("Prediction must be a whole number"),
          { status: 400 },
        );
      if (prediction! < 1 || prediction! > state.currentMax)
        throw Object.assign(
          new Error(`Prediction must be between 1 and ${state.currentMax}`),
          { status: 400 },
        );

      const { updatedState: afterPred, phaseComplete } = submitPrediction(
        state,
        isPlayer1 ? "player1" : "player2",
        prediction!,
      );

      if (!phaseComplete) {
        // Both predictions in → round advances only then; otherwise the
        // opponent's prediction stays hidden and we just save.
        await tx
          .update(oddsGames)
          .set({ gameState: afterPred })
          .where(eq(oddsGames.id, gameId));

        return {
          resolved: false,
          phase: afterPred.phase,
          gameState: viewForPlayer(afterPred, isPlayer1),
          round: null,
          payout: 0,
          winner: null,
        };
      }

      // Both predictions in — resolve the round (accuracy scoring)
      const pickResult = resolvePvPRound(afterPred);
      // 5% house rake (winner gets 95% of the 2x pot = 1.9x wager).
      const payout = game.wager * 1.9;

      if (pickResult.updatedState.gameOver) {
        const winner = pickResult.updatedState.winner; // null = draw
        const player1Won = winner === "player1";
        const winnerId = player1Won ? game.player1Id : game.player2Id;

        if (winner) {
          // Winner-take-all — the winner gets the full pot.
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${payout}` })
            .where(eq(users.clerkId, winnerId));

          await tx
            .update(oddsGames)
            .set({
              status: "finished",
              winner,
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

          // Per-game Elo — the round winner comes from the server-side Odds
          // engine (pickResult.updatedState.winner), never a client value.
          applyRatingResult({
            gameKey: "odds-pvp",
            matchId: String(gameId),
            winnerClerkId: winnerId!,
            loserClerkId: loserId!,
          }).catch(() => {});
          // Per-game trophies — the same authoritative round-win (+30 / −30).
          applyTrophyResult({
            gameKey: "odds-pvp",
            matchId: String(gameId),
            winnerClerkId: winnerId!,
            loserClerkId: loserId!,
          }).catch(() => {});
        } else {
          // Exact tie after all rounds — refund BOTH stakes, no winner.
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${game.wager}` })
            .where(eq(users.clerkId, game.player1Id));
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${game.wager}` })
            .where(eq(users.clerkId, game.player2Id));

          await tx
            .update(oddsGames)
            .set({
              status: "finished",
              winner: null,
              result: "draw",
              payout: 0,
              gameState: pickResult.updatedState,
              endedAt: new Date(),
            })
            .where(eq(oddsGames.id, gameId));

          // Per-game Elo — an exact tie after every round is a DRAW: both
          // ratings move by K × (0.5 − expected), so neither side is punished
          // by the seating order.
          applyRatingResult({
            gameKey: "odds-pvp",
            matchId: String(gameId),
            winnerClerkId: String(game.player1Id),
            loserClerkId: String(game.player2Id),
            result: "draw",
          }).catch(() => {});
        }

        return {
          resolved: true,
          phase: pickResult.updatedState.phase,
          gameState: viewForPlayer(pickResult.updatedState, isPlayer1),
          round: pickResult.round,
          payout: winner ? payout : 0,
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
        phase: pickResult.updatedState.phase,
        gameState: viewForPlayer(pickResult.updatedState, isPlayer1),
        round: pickResult.round,
        payout: 0,
        winner: null,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        resolved: result.resolved,
        phase: result.phase,
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
