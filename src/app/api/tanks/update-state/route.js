import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const SPAWN_PADDING = 120;
const MIN_SPAWN_DISTANCE = 450;

function createSeededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRocks(seed, mapWidth, mapHeight, rockCount) {
  const rand = createSeededRandom(seed);
  return Array.from({ length: rockCount }).map((_, i) => {
    const size = 36 + rand() * 58;
    return {
      id: i,
      size,
      x: rand() * (mapWidth - size),
      y: rand() * (mapHeight - size),
    };
  });
}

function isSpawnBlockedByRock(point, rocks, tankRadius = 22) {
  return rocks.some((rock) => {
    const cx = rock.x + rock.size / 2;
    const cy = rock.y + rock.size / 2;
    const rockR = rock.size / 2;
    return Math.hypot(point.x - cx, point.y - cy) < rockR + tankRadius;
  });
}

function randomSpawnPosition(mapWidth, mapHeight) {
  return {
    x: SPAWN_PADDING + Math.random() * (mapWidth - SPAWN_PADDING * 2),
    y: SPAWN_PADDING + Math.random() * (mapHeight - SPAWN_PADDING * 2),
  };
}

function getSpawnPosition(existingStates, rocks, mapWidth, mapHeight) {
  const occupiedStates = Object.values(existingStates ?? {}).filter(
    (state) => Number.isFinite(Number(state?.x)) && Number.isFinite(Number(state?.y))
  );

  for (let i = 0; i < 30; i += 1) {
    const candidate = randomSpawnPosition(mapWidth, mapHeight);
    const tooClose = occupiedStates.some(
      (state) => Math.hypot(Number(state.x) - candidate.x, Number(state.y) - candidate.y) < MIN_SPAWN_DISTANCE
    );

    if (!tooClose && !isSpawnBlockedByRock(candidate, rocks)) {
      return candidate;
    }
  }

  for (let i = 0; i < 50; i += 1) {
    const candidate = randomSpawnPosition(mapWidth, mapHeight);
    if (!isSpawnBlockedByRock(candidate, rocks)) {
      return candidate;
    }
  }

  return { x: mapWidth / 2, y: mapHeight / 2 };
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
    const mode = settings.mode === "battle_royale" ? "battle_royale" : "duel";
    const mapProfile = settings.mapProfile === "duel_small" ? "duel_small" : "classic";
    const profileMapWidth = mapProfile === "duel_small" ? 2200 : MAP_WIDTH;
    const profileMapHeight = mapProfile === "duel_small" ? 2200 : MAP_HEIGHT;
    const rockCount = mapProfile === "duel_small" ? 30 : 52;
    const rocks = generateRocks(Number(settings.mapSeed ?? 12345), profileMapWidth, profileMapHeight, rockCount);

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

    const hasExistingPosition = Number.isFinite(Number(currentPlayerState.x)) && Number.isFinite(Number(currentPlayerState.y));
    const spawnPosition = hasExistingPosition ? null : getSpawnPosition(playerStates, rocks, profileMapWidth, profileMapHeight);

    playerStates[userId] = {
      x: hasExistingPosition ? Number(x ?? currentPlayerState.x) : spawnPosition.x,
      y: hasExistingPosition ? Number(y ?? currentPlayerState.y) : spawnPosition.y,
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

    const deadPlayerIds = matchPlayers.filter((id) => Number(playerStates[id]?.health ?? 5) <= 0);
    const killerId = normalizedHits[0];
    if (mode === "battle_royale" && killerId && deadPlayerIds.length > 0) {
      const unresolvedStats = await db
        .select({ clerkId: tankStats.clerkId, bounty: tankStats.bounty, kills: tankStats.kills })
        .from(tankStats)
        .where(and(eq(tankStats.matchId, matchId), isNull(tankStats.result)));

      const killerStat = unresolvedStats.find((row) => row.clerkId === killerId);
      if (killerStat) {
        let bountyGain = 0;
        let eliminations = 0;
        for (const deadId of deadPlayerIds) {
          if (deadId === killerId) continue;
          const deadStat = unresolvedStats.find((row) => row.clerkId === deadId);
          bountyGain += Number(deadStat?.bounty ?? 0);
          eliminations += 1;
          await db
            .update(tankStats)
            .set({ result: "lose", amountCashedOut: 0, bounty: "0.00" })
            .where(and(eq(tankStats.matchId, matchId), eq(tankStats.clerkId, deadId), isNull(tankStats.result)));
          delete playerStates[deadId];
        }

        if (bountyGain > 0 || eliminations > 0) {
          await db
            .update(tankStats)
            .set({
              bounty: String(Number(killerStat.bounty ?? 0) + bountyGain),
              kills: sql`${tankStats.kills} + ${eliminations}`,
            })
            .where(and(eq(tankStats.matchId, matchId), eq(tankStats.clerkId, killerId), isNull(tankStats.result)));
        }
      }
    }

    const remainingPlayers = matchPlayers.filter((id) => Number(playerStates[id]?.health ?? 5) > 0);

    let gameOver = null;
    const alivePlayers = remainingPlayers;

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
          currentPlayers: remainingPlayers.length,
          players: remainingPlayers,
          isOpen: remainingPlayers.length < Number(match.maxPlayers ?? 2),
          gameStarted: remainingPlayers.length >= 2 || mode === "battle_royale",
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
