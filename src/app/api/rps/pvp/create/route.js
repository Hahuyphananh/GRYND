import { NextResponse } from "next/server";
import { normalizeStake } from "../../../../../lib/games/stakes";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { rpsPvpGames } from "../../../../../db/schema";

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

  const { betAmount } = await req.json();
  // STAKES ARE RETIRED (src/lib/games/stakes.js) — a match is free to open.
  const parsedBet = normalizeStake(betAmount);

  try {
    const { game } = await db.transaction(async (tx) => {
      const [game] = await tx
        .insert(rpsPvpGames)
        .values({
          player1Id: userId,
          betAmount: parsedBet,
          status: "active",
        })
        .returning();

      return { game };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        player1Id: game.player1Id,
        betAmount: Number(game.betAmount),
        newBalance: null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err.message || "Failed to create game" },
      { status: 400 },
    );
  }
}
