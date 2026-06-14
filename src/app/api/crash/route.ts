import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, crashGames } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  createSignedSession,
  verifySignedSession,
} from "../../../lib/serverSession";
import { recordBigWinIfNeeded } from "../../../lib/bigWins";

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { betAmount, multiplier, immediateDeduct } = await req.json();

    if (!Number.isFinite(betAmount) || betAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid bet" },
        { status: 400 },
      );
    }

    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!userData.length) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const user = userData[0];

    // =========================
    // 1. PLACE BET (DEDUCT)
    // =========================
    if (immediateDeduct) {
      const [deducted] = await db
        .update(users)
        .set({ balance: sql`${users.balance} - ${betAmount}` })
        .where(
          sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${betAmount}`,
        )
        .returning({ balance: users.balance });

      if (!deducted) {
        return NextResponse.json(
          { success: false, error: "Insufficient balance" },
          { status: 400 },
        );
      }

      const crashPoint = Number((Math.random() * 8 + 1.2).toFixed(2));

      const token = createSignedSession({
        userId,
        betAmount: Number(betAmount),
        crashPoint,
        createdAt: Date.now(),
      });

      const res = NextResponse.json({
        success: true,
        newBalance: Number(deducted.balance),
        crashPoint,
      });

      res.cookies.set("crash_session", token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });

      return res;
    }

    // =========================
    // 2. SETTLE (CASHOUT / LOSS)
    // =========================
    const token = req.cookies.get("crash_session")?.value;
    const session = verifySignedSession(token);

    if (!session || session.userId !== userId) {
      return NextResponse.json(
        { success: false, error: "No active session" },
        { status: 400 },
      );
    }

    const bet = Number(session.betAmount);
    const crashPoint = Number(session.crashPoint);
    const cashoutMultiplier = Number(multiplier);

    if (!Number.isFinite(cashoutMultiplier) || cashoutMultiplier < 1) {
      return NextResponse.json(
        { success: false, error: "Invalid cashout" },
        { status: 400 },
      );
    }

    const won = cashoutMultiplier <= crashPoint;

    const payout = won ? Number((bet * cashoutMultiplier).toFixed(2)) : 0;

    const [updated] = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, userId))
      .returning({ balance: users.balance });

    await db.insert(crashGames).values({
      userId: user.id,
      betAmount: bet.toFixed(2),
      cashedOutAt: won ? cashoutMultiplier.toFixed(2) : null,
      payout: payout.toFixed(2),
      result: won ? "won" : "lost",
      status: "completed",
    });

    // Record big win if payout >= 1 million tokens
    if (won && payout >= 1000000) {
      recordBigWinIfNeeded({
        userId: user.clerkId,
        username: user.name,
        game: "Crash",
        betAmount: bet,
        winAmount: payout,
        multiplier: cashoutMultiplier,
      }).catch(() => {}); // Fire and forget
    }

    const res = NextResponse.json({
      success: true,
      newBalance: Number(updated.balance),
      payout,
      crashPoint,
      result: won ? "won" : "lost",
    });

    res.cookies.set("crash_session", "", {
      httpOnly: true,
      path: "/",
      maxAge: 0,
    });

    return res;
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
