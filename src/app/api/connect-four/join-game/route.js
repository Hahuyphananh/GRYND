import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { connectFourGames, users } from "../../../../db/schema";
import { nextMoveDeadline } from "../../../../lib/connectFourServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const requestedGameId = Number(body?.gameId);
    const quickJoin = Boolean(body?.quickJoin);

    const joined = await db.transaction(async (tx) => {
      let game;

      if (Number.isFinite(requestedGameId) && requestedGameId > 0) {
        [game] = await tx
          .select()
          .from(connectFourGames)
          .where(
            and(
              eq(connectFourGames.id, requestedGameId),
              eq(connectFourGames.status, "waiting"),
              isNull(connectFourGames.guestClerkId),
              ne(connectFourGames.hostClerkId, userId)
            )
          )
          .for("update");
      } else if (quickJoin) {
        [game] = await tx
          .select()
          .from(connectFourGames)
          .where(
            and(
              eq(connectFourGames.status, "waiting"),
              isNull(connectFourGames.guestClerkId),
              ne(connectFourGames.hostClerkId, userId)
            )
          )
          .orderBy(asc(connectFourGames.createdAt))
          .for("update")
          .limit(1);
      }

      if (!game) throw new Error("No compatible game available");

      const [updatedUser] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${game.betAmount}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${game.betAmount}`))
        .returning({ balance: users.balance });

      if (!updatedUser) throw new Error("Insufficient balance");

      const [updatedGame] = await tx
        .update(connectFourGames)
        .set({
          guestClerkId: userId,
          status: "in_progress",
          startedAt: new Date(),
          currentTurn: "host",
          moveDeadlineAt: nextMoveDeadline(),
        })
        .where(and(eq(connectFourGames.id, game.id), isNull(connectFourGames.guestClerkId), eq(connectFourGames.status, "waiting")))
        .returning({ id: connectFourGames.id, betAmount: connectFourGames.betAmount });

      if (!updatedGame) throw new Error("Game is no longer available");

      return { gameId: updatedGame.id, betAmount: Number(updatedGame.betAmount), newBalance: Number(updatedUser.balance) };
    });

    return NextResponse.json({ success: true, ...joined });
  } catch (error) {
    return NextResponse.json({ success: false, error: error?.message || "Unable to join game" }, { status: 400 });
  }
}
