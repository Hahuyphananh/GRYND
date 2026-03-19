import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
  }

  const { gameId } = await request.json();
  if (!gameId) {
    return new Response(JSON.stringify({ success: false, error: "Missing gameId" }), { status: 400 });
  }

  try {
    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
    }

    const waitingGame = await db.query.unoGames.findFirst({
      where: and(
        eq(unoGames.id, Number(gameId)),
        eq(unoGames.userId, user.id),
        eq(unoGames.status, "waiting"),
        isNull(unoGames.player2Id)
      ),
    });

    if (!waitingGame) {
      return new Response(JSON.stringify({ success: false, error: "Waiting game not found" }), { status: 404 });
    }

    const refund = parseFloat(waitingGame.betAmount || "0");
    const currentBalance = parseFloat(user.balance || "0");
    const updatedBalance = (currentBalance + refund).toFixed(2);

    await db.transaction(async (tx) => {
      await tx
        .update(unoGames)
        .set({
          status: "cancelled",
          result: "cancelled",
          winner: "cancelled",
          payout: "0.00",
        })
        .where(eq(unoGames.id, waitingGame.id));

      await tx
        .update(users)
        .set({ balance: updatedBalance })
        .where(eq(users.id, user.id));
    });

    return new Response(
      JSON.stringify({ success: true, message: "Game cancelled", newBalance: updatedBalance }),
      { status: 200 }
    );
  } catch (error) {
    console.error("UNO cancel waiting error:", error);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), { status: 500 });
  }
}
