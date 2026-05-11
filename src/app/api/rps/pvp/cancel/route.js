import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { gameId } = await req.json();
  const parsedGameId = Number(gameId);

  if (!Number.isFinite(parsedGameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  try {
    const newBalance = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(rpsPvpGames)
        .where(
          and(
            eq(rpsPvpGames.id, parsedGameId),
            eq(rpsPvpGames.player1Id, userId),
          ),
        )
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.status !== "active")
        throw new Error("Only waiting games can be cancelled");

      await tx
        .update(rpsPvpGames)
        .set({ status: "cancelled" })
        .where(eq(rpsPvpGames.id, parsedGameId));

      const [user] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${game.betAmount}` })
        .where(eq(users.clerkId, userId))
        .returning({ balance: users.balance });

      return Number(user.balance);
    });

    return NextResponse.json({ success: true, data: { newBalance } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to cancel game" },
      { status: 400 },
    );
  }
}
