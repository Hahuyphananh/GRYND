import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";
import { and, eq, or, sql, inArray } from "drizzle-orm";

const HOUSE_EDGE_PERCENT = 2; // same as your UNO payout (1.98)

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const body = await req.json();
    const gameId = Number(body?.gameId);

    if (!gameId) {
      return new Response("Invalid gameId", { status: 400 });
    }

    const [requestingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!requestingUser) {
      return new Response("User not found", { status: 404 });
    }

    //  Find the game
    const [game] = await db.select().from(unoGames).where(eq(unoGames.id, gameId)).limit(1);

    if (!game) {
      return new Response("Game not found", { status: 404 });
    }

    await db.transaction(async (tx) => {
      const [lockedGame] = await tx
        .select()
        .from(unoGames)
        .where(eq(unoGames.id, gameId))
        .for("update");

      if (!lockedGame) return;

      //  Determine game type
      const isAiGame = !lockedGame.player2Id;
      const isWaiting = lockedGame.status === "waiting";
      const isActive = lockedGame.status === "active";

      const betAmount = Number(lockedGame.betAmount);
      const pot = Number(lockedGame.pot || betAmount * 2);

      // =========================
      //  WAITING GAME → REFUND
      // =========================
      if (isWaiting) {
        await tx
          .update(users)
          .set({
            balance: sql`${users.balance} + ${betAmount}`,
          })
          .where(eq(users.clerkId, userId));

        await tx
          .update(unoGames)
          .set({
            status: "finished",
            result: "cancelled",
          })
          .where(eq(unoGames.id, gameId));

        return;
      }

      // =========================
      //  AI GAME → AI WINS
      // =========================
      if (isAiGame && isActive) {
        await tx
          .update(unoGames)
          .set({
            status: "finished",
            winner: "ai",
            result: "loss",
            payout: "0",
          })
          .where(eq(unoGames.id, gameId));

        return;
      }

      // =========================
      //  ONLINE GAME → OPPONENT WINS
      // =========================
      if (!isAiGame && isActive) {
        const opponentId =
          lockedGame.userId === requestingUser.id ? lockedGame.player2Id : lockedGame.userId;

        if (!opponentId) return;

        const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
        const payout = Number((pot - houseFee).toFixed(2));

        //  Pay opponent
        await tx
          .update(users)
          .set({
            balance: sql`${users.balance} + ${payout}`,
          })
          .where(eq(users.id, opponentId));

        //  End game
        await tx
          .update(unoGames)
          .set({
            status: "finished",
            winner: lockedGame.userId === requestingUser.id ? "player2" : "player1",
            result: "loss",
            payout: payout.toString(),
          })
          .where(eq(unoGames.id, gameId));

        return;
      }

      // fallback
      await tx
        .update(unoGames)
        .set({
          status: "finished",
        })
        .where(eq(unoGames.id, gameId));
    });

    return Response.json({ success: true });
  } catch (err) {
    console.error("UNO resign error:", err);
    return new Response("Server error", { status: 500 });
  }
}
