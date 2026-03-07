import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const SPAWN_MARGIN = 120;
const MIN_SPAWN_DISTANCE = 450;

function generateSpawnPosition(existingStates) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const x = SPAWN_MARGIN + Math.random() * (MAP_WIDTH - SPAWN_MARGIN * 2);
    const y = SPAWN_MARGIN + Math.random() * (MAP_HEIGHT - SPAWN_MARGIN * 2);

    const overlapsExisting = Object.values(existingStates).some((player) => {
      const px = Number(player?.x);
      const py = Number(player?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
      return Math.hypot(px - x, py - y) < MIN_SPAWN_DISTANCE;
    });

    if (!overlapsExisting) {
      return { x, y };
    }
  }

  return {
    x: SPAWN_MARGIN + Math.random() * (MAP_WIDTH - SPAWN_MARGIN * 2),
    y: SPAWN_MARGIN + Math.random() * (MAP_HEIGHT - SPAWN_MARGIN * 2),
  };
}

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

    const hasSpawn = Number.isFinite(Number(currentPlayerState.x)) && Number.isFinite(Number(currentPlayerState.y));
    const spawn = hasSpawn ? null : generateSpawnPosition(playerStates);

    playerStates[userId] = {
      x: hasSpawn ? Number(x ?? currentPlayerState.x ?? 0) : spawn.x,
      y: hasSpawn ? Number(y ?? currentPlayerState.y ?? 0) : spawn.y,
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

    let gameOver = null;
    const alivePlayers = matchPlayers.filter((id) => Number(playerStates[id]?.health ?? 5) > 0);

    if (matchPlayers.length === 2 && alivePlayers.length === 1) {
      const winnerId = alivePlayers[0];
      const loserId = matchPlayers.find((id) => id !== winnerId);

      if (loserId) {
        const unresolvedStats = await db
          .select({ clerkId: tankStats.clerkId, bounty: tankStats.bounty })
          .from(tankStats)
          .where(and(eq(tankStats.matchId, matchId), isNull(tankStats.result)));

        if (unresolvedStats.length > 0) {
          const winnerStat = unresolvedStats.find((row) => row.clerkId === winnerId);
          const loserStat = unresolvedStats.find((row) => row.clerkId === loserId);

          if (winnerStat && loserStat) {
            const winnerBet = Number(winnerStat.bounty ?? 0);
            const loserBet = Number(loserStat.bounty ?? 0);
            const winnerPayout = winnerBet + loserBet * 0.9;

            await db
              .update(users)
              .set({ balance: sql`${users.balance} + ${winnerPayout}` })
              .where(eq(users.clerkId, winnerId));

            await db
              .update(tankStats)
              .set({
                result: "win",
                amountCashedOut: winnerPayout,
              })
              .where(and(eq(tankStats.matchId, matchId), eq(tankStats.clerkId, winnerId)));

            await db
              .update(tankStats)
              .set({
                result: "lose",
                amountCashedOut: 0,
              })
              .where(and(eq(tankStats.matchId, matchId), eq(tankStats.clerkId, loserId)));

            gameOver = {
              winnerId,
              loserId,
              winnerPayout,
            };
          }
        }

        if (gameOver) {
          await db
            .update(tankMatches)
            .set({
              isOpen: false,
              gameStarted: false,
              currentPlayers: 0,
              players: [],
              settings: {
                ...settings,
                playerStates: {},
                gameOver,
              },
            })
            .where(eq(tankMatches.matchId, matchId));

          await db.delete(tankMatches).where(eq(tankMatches.matchId, matchId));
        }
      }
    }

    if (!gameOver) {
      await db
        .update(tankMatches)
        .set({
          settings: {
            ...settings,
            playerStates,
          },
        })
        .where(eq(tankMatches.matchId, matchId));
    }

    return NextResponse.json({
      success: true,
      selfId: userId,
      playerStates,
      gameOver,
    });
  } catch (err) {
    console.error("Update tank state error:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
