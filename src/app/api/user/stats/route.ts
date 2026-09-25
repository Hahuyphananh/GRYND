import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { users, userStats } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { getLevelFromXp } from "../../../../lib/battlepass";
import { getPrestigeStatus } from "../../../../lib/prestige";
import {
  RATED_GAMES,
  getRatingGameLabel,
  getRatingsForUser,
  getOverallEloMovementForUser,
  overallEloFromRatingsMap,
} from "../../../../lib/rating";
import { OVERALL_MIN_GAMES, provisionalProgress } from "../../../../lib/elo";

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
  // Per-game Elo ratings (read-only). Only games the player has actually
  // completed a rated match in appear in `ratings`, so an unplayed game
  // reads as "Unrated" rather than a fabricated 1000. `lastDelta` is the
  // delta the player's most recent rated match in that game applied — the
  // real number from server-side settlement, never a client value, and the
  // `provisional*` fields let the UI show whether the rating is still being
  // placed and how many provisional matches are left. Provisional status is
  // per game: a Chess rating can be established while Precision is not.
  const ratings = await getRatingsForUser(row.clerkId);
  // Overall Elo — an aggregate of the established ratings above, computed
  // server-side from the same rows. `overallElo` is null until the player
  // has an established rating in OVERALL_MIN_GAMES different games; a
  // provisional game rating never counts. It is derived on read, never
  // stored, so a game rating change is reflected automatically.
  const overall = overallEloFromRatingsMap(ratings);
  // How the aggregate moved across the player's most recent rated match,
  // reconstructed on read from the rating_events journal (Overall Elo stores
  // no history of its own). The result screen reads these with a freshness
  // window so an old match is never shown as this one's movement.
  const overallMovement = await getOverallEloMovementForUser(
    row.clerkId,
    ratings,
  ).catch(() => null);

  return Response.json({
    userStats: {
      ...row,
      ratings,
      overallElo: overall.overallElo,
      overallEligibleGames: overall.eligibleGames,
      overallEligible: overall.eligible,
      overallMinGames: OVERALL_MIN_GAMES,
      overallEloPrevious: overallMovement?.previousOverallElo ?? null,
      overallEloDelta: overallMovement?.overallDelta ?? null,
      overallEloAt: overallMovement?.at ?? null,
      overallEloGameKey: overallMovement?.gameKey ?? null,
      overallEloOutcome: overallMovement?.outcome ?? null,
      // Every rated game, occupied or not, so the UI never has to hardcode
      // the list. The unplayed defaults are derived from the same config as
      // a real row, so they cannot drift.
      ratedGames: RATED_GAMES.map((key) => ({
        key,
        label: getRatingGameLabel(key),
        ...(ratings[key] || {
          gameKey: key,
          rating: null,
          peakRating: null,
          lastDelta: 0,
          lastRatedAt: null,
          wins: 0,
          losses: 0,
          draws: 0,
          ...provisionalProgress(0),
        }),
      })),
      level: getLevelFromXp(Number(row.xp) || 0),
      prestige: prestige.prestige,
      prestigeNetWins: prestige.prestigeNetWins,
      nextPrestigeRequirement: prestige.nextPrestigeRequirement,
      prestigeProgressPercent: prestige.prestigeProgressPercent,
      prestigeUnlocked: prestige.prestigeUnlocked,
    },
  });
}
