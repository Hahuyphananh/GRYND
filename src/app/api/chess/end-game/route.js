import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { eq, or, inArray } from "drizzle-orm";

// Ends any waiting/active game for this user
export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return new Response("Unauthorized", { status: 401 });

    // Find any game created by this user that is still open (waiting or active)
    const openGame = await db
      .select()
      .from(chessGames)
      .where(
        or(
          eq(chessGames.playerWhiteId, userId),
          eq(chessGames.playerBlackId, userId)
        )
      )
      .where(
        inArray(chessGames.status, ["waiting", "active"])
      )
      .limit(1);

    if (openGame.length === 0) {
      return new Response("No active game found", { status: 200 });
    }

    const gameId = openGame[0].id;

    // Mark the game as expired
    await db
      .update(chessGames)
      .set({ status: "expired" })
      .where(eq(chessGames.id, gameId));

    return new Response("Game expired", { status: 200 });
  } catch (err) {
    console.error("End-game error:", err);
    return new Response("Server error", { status: 500 });
  }
}
