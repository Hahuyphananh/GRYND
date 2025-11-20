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
    // Find the match the player is actually in
    // -------------------------------------------------
    const playerMatch = await db
      .select()
      .from(tankStats)
      .where(eq(tankStats.clerkId, clerkId))
      .limit(1);

    let matchId = null;
    if (playerMatch.length > 0) {
      matchId = playerMatch[0].matchId;
    }

    // -------------------------------------------------
    // UPDATE BALANCE (unchanged)
    // -------------------------------------------------
    const updated = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${amount}` })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    // -------------------------------------------------
    // Update match players if match found
    // -------------------------------------------------
    if (matchId) {
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
          // Decrease currentPlayers
          await db
            .update(tankMatches)
            .set({ currentPlayers: newCount })
            .where(eq(tankMatches.matchId, matchId));
        }
      }

      // ❌ Removed the code that deleted tankStats rows
      // This is what was breaking everything
    }

    return NextResponse.json(
      { success: true, newBalance: updated[0].balance },
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
