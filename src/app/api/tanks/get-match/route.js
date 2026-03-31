import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { userId } = await auth();
    const url = new URL(req.url);
    const matchId = url.searchParams.get("matchId");

    if (!matchId) {
      return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
    }

    const match = await db
      .select()
      .from(tankMatches)
      .where(eq(tankMatches.matchId, matchId))
      .limit(1);

    if (match.length === 0) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    let matchRow = match[0];

    const mode = matchRow?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
    const countdownEndsAt = Number(matchRow?.settings?.countdownEndsAt ?? 0);
    if (mode === "battle_royale" && !matchRow.gameStarted && countdownEndsAt > 0 && countdownEndsAt <= Date.now()) {
      await db
        .update(tankMatches)
        .set({
          gameStarted: true,
          settings: {
            ...(matchRow.settings ?? {}),
            countdownEndsAt: null,
            countdownDuration: null,
          },
        })
        .where(eq(tankMatches.matchId, matchId));

      const refreshed = await db
        .select()
        .from(tankMatches)
        .where(eq(tankMatches.matchId, matchId))
        .limit(1);
      if (refreshed.length > 0) {
        matchRow = refreshed[0];
      }
    }

    const stats = await db
      .select({
        clerkId: tankStats.clerkId,
        username: tankStats.username,
        bounty: tankStats.bounty,
        kills: tankStats.kills,
      })
      .from(tankStats)
      .where(eq(tankStats.matchId, matchId));

    let bounty = null;
    if (userId) {
      const currentPlayerStats = await db
        .select({ bounty: tankStats.bounty })
        .from(tankStats)
        .where(and(eq(tankStats.matchId, matchId), eq(tankStats.clerkId, userId)))
        .limit(1);

      bounty = currentPlayerStats[0]?.bounty ?? null;
    }

    return NextResponse.json(
      {
        ...matchRow,
        bounty,
        playersStats: stats,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Get match error:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
