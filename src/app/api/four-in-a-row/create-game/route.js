import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { fourInARowGames, users } from "../../../../db/schema";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const betAmount = Number(body.betAmount);
    const requestedTimerSeconds = Number(body?.timerSeconds);
    const timerSeconds = [10, 30, 60, 120].includes(requestedTimerSeconds)
      ? requestedTimerSeconds
      : 60;

    if (!Number.isFinite(betAmount) || betAmount <= 0) {
      return NextResponse.json(
        { error: "Invalid bet amount" },
        { status: 400 },
      );
    }
    // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
    if (betAmount > 100000) {
      return NextResponse.json(
        { error: "Bet exceeds the maximum of 100,000 tokens" },
        { status: 400 },
      );
    }

    const game = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${betAmount}` })
        .where(
          and(eq(users.clerkId, userId), sql`${users.balance} >= ${betAmount}`),
        )
        .returning({ balance: users.balance });

      if (!updated) throw new Error("Insufficient balance");

      const [created] = await tx
        .insert(fourInARowGames)
        .values({
          hostClerkId: userId,
          betAmount: betAmount.toFixed(2),
          status: "waiting",
          timerSeconds,
        })
        .returning({ id: fourInARowGames.id });

      return { id: created.id, balance: Number(updated.balance) };
    });

    return NextResponse.json({
      success: true,
      gameId: game.id,
      balance: game.balance,
    });
  } catch (error) {
    const message = error?.message || "Internal Server Error";
    const status = message === "Insufficient balance" ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
