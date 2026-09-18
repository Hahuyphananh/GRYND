import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import { resolvePrestigeBadge } from "../../../../lib/prestige";
import { getSeatIdentity } from "../../../../lib/seatIdentity";

import {
  ensureState,
  remainingEdges,
} from "../../../../lib/dotsAndBoxesEngine";
import {
  advanceReadyIfNeeded,
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
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

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

    // Lazy server-side advance: if the ready countdown has elapsed, flip
    // to in_progress (and set the first move deadline) before responding.
    let game = await advanceReadyIfNeeded(fetched);

    // Lazy server-side auto-move: if any player is fetching and the
    // current turn's deadline has expired, server runs a random legal
    // edge for the current player before returning state.
    game = await settleAutoMoveIfNeeded(game);

    const role = getPlayerRole(game, userId) || "spectator";

    // Full seat identity (real username + official icon + equipped name
    // color) for both seats — one shared query. The AI seat (no users
    // row) resolves to nulls and the client falls back to its label.
    const identity = await getSeatIdentity(
      game.hostClerkId,
      game.guestClerkId,
    );
    const hostName = identity.player1?.name || null;
    const guestName = identity.player2?.name || null;

    const [hostBadge, guestBadge] = await Promise.all([
      db
        .select({
          xp: users.xp,
          prestigeLevel: users.prestigeLevel,
          showPrestigeBadge: users.showPrestigeBadge,
        })
        .from(users)
        .where(eq(users.clerkId, game.hostClerkId))
        .limit(1)
        .then((rows) =>
          rows[0]
            ? resolvePrestigeBadge({
                xp: rows[0].xp,
                prestigeLevel: rows[0].prestigeLevel,
                showPrestigeBadge: rows[0].showPrestigeBadge,
              })
            : null,
        ),
      game.guestClerkId
        ? db
            .select({
              xp: users.xp,
              prestigeLevel: users.prestigeLevel,
              showPrestigeBadge: users.showPrestigeBadge,
            })
            .from(users)
            .where(eq(users.clerkId, game.guestClerkId))
            .limit(1)
            .then((rows) =>
              rows[0]
                ? resolvePrestigeBadge({
                    xp: rows[0].xp,
                    prestigeLevel: rows[0].prestigeLevel,
                    showPrestigeBadge: rows[0].showPrestigeBadge,
                  })
                : null,
            )
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
        hostIconKey: identity.player1?.iconKey ?? null,
        guestIconKey: identity.player2?.iconKey ?? null,
        hostNameColor: identity.player1?.nameColor ?? null,
        guestNameColor: identity.player2?.nameColor ?? null,
        hostPrestigeBadge: hostBadge || null,
        guestPrestigeBadge: guestBadge || null,

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
