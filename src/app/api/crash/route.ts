import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createSignedSession } from "../../../lib/serverSession";
import { randomCrashPoint } from "../../../lib/games/crash/constants";

/**
 * POST /api/crash — place a bet for Classic Crash.
 *
 * Deducts the bet amount from the user's wallet, generates a
 * server-authoritative crash point, and sets a signed session cookie.
 *
 * Settlement is handled by /api/crash/settle (settle/route.js).
 */
export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { betAmount } = await req.json();

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

    // Deduct bet from wallet
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

    const crashPoint = randomCrashPoint();

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
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
