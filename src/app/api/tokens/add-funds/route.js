import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auditLog } from "../../../../lib/security/auditLog";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { claimIdempotency } from "../../../../lib/security/idempotency";

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const idem = await claimIdempotency(req, "tokens:add-funds", 180);
    if (idem.enforced && !idem.allowed) {
      return NextResponse.json({ success: false, error: "Duplicate request" }, { status: 409 });
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

    const parsed = await parseAndValidateJson(req, {
      amount: { type: "number", required: true, min: 5, max: 500 },
    });
    if (!parsed.ok) return parsed.response;
    const amount = parsed.data.amount;

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

    auditLog("tokens_add_funds", { userId, amount, previousBalance: currentBalance, newBalance });

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