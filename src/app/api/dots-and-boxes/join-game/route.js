import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import { READY_WINDOW_MS } from "../../../../lib/dotsAndBoxesServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );

    const body = await req.json();
    const requestedGameId = Number(body?.gameId);
    const quickJoin = Boolean(body?.quickJoin);

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
          .orderBy(asc(dotsAndBoxesGames.createdAt))
          .for("update")
          .limit(1);
      }

      if (!game) throw new Error("No compatible game available");

      const [updatedUser] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${game.betAmount}` })
        .where(
          and(
            eq(users.clerkId, userId),
            sql`${users.balance} >= ${game.betAmount}`,
          ),
        )
        .returning({ balance: users.balance });

      if (!updatedUser) throw new Error("Insufficient balance");

      const [updatedGame] = await tx
        .update(dotsAndBoxesGames)
        .set({
          guestClerkId: userId,
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
        newBalance: Number(updatedUser.balance),
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
