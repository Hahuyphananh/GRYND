import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import { createInitialState, TURN_SECONDS } from "../../../../lib/dotsAndBoxesEngine";
import { DOTS_AND_BOXES_AI_ID } from "../../../../lib/dotsAndBoxesServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    await req.json().catch(() => ({}));

    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);
      if (!user) throw new Error("User not found");

      const [game] = await tx
        .insert(dotsAndBoxesGames)
        .values({
          hostClerkId: userId,
          guestClerkId: DOTS_AND_BOXES_AI_ID,
          betAmount: "0.00",
          status: "in_progress",
          gameState: createInitialState(),
          isAiGame: true,
          timerSeconds: TURN_SECONDS,
          startedAt: new Date(),
          moveDeadlineAt: new Date(Date.now() + TURN_SECONDS * 1000),
        })
        .returning({ id: dotsAndBoxesGames.id });
      return { gameId: game.id };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("dots-and-boxes/create-ai error", error);
    return NextResponse.json({ success: false, error: error?.message || "Unable to create AI game" }, { status: 500 });
  }
}
