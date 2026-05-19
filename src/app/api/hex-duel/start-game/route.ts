import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized — please sign in" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const wager = Number(body.wager);

    if (!Number.isFinite(wager) || wager <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid wager amount" },
        { status: 400 }
      );
    }

    // Atomic: deduct wager only if balance is sufficient
    const [updatedUser] = await db
      .update(users)
      .set({
        balance: sql`${users.balance} - ${wager}`,
        totalWagered: sql`${users.totalWagered} + ${wager}`,
      })
      .where(
        sql`${users.clerkId} = ${clerkId} AND ${users.balance} >= ${wager}`
      )
      .returning({ balance: users.balance });

    if (!updatedUser) {
      return NextResponse.json(
        { success: false, error: "Insufficient balance" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        wager,
        newBalance: Number(updatedUser.balance),
      },
    });
  } catch (error) {
    console.error("❌ Hex Duel start-game error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Server error",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 }
    );
  }
}
