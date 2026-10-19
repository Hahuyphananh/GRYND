import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames } from "../../../../db/schema";
import { READY_WINDOW_MS } from "../../../../lib/dotsAndBoxesServer";
import { createInitialState } from "../../../../lib/dotsAndBoxesEngine";
import { escrowMatchWagers } from "../../../../lib/tokens/wager";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );

    const body = await req.json();
    const requestedGameId = Number(body?.gameId);
    const quickJoin = Boolean(body?.quickJoin);
    // The stake the joiner agreed to when they picked this lobby. A request
    // that names a different one is refused instead of being escrowed at an
    // amount the player never chose (the lobby list is public and may be
    // stale).
    const agreedStake = normalizeStake(body?.betAmount, "dots-and-boxes");

    const joined = await db.transaction(async (tx) => {
      let game;

      if (Number.isFinite(requestedGameId) && requestedGameId > 0) {
        [game] = await tx
          .select()
          .from(dotsAndBoxesGames)
          .where(
            and(
              eq(dotsAndBoxesGames.id, requestedGameId),
              eq(dotsAndBoxesGames.status, "waiting"),
              isNull(dotsAndBoxesGames.guestClerkId),
              ne(dotsAndBoxesGames.hostClerkId, userId),
            ),
          )
          .for("update");
      } else if (quickJoin) {
        // Cheapest waiting lobby first, so Quick Join cannot strand a player on
        // a stake they cannot cover when a smaller one is open.
        [game] = await tx
          .select()
          .from(dotsAndBoxesGames)
          .where(
            and(
              eq(dotsAndBoxesGames.status, "waiting"),
              isNull(dotsAndBoxesGames.guestClerkId),
              ne(dotsAndBoxesGames.hostClerkId, userId),
            ),
          )
          .orderBy(asc(dotsAndBoxesGames.betAmount), asc(dotsAndBoxesGames.createdAt))
          .for("update")
          .limit(1);
      }

      if (!game) throw new Error("No compatible game available");
      if (agreedStake !== Number(game.betAmount)) {
        throw new Error("This game is no longer open at that stake");
      }

      // Escrow BOTH stakes before the seat fills: a paid game either funds
      // fully or the join is refused, so a ready game is always backed by two
      // stakes. A free game (bet 0) moves nothing.
      const escrow = await escrowMatchWagers({
        clerkIds: [game.hostClerkId, userId],
        stake: game.betAmount,
        matchId: game.id,
        gameKey: "dots-and-boxes",
        tx,
      });
      if (!escrow.ok) throw new Error(escrow.error || "Insufficient coins");

      const [updatedGame] = await tx
        .update(dotsAndBoxesGames)
        .set({
          guestClerkId: userId,
          // The joining seat opens, matching Barrier Blitz's purple-first
          // rule. The engine's own default is host-first, which is still what
          // a practice match (create-ai) and its tests use.
          gameState: { ...createInitialState(), currentTurn: "guest" },
          // Both players present — enter the brief "Match found!" ready
          // window; advanceReadyIfNeeded flips to in_progress (and sets
          // the first move deadline) once readyDeadlineAt passes.
          status: "ready",
          readyDeadlineAt: new Date(Date.now() + READY_WINDOW_MS),
        })
        .where(
          and(
            eq(dotsAndBoxesGames.id, game.id),
            isNull(dotsAndBoxesGames.guestClerkId),
            eq(dotsAndBoxesGames.status, "waiting"),
          ),
        )
        .returning({
          id: dotsAndBoxesGames.id,
          betAmount: dotsAndBoxesGames.betAmount,
        });

      if (!updatedGame) throw new Error("Game is no longer available");

      return {
        gameId: updatedGame.id,
        betAmount: Number(updatedGame.betAmount),
      };
    });

    return NextResponse.json({ success: true, ...joined });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error?.message || "Unable to join game" },
      { status: 400 },
    );
  }
}
