import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { connectFourGames } from "../../../../db/schema";
import {
  computeMoveTimeRemaining,
  getGameMoveSeconds,
  getPlayerRole,
  getUserAliases,
  resolveNameByClerkId,
  settleTimeoutIfNeeded,
} from "../../../../lib/connectFourServer";

function computeReplayTimeRemaining(deadline) {
  if (!deadline) return 0;
  const endsAt = new Date(deadline).getTime();
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

export async function GET(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const gameId = Number(searchParams.get("gameId"));
    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const userAliases = await getUserAliases(userId);

    let [game] = await db
      .select()
      .from(connectFourGames)
      .where(eq(connectFourGames.id, gameId))
      .limit(1);
    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const role = getPlayerRole(game, userAliases) || "spectator";

    game = await settleTimeoutIfNeeded(game);

    const [hostName, guestName] = await Promise.all([
      resolveNameByClerkId(game.hostClerkId),
      resolveNameByClerkId(game.guestClerkId),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        ...game,
        role,
        hostName: hostName || "Host",
        guestName: guestName || "Guest",
        moveTimeLimit: getGameMoveSeconds(game),
        moveTimeRemaining: computeMoveTimeRemaining(game.moveDeadlineAt),
        replayTimeRemaining: computeReplayTimeRemaining(game.replayDeadlineAt),
      },
    });
  } catch (error) {
    console.error("connect-four game-state error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
