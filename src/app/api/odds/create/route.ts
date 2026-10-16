import { NextResponse } from "next/server";
import { requireStake } from "../../../../lib/games/stakes";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { oddsGames } from "../../../../db/schema";
import { eq, and } from "drizzle-orm";
import { initPvPOddsGame } from "../../../../lib/odds";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }


    const body = await req.json();
    // A lobby is free to OPEN: the stake is escrowed for BOTH seats only when
    // the second player joins (`/api/odds/join`), so an unmatched lobby costs
    // nothing and a filled match is always fully funded. The stake itself is
    // REQUIRED, though — a ranked PvP lobby always plays for coins, so a
    // crafted request can never open a free-to-enter one.
    const wagerResult = requireStake(body.wager, "odds");
    if (!wagerResult.ok) {
      return NextResponse.json(
        { success: false, error: wagerResult.error, code: wagerResult.code },
        { status: wagerResult.status },
      );
    }
    const wager = wagerResult.stake;

    // This endpoint only creates PvP lobbies — AI practice mode uses the
    // /api/odds/ai/* routes (free play, no wager deducted).
    const gameState = initPvPOddsGame();

    const newGame = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .insert(oddsGames)
        .values({
          player1Id: userId,
          player2Id: null,
          wager,
          status: "waiting",
          winner: null,
          result: null,
          payout: null,
          isAi: false,
          gameState,
          endedAt: null,
        })
        .returning();

      return game;
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: newGame.id,
        wager: newGame.wager,
        isAi: false,
        gameState: newGame.gameState,
        status: newGame.status,
        winner: newGame.winner,
        result: newGame.result,
        payout: newGame.payout,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create game" },
      { status: 500 }
    );
  }
}
