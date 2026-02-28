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

    const { matchId, targetId, damage = 1 } = await req.json();
    if (!matchId || !targetId) {
      return NextResponse.json(
        { error: "Missing matchId or targetId" },
        { status: 400 }
      );
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

    if (!playerStates[targetId]) {
      return NextResponse.json(
        { error: "Target player not found in state" },
        { status: 404 }
      );
    }

    const currentHealth = Number(playerStates[targetId].health ?? 5);
    const nextHealth = Math.max(0, currentHealth - Number(damage));

    playerStates[targetId] = {
      ...playerStates[targetId],
      health: nextHealth,
      updatedAt: Date.now(),
    };

    await db
      .update(tankMatches)
      .set({
        settings: {
          ...settings,
          playerStates,
        },
      })
      .where(eq(tankMatches.matchId, matchId));

    return NextResponse.json({ success: true, targetId, health: nextHealth });
  } catch (err) {
    console.error("Apply damage error:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
