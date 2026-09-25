import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import { createInitialState, TURN_SECONDS } from "../../../../lib/dotsAndBoxesEngine";
import { DOTS_AND_BOXES_AI_ID } from "../../../../lib/dotsAndBoxesServer";
import { coerceAiDifficulty } from "../../../../lib/aiDifficulty";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    // The lobby's AI-difficulty pick. Absent/invalid coerces to `normal`, so
    // an older client still starts a game.
    const body = await req.json().catch(() => ({}));
    const aiDifficulty = coerceAiDifficulty(body?.difficulty);

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
          aiDifficulty,
          timerSeconds: TURN_SECONDS,
          startedAt: new Date(),
          // Free vs-AI games are untimed — no per-turn deadline is stamped
          // so the human can think as long as they like and the auto-move
          // path (settleAutoMoveIfNeeded) never fires.
          moveDeadlineAt: null,
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
