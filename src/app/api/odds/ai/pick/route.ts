// src/app/api/odds/ai/pick/route.ts
//
// ONE submission per round, for a free practice duel.
//
// Body: { gameId, exact } | { gameId, min, max }  (or the same object under
// `prediction`).
//
// The human's prediction is validated here, the bot answers with its own
// prediction for the SAME target (its accuracy is capped by tier — see
// `botPrediction`), and the round resolves immediately through the shared
// resolver. AI and PvP therefore score with the identical function; there is
// no "closest number" path left.
//
// Practice is free play: nothing is deducted, nothing is paid out, and no
// leaderboard/Elo/trophy row is written.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requirePracticePlayer } from "../../../../../lib/auth/guestSession";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import {
  isCurrentOddsState,
  parsePrediction,
  submitAIPrediction,
  viewForPlayer,
} from "../../../../../lib/odds";
import type { OddsGameState } from "../../../../../lib/odds";

export async function POST(req: Request) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }

    // Validate before the row lock — a malformed prediction must not hold the
    // match row while it is rejected.
    const parsed = parsePrediction(
      body?.prediction && typeof body.prediction === "object"
        ? body.prediction
        : { exact: body?.exact, min: body?.min, max: body?.max },
    );
    // `in` rather than `!parsed.ok`: `strict` is off in this project, so the
    // boolean discriminant is widened and truthiness does not narrow the union.
    if ("error" in parsed) {
      return NextResponse.json(
        { success: false, error: parsed.error },
        { status: 400 },
      );
    }
    const prediction = parsed.prediction;

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.player1Id !== userId) throw new Error("Not your game");
      if (!game.isAi) throw new Error("Use PvP endpoints for multiplayer games");
      if (game.status !== "playing") throw new Error("Game is not active");

      // A row from the retired rules cannot be played by this engine. Practice
      // moves no coins, so abandoning it is enough — the page then starts a
      // fresh duel.
      if (!isCurrentOddsState(game.gameState)) {
        await tx
          .update(oddsGames)
          .set({ status: "cancelled", endedAt: new Date() })
          .where(eq(oddsGames.id, gameId));
        throw Object.assign(
          new Error("That practice session used retired rules — start a new one"),
          { status: 409 },
        );
      }

      const state = game.gameState as OddsGameState;
      if (state.gameOver) throw new Error("Game is already over");

      const { round, updatedState } = submitAIPrediction(
        state,
        prediction,
        game.aiDifficulty,
      );

      if (updatedState.gameOver) {
        const player1Won = updatedState.winner === "player1";
        const drew = updatedState.winner === null;

        // STAKES ARE RETIRED: AI games are free play, so nothing is paid out.
        const recordedPayout = 0;

        await tx
          .update(oddsGames)
          .set({
            status: "finished",
            winner: updatedState.winner,
            result: player1Won ? "won" : drew ? "draw" : "lost",
            payout: recordedPayout,
            gameState: updatedState,
            endedAt: new Date(),
          })
          .where(eq(oddsGames.id, gameId));

        return {
          round,
          // Named `view`, not `updatedState`: what leaves this handler is
          // always a per-viewer projection, never the engine's raw state.
          view: viewForPlayer(updatedState, true),
          gameStatus: "finished" as const,
          player1Won,
          payout: recordedPayout,
        };
      }

      await tx
        .update(oddsGames)
        .set({ gameState: updatedState })
        .where(eq(oddsGames.id, gameId));

      return {
        round,
        view: viewForPlayer(updatedState, true),
        gameStatus: "playing" as const,
        player1Won: false,
        payout: 0,
      };
    });

    // AI results deliberately do NOT touch the leaderboards, user_stats or the
    // rating/trophy journals — practice moves no coins.

    return NextResponse.json({
      success: true,
      data: {
        round: result.round,
        prediction,
        updatedState: result.view,
        gameStatus: result.gameStatus,
        winner: result.view.winner,
        payout: result.payout,
      },
    });
  } catch (error: any) {
    const status =
      error?.status === 400 ? 400 : error?.status === 409 ? 409 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to process pick" },
      { status },
    );
  }
}
