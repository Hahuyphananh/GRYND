import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { fourInARowGames } from "../../../../db/schema";
import {
  advanceReadyIfNeeded,
  computeMoveTimeRemaining,
  getGameMoveSeconds,
  getPlayerRole,
  getUserAliases,
  settleTimeoutIfNeeded,
} from "../../../../lib/fourInARowServer";
import { getSeatIdentity } from "../../../../lib/seatIdentity";

function computeReplayTimeRemaining(deadline) {
  if (!deadline) return 0;
  const endsAt = new Date(deadline).getTime();
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

export async function GET(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

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
      .from(fourInARowGames)
      .where(eq(fourInARowGames.id, gameId))
      .limit(1);
    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const role = getPlayerRole(game, userAliases) || "spectator";

    // Lazy server-side advance: if the ready countdown has elapsed, flip
    // to in_progress (and set the first move deadline) before responding.
    game = await advanceReadyIfNeeded(game);
    game = await settleTimeoutIfNeeded(game);

    // Full seat identity (real username + official icon + equipped name
    // color) for both seats. The AI guest (no users row) resolves to
    // nulls and the client falls back to its "AI" label.
    const identity = await getSeatIdentity(
      game.hostClerkId,
      game.guestClerkId,
    );
    const host = identity.player1;
    const guest = identity.player2;

    return NextResponse.json({
      success: true,
      data: {
        ...game,
        role,
        hostName: host?.name || "Host",
        guestName: guest?.name || "Guest",
        hostIconKey: host?.iconKey ?? null,
        guestIconKey: guest?.iconKey ?? null,
        hostNameColor: host?.nameColor ?? null,
        guestNameColor: guest?.nameColor ?? null,
        hostProfileFrame: host?.profileFrame ?? null,
        guestProfileFrame: guest?.profileFrame ?? null,
        moveTimeLimit: getGameMoveSeconds(game),
        moveTimeRemaining: computeMoveTimeRemaining(game.moveDeadlineAt),
        replayTimeRemaining: computeReplayTimeRemaining(game.replayDeadlineAt),
      },
    });
  } catch (error) {
    console.error("four-in-a-row game-state error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
