import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { rpsPvpGames } from "../../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;

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
    const { game, newBalance } = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(rpsPvpGames)
        .where(
          and(
            eq(rpsPvpGames.id, parsedGameId),
            isNull(rpsPvpGames.player2Id),
            eq(rpsPvpGames.status, "active"),
          ),
        )
        .for("update");

      if (!game) {
        throw new Error("Game is no longer available");
      }
      if (game.player1Id === userId) {
        throw new Error("Cannot join your own game");
      }

      const [matchedGame] = await tx
        .update(rpsPvpGames)
        .set({
          player2Id: userId,
          status: "matched",
        })
        .where(eq(rpsPvpGames.id, parsedGameId))
        .returning();

      return { game: matchedGame, newBalance: null };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        newBalance,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to join game" },
      { status: 400 },
    );
  }
}
