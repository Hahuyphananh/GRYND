import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";
import { and, eq, isNull, ne, desc } from "drizzle-orm";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );
  }

  try {
    const currentUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!currentUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 },
      );
    }

    const waitingGames = await db
      .select({
        id: unoGames.id,
        betAmount: unoGames.betAmount,
        createdAt: unoGames.createdAt,
        hostName: users.name,
      })
      .from(unoGames)
      .innerJoin(users, eq(unoGames.userId, users.id))
      .where(
        and(
          eq(unoGames.status, "waiting"),
          isNull(unoGames.player2Id),
          ne(unoGames.userId, currentUser.id),
        ),
      )
      .orderBy(desc(unoGames.createdAt));

    const currentBalance = parseFloat(currentUser.balance);
    const games = waitingGames.map((game) => {
      const bet = parseFloat(game.betAmount);
      return {
        id: game.id,
        betAmount: game.betAmount,
        hostName: game.hostName,
        createdAt: game.createdAt,
        canAfford: currentBalance >= bet,
      };
    });

    return new Response(JSON.stringify({ success: true, data: games }), {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3, stale-while-revalidate=7",
      },
    });
  } catch (error) {
    console.error("UNO available-games error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500 },
    );
  }
}
