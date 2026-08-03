import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, crashGames } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  createSignedSession,
  verifySignedSession,
} from "../../../../lib/serverSession";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { sendSystemNotificationEmail } from "../../../../lib/emails/system";
import { randomCrashPoint } from "../../../../lib/games/crash/constants";

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

    if (
      !Number.isFinite(betAmount) ||
      betAmount <= 0 ||
      (multiplier !== undefined && !Number.isFinite(multiplier))
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid request body" },
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

    // ======================================================
    // 1) PLACE BET (ONLY ONCE, STRICT DEDUCTION)
    // ======================================================
    if (immediateDeduct) {
      const result = await db
        .update(users)
        .set({
          balance: sql`${users.balance} - ${betAmount}`,
        })
        .where(
          sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${betAmount}`,
        )
        .returning({ balance: users.balance });

      // ❌ BLOCK IF DEDUCTION FAILED
      if (result.length === 0) {
        return NextResponse.json(
          { success: false, error: "Insufficient balance" },
          { status: 400 },
        );
      }

      const crashPoint = randomCrashPoint();

      // Fire system notification for large crash bets (≥ 1000 tokens)
      if (betAmount >= 1000) {
        sendSystemNotificationEmail({
          eventType: "bet_placed",
          description: `User ${userId} placed a large crash bet of ${betAmount} tokens.`,
          metadata: { userId, betAmount },
        }).catch((err) => console.warn("[system_notify] Failed to send crash bet:", err));
      }

      const token = createSignedSession({
        userId,
        betAmount: Number(betAmount.toFixed(2)),
        crashPoint,
        createdAt: Date.now(),
      });

      const response = NextResponse.json({
        success: true,
        data: {
          newBalance: Number(result[0].balance),
          payout: 0,
        },
      });

      response.cookies.set("crash_session", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 10,
      });

      return response;
    }

    // ======================================================
    // 2) SETTLE GAME (CASHOUT ONLY)
    // ======================================================
    const token = req.cookies.get("crash_session")?.value;
    const session = verifySignedSession(token);

    if (!session || session.userId !== userId) {
      return NextResponse.json(
        { success: false, error: "No active crash session" },
        { status: 400 },
      );
    }

    if (session.claimed) {
      return NextResponse.json(
        { success: false, error: "Session already settled" },
        { status: 400 },
      );
    }

    const bet = Number(session.betAmount);
    const crashPoint = Number(session.crashPoint);
    const cashoutMultiplier = Number(multiplier);

    // ❌ INVALID CASHOUT GUARD
    if (!Number.isFinite(cashoutMultiplier) || cashoutMultiplier < 1) {
      return NextResponse.json(
        { success: false, error: "Invalid cashout attempt" },
        { status: 400 },
      );
    }

    // ======================================================
    // 3) RESULT CALCULATION (SERVER TRUSTED)
    // ======================================================
    const isValidCashout = cashoutMultiplier <= crashPoint;

    const payout = isValidCashout
      ? Number((bet * cashoutMultiplier).toFixed(2))
      : 0;

    const result = isValidCashout ? "won" : "lost";

    // ======================================================
    // 4) UPDATE BALANCE (ONLY WINNINGS ADDED)
    // ======================================================
    const credited = await db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${payout}`,
      })
      .where(eq(users.clerkId, userId))
      .returning({ balance: users.balance });

    // ======================================================
    // 5) GAME HISTORY (ALWAYS LOG LOSS OR WIN)
    // ======================================================
    await db.insert(crashGames).values({
      userId: user.id,
      betAmount: bet.toFixed(2),
      cashedOutAt: isValidCashout ? cashoutMultiplier.toFixed(2) : null,
      payout: payout.toFixed(2),
      result,
      status: "completed",
    });

    await applyLeaderboardCounters({
      clerkId: userId,
      game: "crash",
      betAmount: bet,
      payout,
    });

    // Fire system notification for large crash bets (≥ 1000 tokens)
    if (bet >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} placed a large crash bet of ${bet} tokens (cashed out at ${multiplier ?? "N/A"}x, result: ${result}).`,
        metadata: { userId, bet, multiplier, payout, result },
      }).catch((err) => console.warn("[system_notify] Failed to send crash:", err));
    }

    // ======================================================
    // 6) CLEAR SESSION
    // ======================================================
    const response = NextResponse.json({
      success: true,
      data: {
        newBalance: Number(credited?.balance ?? user.balance),
        payout,
        crashPoint,
        result,
      },
    });

    response.cookies.set("crash_session", "", {
      httpOnly: true,
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch (err) {
    console.error("Crash API error:", err);

    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `Crash settle error for user ${userId}: ${(err).message || "Unknown error"}`,
      metadata: { userId, error: (err).stack?.slice(0, 500) || String(err) },
    }).catch((ew) => console.warn("[system_notify] Failed to send crash error:", ew));

    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
