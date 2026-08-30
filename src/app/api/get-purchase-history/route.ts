// src/app/api/get-purchase-history/route.ts
//
// GET — the authenticated user's token purchase history, newest first.
//
// Sourced from `token_transactions` (the durable ledger written in the same
// transaction as every balance credit), filtered to the caller — a user can
// only ever see their own purchases. Returns display fields only; no Stripe
// secrets.

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../db";
import { tokenTransactions } from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

const PURCHASE_LIMIT = 50;

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    const purchases = await db
      .select({
        id: tokenTransactions.id,
        type: tokenTransactions.type,
        amount: tokenTransactions.amount,
        referenceType: tokenTransactions.referenceType,
        referenceId: tokenTransactions.referenceId,
        note: tokenTransactions.note,
        createdAt: tokenTransactions.createdAt,
      })
      .from(tokenTransactions)
      .where(eq(tokenTransactions.clerkId, userId))
      .orderBy(desc(tokenTransactions.createdAt))
      .limit(PURCHASE_LIMIT);

    return NextResponse.json({ success: true, purchases });
  } catch (err) {
    console.error("[get-purchase-history] Failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
