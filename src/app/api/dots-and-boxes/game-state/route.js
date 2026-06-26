import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import {
  ensureState,
  remainingEdges,
} from "../../../../lib/dotsAndBoxesEngine";
import {
  computeMoveTimeRemaining,
  getGameMoveSeconds,
  settleAutoMoveIfNeeded,
} from "../../../../lib/dotsAndBoxesServer";

function getPlayerRole(game, clerkId) {
  if (game.hostClerkId === clerkId) return "host";
  if (game.guestClerkId === clerkId) return "guest";
  return null;
}

export async function GET(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const gameId = Number(searchParams.get("gameId"));
    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const initial = await db
      .select()
      .from(dotsAndBoxesGames)
      .where(eq(dotsAndBoxesGames.id, gameId))
      .limit(1);
    const fetched = initial[0];
    if (!fetched) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    // Lazy server-side auto-move: if any player is fetching and the
    // current turn's deadline has expired, server runs a random legal
    // edge for the current player before returning state.
    const game = await settleAutoMoveIfNeeded(fetched);

    const role = getPlayerRole(game, userId) || "spectator";

    const [hostName, guestName] = await Promise.all([
      db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.clerkId, game.hostClerkId))
        .limit(1)
        .then((rows) => rows[0]?.name || null),
      game.guestClerkId
        ? db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.clerkId, game.guestClerkId))
            .limit(1)
            .then((rows) => rows[0]?.name || null)
        : null,
    ]);

    const gameState = ensureState(game.gameState);

    const timerSeconds = getGameMoveSeconds(game);
    const moveDeadlineAt = game.moveDeadlineAt
      ? new Date(game.moveDeadlineAt).toISOString()
      : null;
    const remainingSeconds = computeMoveTimeRemaining(game.moveDeadlineAt);
    const remaining = remainingEdges(gameState);

    return NextResponse.json({
      success: true,
      data: {
        ...game,
        gameState,
        role,
        hostName: hostName || "Host",
        guestName: guestName || "Guest",
        remainingEdges: remaining,
        timerSeconds,
        moveDeadlineAt,
        remainingSeconds,
      },
    });
  } catch (error) {
    console.error("dots-and-boxes game-state error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
