import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { users, userStats } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { getLevelFromXp } from "../../../../lib/battlepass";
import { getPrestigeStatus } from "../../../../lib/prestige";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [row] = await db
    .select({
      clerkId: users.clerkId,
      name: users.name,
      level: users.level,
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      prestigeNetWins: users.prestigeNetWins,
      totalWagered: users.totalWagered,
      totalWon: users.totalWon,
      biggestWin: users.biggestWin,
      bestMultiplier: users.bestMultiplier,
      currentStreak: users.currentStreak,
      bestStreak: users.bestStreak,
      weeklyWagered: users.weeklyWagered,
      weeklyWon: users.weeklyWon,
      weeklyProfit: users.weeklyProfit,
      weeklyWins: users.weeklyWins,
      pvpWins: users.pvpWins,
      // XP granted by the most recent settled wager + when it happened
      // (written by applyLeaderboardCounters, migration 0151). Result
      // screens use these with a freshness window so "+N XP" is the real
      // grant from this match, never a stale or invented number.
      lastXpEarned: users.lastSettledXp,
      lastXpEarnedAt: users.lastSettledXpAt,
      winRate: sql<number>`CASE WHEN ${users.totalWagered} > 0 THEN ((${users.totalWon}::numeric / ${users.totalWagered}::numeric) * 100) ELSE 0 END`,
      // Game-result record, maintained incrementally by
      // applyLeaderboardCounters (same source as the leaderboard boards).
      gamesWon: userStats.wins,
      gamesLost: userStats.losses,
      gamesPlayed: userStats.totalBets,
      gameWinRate: userStats.winRate,
      favoriteGame: userStats.favoriteGame,
    })
    .from(users)
    .leftJoin(userStats, eq(userStats.userId, users.id))
    .where(eq(users.clerkId, userId))
    .limit(1);

  if (!row) return Response.json({ error: "User not found" }, { status: 404 });
  // Battlepass level is derived from XP (wagering + quests), not the
  // possibly-stale stored level column. Prestige read-shape mirrors the
  // battlepass endpoint so every consumer sees one consistent contract.
  const prestige = getPrestigeStatus({
    prestigeLevel: row.prestigeLevel,
    prestigeNetWins: row.prestigeNetWins,
    xp: Number(row.xp) || 0,
  });
  return Response.json({
    userStats: {
      ...row,
      level: getLevelFromXp(Number(row.xp) || 0),
      prestige: prestige.prestige,
      prestigeNetWins: prestige.prestigeNetWins,
      nextPrestigeRequirement: prestige.nextPrestigeRequirement,
      prestigeProgressPercent: prestige.prestigeProgressPercent,
      prestigeUnlocked: prestige.prestigeUnlocked,
    },
  });
}
