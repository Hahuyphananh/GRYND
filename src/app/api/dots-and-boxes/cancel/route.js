import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import { settleDotsAndBoxesGame } from "../../../../lib/dotsAndBoxesServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const gameId = Number(body?.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid gameId" },
        { status: 400 },
      );
    }

    const outcome = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(dotsAndBoxesGames)
        .where(eq(dotsAndBoxesGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");

      // ── Waiting: only host can cancel; refund the host's wager ──
      if (game.status === "waiting") {
        if (game.hostClerkId !== userId) {
          throw new Error("Only the host can cancel a waiting game");
        }
        if (!game.guestClerkId) {
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
          return "cancelled";
        }
        throw new Error("Game no longer cancellable in its current state");
      }

      // ── In progress: either player may forfeit; opponent wins pot
      if (game.status === "in_progress") {
        const isHost = game.hostClerkId === userId;
        const isGuest = game.guestClerkId === userId;
        if (!isHost && !isGuest) {
          throw new Error("You are not a player in this game");
        }

        // Forfeiter loses; the other player wins the pot. Settle via
        // the shared helper so refunds and winnings flow through the
        // same ledgers as a natural game end.
        const winnerClerkId = isHost ? game.guestClerkId : game.hostClerkId;
        if (!winnerClerkId) throw new Error("Both players required to forfeit");
        return { outcome: "forfeit", winnerClerkId };
      }

      throw new Error("Game cannot be cancelled in its current state");
    });

    // Settle payout in a separate transaction
    if (typeof outcome === "object" && outcome.outcome === "forfeit") {
      await settleDotsAndBoxesGame(gameId, outcome.winnerClerkId, "forfeit");
    }

    // Re-fetch the result row to return to the client
    const [final] = await db
      .select()
      .from(dotsAndBoxesGames)
      .where(eq(dotsAndBoxesGames.id, gameId))
      .limit(1);

    return NextResponse.json({ success: true, outcome, game: final });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error?.message || "Unable to cancel game" },
      { status: 400 },
    );
  }
}
