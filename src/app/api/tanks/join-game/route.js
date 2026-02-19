import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { eq, and, lt, desc, sql } from "drizzle-orm";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Find ONE open match and lock it
    const match = await db
      .select()
      .from(tankMatches)
      .where(
        and(
          eq(tankMatches.isOpen, true),
          lt(tankMatches.currentPlayers, tankMatches.maxPlayers)
        )
      )
      .orderBy(desc(tankMatches.currentPlayers))
      .limit(1);

    if (match.length === 0) {
      return NextResponse.json(
        { error: "No matches available." },
        { status: 404 }
      );
    }

    const selectedMatch = match[0];

    // Prevent joining twice
    if (selectedMatch.players.includes(userId)) {
      return NextResponse.json({
        success: true,
        matchId: selectedMatch.matchId,
      });
    }

    // 🔥 CRITICAL: Atomic update
    const updated = await db
      .update(tankMatches)
      .set({
        currentPlayers: sql`${tankMatches.currentPlayers} + 1`,
        players: sql`${tankMatches.players} || jsonb_build_array(${userId})`,
        isOpen: false, // since maxPlayers = 2
        gameStarted: true, 
      })
      .where(
        and(
          eq(tankMatches.matchId, selectedMatch.matchId),
          lt(tankMatches.currentPlayers, 2)
        )
      )
      .returning();

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "Match just filled. Try again." },
        { status: 400 }
      );
    }

    // Insert into tank_stats
    await db.insert(tankStats).values({
      matchId: selectedMatch.matchId,
      clerkId: userId,
      username: "Player",
      bounty: 10,
      kills: 0,
      amountCashedOut: 0,
    });

    return NextResponse.json({
      success: true,
      matchId: selectedMatch.matchId,
    });

  } catch (err) {
    console.error("Join game error:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}

