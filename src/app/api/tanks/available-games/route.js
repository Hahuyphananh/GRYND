import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tankMatches, tankStats } from "../../../../db/schema";
import { and, eq, lt, desc } from "drizzle-orm";

export async function GET() {
  try {
    const matches = await db
      .select({
        matchId: tankMatches.matchId,
        currentPlayers: tankMatches.currentPlayers,
        maxPlayers: tankMatches.maxPlayers,
        createdAt: tankMatches.createdAt,
        settings: tankMatches.settings,
        bounty: tankStats.bounty,
        hostName: tankStats.username,
      })
      .from(tankMatches)
      .leftJoin(tankStats, and(eq(tankStats.matchId, tankMatches.matchId), eq(tankStats.clerkId, tankMatches.hostClerkId)))
      .where(and(eq(tankMatches.isOpen, true), lt(tankMatches.currentPlayers, tankMatches.maxPlayers)))
      .orderBy(desc(tankMatches.createdAt))
      .limit(20);

    return NextResponse.json({ success: true, games: matches });
  } catch (error) {
    console.error("Tanks available-games error", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
