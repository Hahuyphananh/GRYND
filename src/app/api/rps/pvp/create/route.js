import { NextResponse } from "next/server";
import { requireStake } from "../../../../../lib/games/stakes";
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
  // A ranked match always plays for coins: the stake is REQUIRED and must be
  // legal, so a crafted request can never open a free-to-enter lobby.
  const wager = requireStake(betAmount, "rps");
  if (!wager.ok) {
    return NextResponse.json(
      { success: false, error: wager.error, code: wager.code },
      { status: wager.status },
    );
  }
  const parsedBet = wager.stake;

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
