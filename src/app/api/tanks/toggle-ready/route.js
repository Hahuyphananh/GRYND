import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const matchId = body?.matchId;
    const ready = Boolean(body?.ready);

    if (!matchId) return NextResponse.json({ error: "Missing matchId" }, { status: 400 });

    const rows = await db.select().from(tankMatches).where(eq(tankMatches.matchId, matchId)).limit(1);
    if (rows.length === 0) return NextResponse.json({ error: "Match not found" }, { status: 404 });

    const match = rows[0];
    const mode = match?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
    if (mode !== "battle_royale") {
      return NextResponse.json({ error: "Ready state is only available in battle royale" }, { status: 400 });
    }

    const players = Array.isArray(match.players) ? match.players : [];
    if (!players.includes(userId)) {
      return NextResponse.json({ error: "Player is not in this match" }, { status: 403 });
    }

    const readyPlayers = new Set(Array.isArray(match?.settings?.readyPlayers) ? match.settings.readyPlayers : []);
    if (ready) readyPlayers.add(userId);
    else readyPlayers.delete(userId);

    const readyCount = players.filter((id) => readyPlayers.has(id)).length;
    const total = players.length;

    let countdownEndsAt = match?.settings?.countdownEndsAt ?? null;
    let countdownDuration = match?.settings?.countdownDuration ?? null;
    let gameStarted = Boolean(match.gameStarted);

    if (!gameStarted) {
      if (readyCount >= 2) {
        const now = Date.now();
        const fastStart = total > 1 && readyCount === total;
        const targetDuration = fastStart ? 3 : 10;
        const currentRemainingMs = countdownEndsAt ? countdownEndsAt - now : null;

        if (!currentRemainingMs || currentRemainingMs <= 0 || countdownDuration !== targetDuration) {
          countdownDuration = targetDuration;
          countdownEndsAt = now + targetDuration * 1000;
        }

        if (countdownEndsAt <= now) {
          gameStarted = true;
          countdownEndsAt = null;
          countdownDuration = null;
        }
      } else {
        countdownEndsAt = null;
        countdownDuration = null;
      }
    }

    const nextSettings = {
      ...(match.settings ?? {}),
      readyPlayers: Array.from(readyPlayers),
      countdownEndsAt,
      countdownDuration,
    };

    await db
      .update(tankMatches)
      .set({
        settings: nextSettings,
        gameStarted,
      })
      .where(eq(tankMatches.matchId, matchId));

    return NextResponse.json({
      success: true,
      readyPlayers: nextSettings.readyPlayers,
      readyCount,
      totalPlayers: total,
      countdownEndsAt,
      countdownDuration,
      gameStarted,
    });
  } catch (err) {
    console.error("Toggle ready error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
