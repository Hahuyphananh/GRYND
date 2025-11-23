import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, tankMatches, tankStats } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { amount } = body;

    if (!amount || Number(amount) <= 0)
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });

    // -------------------------------------------------
    // Apply 90% payout (10% house cut)
    // -------------------------------------------------
    const payout = Number(amount) * 0.9;

    // -------------------------------------------------
    // Find this player's stats row
    // -------------------------------------------------
    const playerStats = await db
      .select()
      .from(tankStats)
      .where(eq(tankStats.clerkId, clerkId))
      .limit(1);

    if (playerStats.length === 0) {
      return NextResponse.json(
        { error: "Player not in any match" },
        { status: 400 }
      );
    }

    const { matchId } = playerStats[0];

    // -------------------------------------------------
    // Update user balance
    // -------------------------------------------------
    const updated = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    // -------------------------------------------------
    // Record amount cashed out + result = win
    // -------------------------------------------------
    await db
      .update(tankStats)
      .set({
        amountCashedOut: payout,
        result: "win",
      })
      .where(eq(tankStats.clerkId, clerkId));

    // -------------------------------------------------
    // Manage match player count
    // -------------------------------------------------
    const match = await db
      .select()
      .from(tankMatches)
      .where(eq(tankMatches.matchId, matchId))
      .limit(1);

    if (match.length > 0) {
      const m = match[0];
      const newCount = Math.max(m.currentPlayers - 1, 0);

      if (newCount === 0) {
        // Delete match if no players left
        await db.delete(tankMatches).where(eq(tankMatches.matchId, matchId));
      } else {
        // Update remaining count
        await db
          .update(tankMatches)
          .set({ currentPlayers: newCount })
          .where(eq(tankMatches.matchId, matchId));
      }
    }

    return NextResponse.json(
      { success: true, newBalance: updated[0].balance, payout },
      { status: 200 }
    );
  } catch (err) {
    console.error("Error updating balance:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
