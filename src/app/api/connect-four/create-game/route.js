import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { connectFourGames, users } from "../../../../db/schema";

export async function POST(req) {
  try {
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
        .insert(connectFourGames)
        .values({
          hostClerkId: userId,
          betAmount: betAmount.toFixed(2),
          status: "waiting",
          timerSeconds,
        })
        .returning({ id: connectFourGames.id });

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
