import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get user from Clerk to verify age
    const clerkUser = await clerkClient.users.getUser(userId);
    const birthDate = clerkUser.publicMetadata?.birthDate;

    if (!birthDate) {
      return NextResponse.json(
        { success: false, error: "Birth date not found. Please complete your profile." },
        { status: 400 }
      );
    }

    // Verify age (must be 18+)
    const age = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) {
      return NextResponse.json(
        { success: false, error: "You must be at least 18 years old to add funds." },
        { status: 403 }
      );
    }

    const body = await req.json();
    const amount = parseFloat(body.amount);

    // Server-side validation
    if (!amount || isNaN(amount) || amount < 5 || amount > 500) {
      return NextResponse.json(
        { success: false, error: "Invalid amount. Must be between $5 and $500." },
        { status: 400 }
      );
    }

    // Get current user from database
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    // Update user balance
    const currentBalance = parseFloat(user.balance);
    const newBalance = currentBalance + amount;

    await db
      .update(users)
      .set({ balance: newBalance.toString() })
      .where(eq(users.clerkId, userId));

    // Log transaction for audit (optional - you can create a transactions table)
    console.log(`[AUDIT] User ${userId} added $${amount} to balance. New balance: $${newBalance}`);

    return NextResponse.json({
      success: true,
      message: `Successfully added $${amount.toFixed(2)} to your account`,
      newBalance: newBalance,
      addedAmount: amount
    });

  } catch (error) {
    console.error("Add funds error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}