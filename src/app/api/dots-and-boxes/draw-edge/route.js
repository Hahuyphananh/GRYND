import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames } from "../../../../db/schema";
import {
  createInitialState,
  drawEdge,
  hEdgeKey,
  vEdgeKey,
  isGameOver,
  remainingEdges,
} from "../../../../lib/dotsAndBoxesEngine";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );

    const body = await req.json();
    const gameId = Number(body?.gameId);
    const { type, row, col } = body;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid gameId" },
        { status: 400 },
      );
    }

    if (type !== "h" && type !== "v") {
      return NextResponse.json(
        { success: false, error: "Invalid edge type" },
        { status: 400 },
      );
    }

    if (typeof row !== "number" || typeof col !== "number") {
      return NextResponse.json(
        { success: false, error: "Invalid edge coordinates" },
        { status: 400 },
      );
    }

    const edgeKey = type === "h" ? hEdgeKey(row, col) : vEdgeKey(row, col);

    const result = await db.transaction(async (tx) => {
      // Fetch game with row lock
      const [game] = await tx
        .select()
        .from(dotsAndBoxesGames)
        .where(eq(dotsAndBoxesGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.status !== "in_progress") throw new Error("Game is not active");

      // Determine player role
      const role = game.hostClerkId === userId ? "host" : game.guestClerkId === userId ? "guest" : null;
      if (!role) throw new Error("You are not a player in this game");

      // Parse current game state
      let state;
      try {
        state =
          game.gameState && typeof game.gameState === "object" && Object.keys(game.gameState).length > 0
            ? (game.gameState as any)
            : createInitialState();
      } catch {
        state = createInitialState();
      }

      // Process the edge draw
      const drawResult = drawEdge(state, edgeKey, role);
      if (drawResult.error) throw new Error(drawResult.error);

      const newState = drawResult.state;
      const gameOver = isGameOver(newState);

      // Update database
      const [updated] = await tx
        .update(dotsAndBoxesGames)
        .set({
          gameState: newState,
          ...(gameOver
            ? {
                status: "finished",
                result: determineResult(newState),
                winnerClerkId: determineWinner(game, newState),
                endedAt: new Date(),
              }
            : {}),
        })
        .where(eq(dotsAndBoxesGames.id, gameId))
        .returning();

      return {
        gameState: newState,
        gameOver,
        role,
        remaining: remainingEdges(newState),
        status: gameOver ? "finished" : "in_progress",
        winnerClerkId: gameOver ? determineWinner(game, newState) : null,
      };
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error?.message || "Internal Server Error";
    const status = message === "Game not found" || message === "You are not a player in this game"
      ? 403
      : message === "Not your turn" || message === "Edge already drawn" || message === "Edge out of bounds" || message === "Invalid edge"
        ? 400
        : 500;
    return NextResponse.json(
      { success: false, error: message },
      { status },
    );
  }
}

function determineResult(state) {
  if (state.scores.host > state.scores.guest) return "host_win";
  if (state.scores.guest > state.scores.host) return "guest_win";
  return "draw";
}

function determineWinner(game, state) {
  if (state.scores.host > state.scores.guest) return game.hostClerkId;
  if (state.scores.guest > state.scores.host) return game.guestClerkId;
  return null; // draw
}
