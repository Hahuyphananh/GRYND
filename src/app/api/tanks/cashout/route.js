import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, tankMatches } from "../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { amount, matchId } = body;

    if (!amount || Number(amount) <= 0)
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });

    if (!matchId)
      return NextResponse.json(
        { error: "Missing matchId" },
        { status: 400 }
      );

    // ----------------------------
    // 1) Update user balance
    // ----------------------------
    const updatedUser = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${amount}` })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    // ----------------------------
    // 2) Decrease currentPlayers by 1
    // ----------------------------
    const match = await db
      .select()
      .from(tankMatches)
      .where(eq(tankMatches.matchId, matchId))
      .limit(1);

    if (match.length === 0) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    const currentPlayers = match[0].currentPlayers;
    const newPlayerCount = Math.max(currentPlayers - 1, 0);

    const updatedMatch = await db
      .update(tankMatches)
      .set({
        currentPlayers: newPlayerCount,
        isOpen: newPlayerCount > 0, // close match if empty
      })
      .where(eq(tankMatches.matchId, matchId))
      .returning({
        currentPlayers: tankMatches.currentPlayers,
        isOpen: tankMatches.isOpen,
      });

    return NextResponse.json(
      {
        success: true,
        newBalance: updatedUser[0].balance,
        match: updatedMatch[0],
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Error in cashout:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
