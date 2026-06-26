import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";

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

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid gameId" },
        { status: 400 },
      );
    }

    await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(dotsAndBoxesGames)
        .where(eq(dotsAndBoxesGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");

      // Only the host can cancel a waiting game
      if (game.hostClerkId !== userId)
        throw new Error("Only the host can cancel this game");

      if (game.status === "waiting" && !game.guestClerkId) {
        // Refund the host's wager
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${game.betAmount}` })
          .where(eq(users.clerkId, userId));

        await tx
          .update(dotsAndBoxesGames)
          .set({ status: "cancelled", endedAt: new Date() })
          .where(
            and(
              eq(dotsAndBoxesGames.id, gameId),
              eq(dotsAndBoxesGames.status, "waiting"),
            ),
          );
      } else if (game.status === "in_progress") {
        // Forfeit — opponent wins
        const opponentId = game.guestClerkId;
        if (opponentId) {
          const pot = Number(game.betAmount) * 2;
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} + ${pot}` })
            .where(eq(users.clerkId, opponentId));
        }

        await tx
          .update(dotsAndBoxesGames)
          .set({
            status: "finished",
            result: "forfeit",
            winnerClerkId: opponentId,
            endedAt: new Date(),
          })
          .where(
            and(
              eq(dotsAndBoxesGames.id, gameId),
              eq(dotsAndBoxesGames.status, "in_progress"),
            ),
          );
      } else {
        throw new Error("Game cannot be cancelled in its current state");
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error?.message || "Unable to cancel game" },
      { status: 400 },
    );
  }
}
