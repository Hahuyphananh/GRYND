import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  const { gameId } = await req.json();
  const parsedGameId = String(gameId ?? "").trim();

  if (!UUID_RE.test(parsedGameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(chessGames)
        .where(
          and(
            eq(chessGames.id, parsedGameId),
            eq(chessGames.playerWhiteId, userId),
            eq(chessGames.status, "waiting"),
            eq(chessGames.isAiGame, false),
          ),
        )
        .for("update");

      if (!game) {
        throw new Error("Waiting game not found or cannot be canceled");
      }

      await tx
        .update(chessGames)
        .set({ status: "expired", endedAt: new Date() })
        .where(eq(chessGames.id, parsedGameId));

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${game.betAmount}` })
        .where(eq(users.clerkId, userId));

      return { gameId: parsedGameId };
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to cancel game" },
      { status: 400 },
    );
  }
}
