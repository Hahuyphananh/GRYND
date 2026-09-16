import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames } from "../../../../db/schema";
import { determineResult, drawEdge, ensureState, getLegalEdges, isGameOver } from "../../../../lib/dotsAndBoxesEngine";
import { DOTS_AND_BOXES_AI_ID, isDotsAndBoxesAiGame, nextMoveDeadline, settleDotsAndBoxesGame } from "../../../../lib/dotsAndBoxesServer";

function chooseEdge(state) {
  const legal = getLegalEdges(state);
  if (!legal.length) return null;
  for (const edge of legal) {
    const probe = drawEdge(state, edge, "guest");
    if (!probe.error && probe.state.scores.guest > state.scores.guest) return edge;
  }
  return legal[Math.floor(Math.random() * legal.length)];
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const gameId = Number(body?.gameId);
    if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const [game] = await tx.select().from(dotsAndBoxesGames).where(eq(dotsAndBoxesGames.id, gameId)).for("update");
      if (!game) throw new Error("Game not found");
      if (!isDotsAndBoxesAiGame(game)) throw new Error("Not an AI game");
      if (userId !== game.hostClerkId) throw new Error("Forbidden");
      if (game.status !== "in_progress") return { skipped: true, game };

      const state = ensureState(game.gameState);
      if (state.currentTurn !== "guest") return { skipped: true, game };
      const edge = chooseEdge(state);
      if (!edge) return { skipped: true, game };
      const moved = drawEdge(state, edge, "guest");
      if (moved.error) throw new Error(moved.error);
      // AI games are untimed — the human's next turn gets no deadline.
      await tx.update(dotsAndBoxesGames).set({ gameState: moved.state, moveDeadlineAt: null }).where(eq(dotsAndBoxesGames.id, game.id));
      return { skipped: false, gameOver: isGameOver(moved.state), winner: isGameOver(moved.state) ? determineResult(moved.state, game.hostClerkId, DOTS_AND_BOXES_AI_ID) : null };
    });

    if (result.gameOver) await settleDotsAndBoxesGame(gameId, result.winner.winnerClerkId, result.winner.result);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error?.message || "Internal Server Error";
    const status = message === "Forbidden" ? 403 : message === "Not an AI game" ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
