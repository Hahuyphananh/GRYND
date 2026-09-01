import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { users, userStats } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { getLevelFromXp } from "../../../../lib/battlepass";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [row] = await db
    .select({
      clerkId: users.clerkId,
      name: users.name,
      level: users.level,
      xp: users.xp,
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
  // possibly-stale stored level column.
  return Response.json({
    userStats: { ...row, level: getLevelFromXp(Number(row.xp) || 0) },
  });
}
