import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { matchId, x, y, rotation, hits = [], bullets = [] } = await req.json();
    if (!matchId) {
      return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
    }

    const rows = await db
      .select()
      .from(tankMatches)
      .where(eq(tankMatches.matchId, matchId))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    const match = rows[0];
    const settings = match.settings ?? {};
    const playerStates = settings.playerStates ?? {};
    const matchPlayers = Array.isArray(match.players) ? match.players : [];

    if (matchPlayers.length > 0 && !matchPlayers.includes(userId)) {
      return NextResponse.json({ error: "Player is not in this match" }, { status: 403 });
    }

    const currentPlayerState = playerStates[userId] ?? {};
    const authoritativeHealth = Number(currentPlayerState.health ?? 5);

    const normalizedBullets = Array.isArray(bullets)
      ? bullets
          .slice(0, 30)
          .map((bullet) => ({
            x: Number(bullet?.x ?? 0),
            y: Number(bullet?.y ?? 0),
            angle: Number(bullet?.angle ?? 0),
          }))
          .filter((bullet) => Number.isFinite(bullet.x) && Number.isFinite(bullet.y) && Number.isFinite(bullet.angle))
      : [];

    playerStates[userId] = {
      x: Number(x ?? 0),
      y: Number(y ?? 0),
      rotation: Number(rotation ?? 0),
      // Never trust client-reported health.
      // Health is server-authoritative and only changes via validated hits.
      health: authoritativeHealth,
      updatedAt: Date.now(),
      bullets: normalizedBullets,
    };

    const normalizedHits = Array.isArray(hits)
      ? [...new Set(hits.filter((id) => typeof id === "string" && id !== userId))]
      : [];

    for (const targetId of normalizedHits) {
      if (!playerStates[targetId]) continue;
      if (matchPlayers.length > 0 && !matchPlayers.includes(targetId)) continue;
      const currentHealth = Number(playerStates[targetId].health ?? 5);
      playerStates[targetId].health = Math.max(0, currentHealth - 1);
    }


    await db
      .update(tankMatches)
      .set({
        settings: {
          ...settings,
          playerStates,
        },
      })
      .where(eq(tankMatches.matchId, matchId));

    return NextResponse.json({
      success: true,
      selfId: userId,
      playerStates,
    });
  } catch (err) {
    console.error("Update tank state error:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
