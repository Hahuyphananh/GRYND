import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { amount } = body;
    if (!amount || Number(amount) <= 0) return NextResponse.json({ error: "Invalid amount" }, { status: 400 });

    // Add tokens to user's balance
    const updated = await db
      .update(users)
      .set({ balance: users.balance.add(amount) })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    return NextResponse.json({ success: true, newBalance: updated[0].balance }, { status: 200 });
  } catch (err) {
    console.error("Error updating balance:", err);
    return NextResponse.json({ error: "Server error", detail: String(err) }, { status: 500 });
  }
}
