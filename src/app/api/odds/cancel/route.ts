import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { oddsGames } from "../../../../db/schema";
import { eq, and } from "drizzle-orm";

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
    const gameId = Number(body.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(
          and(
            eq(oddsGames.id, gameId),
            eq(oddsGames.player1Id, userId),
            eq(oddsGames.status, "waiting"),
          )
        )
        .for("update");

      if (!game) throw new Error("Game not found or not cancellable");

      await tx
        .update(oddsGames)
        .set({ status: "cancelled", endedAt: new Date() })
        .where(eq(oddsGames.id, gameId));
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to cancel game" },
      { status: 500 }
    );
  }
}
