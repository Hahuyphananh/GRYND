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
      .where(lt(tankMatches.currentPlayers, tankMatches.maxPlayers))
      .orderBy(desc(tankMatches.createdAt))
      .limit(50);

    const filtered = matches.filter((m) => {
      const mode = m?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
      if (mode === "battle_royale") return true;
      return m.isOpen && !m.gameStarted;
    });

    return NextResponse.json({ success: true, games: filtered.slice(0, 20) });
  } catch (error) {
    console.error("Tanks available-games error", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
