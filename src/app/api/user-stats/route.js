import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../db/neon";
import {
  getBattlepassProgressFromTrophies,
  getLevelFromTrophies,
} from "../../../lib/battlepass";
import { getTotalTrophiesForUser } from "../../../lib/trophyStore";
import { getHighestTitle } from "../../../lib/titles";
import { cacheOrFetch } from "../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../lib/redis/keys";
import { getRatingsForUser, overallEloFromRatingsMap } from "../../../lib/rating";
import { OVERALL_MIN_GAMES } from "../../../lib/elo";

import { db } from "../../../db";
import { and, count, eq, or, sql as drizzleSql } from "drizzle-orm";
import {
  users,
  rouletteGames,
  blackjackGames,
  minesGames,
  plinkoGames,
  rpsGames,
  crashGames,
  unoGames,
  chessGames,
  keno_games,
  kenoPvpMatches,
  laneRushDuelMatches,
  memoryGridMatches,
  fourInARowGames,
  laneRunnerGames,
  hexDuelGames,
  oddsGames,
  diceFlushPlayers,
} from "../../../db/schema";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const sql = getNeonSql();

    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!dbUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
        },
      );
    }

    const uid = dbUser.id;
    const clerkId = userId;
    const cacheKey = CacheKeys.userStats(clerkId);

    // Cache the heavy stat computation. Side-effect writes happen only on miss.
    //
    // All stats are sourced from the maintained user_stats / users counters
    // (updated incrementally by applyLeaderboardCounters on every
    // settlement) instead of re-scanning every game-history table. This
    // route used to fan out ~19 row fetches (up to 1,000 rows per table)
    // per cache miss just to re-derive numbers the counters already hold —
    // and for heavy players those derived numbers were undercounts of the
    // authoritative counters (the cap hid rows). favorite_game is the one
    // stat the counters don't track, so it is the only thing still computed
    // from history — as cheap per-table counts, then persisted.
    const stats = await cacheOrFetch(cacheKey, CacheTTL.userStats, async () => {
      // ── favorite_game: most-played game, from per-table counts ────────
      // Mirrors the per-table id predicates used across the app (some tables
      // key by integer user id, some by Clerk id; chess/keno-pvp/... are
      // player1/player2 pairs or a per-user id).
      // Aggregates transfer ~19 rows instead of up to ~19,000. A failing
      // table just contributes 0 — it must never fail the request.
      const safeCount = async (label, fn) => {
        try {
          const [r] = await fn();
          return Number(r?.n ?? 0);
        } catch (err) {
          console.error(`[user-stats] Count failed for ${label}:`, err);
          return 0;
        }
      };

      const counts = await Promise.all([
        safeCount("roulette", () =>
          db.select({ n: count() }).from(rouletteGames).where(eq(rouletteGames.userId, uid)),
        ),
        safeCount("blackjack", () =>
          db.select({ n: count() }).from(blackjackGames).where(eq(blackjackGames.userId, uid)),
        ),
        safeCount("mines", () =>
          db.select({ n: count() }).from(minesGames).where(eq(minesGames.userId, uid)),
        ),
        safeCount("plinko", () =>
          db.select({ n: count() }).from(plinkoGames).where(eq(plinkoGames.userId, clerkId)),
        ),
        safeCount("crash", () =>
          db.select({ n: count() }).from(crashGames).where(eq(crashGames.userId, uid)),
        ),
        safeCount("rps", () =>
          db.select({ n: count() }).from(rpsGames).where(eq(rpsGames.userId, clerkId)),
        ),
        safeCount("uno", () =>
          db.select({ n: count() }).from(unoGames).where(eq(unoGames.userId, uid)),
        ),
        safeCount("chess", () =>
          db
            .select({ n: count() })
            .from(chessGames)
            .where(
              or(
                eq(chessGames.playerWhiteId, clerkId),
                eq(chessGames.playerBlackId, clerkId),
              ),
            ),
        ),
        safeCount("keno-pvp", () =>
          db
            .select({ n: count() })
            .from(kenoPvpMatches)
            .where(
              or(
                eq(kenoPvpMatches.player1Id, clerkId),
                eq(kenoPvpMatches.player2Id, clerkId),
              ),
            ),
        ),
        safeCount("keno", () =>
          db.select({ n: count() }).from(keno_games).where(eq(keno_games.user_id, uid)),
        ),
        safeCount("four-in-a-row", () =>
          db
            .select({ n: count() })
            .from(fourInARowGames)
            .where(
              or(
                eq(fourInARowGames.hostClerkId, clerkId),
                eq(fourInARowGames.guestClerkId, clerkId),
              ),
            ),
        ),
        safeCount("lane-runner", () =>
          db.select({ n: count() }).from(laneRunnerGames).where(eq(laneRunnerGames.userId, uid)),
        ),
        safeCount("lane-rush-duel", () =>
          db
            .select({ n: count() })
            .from(laneRushDuelMatches)
            .where(
              or(
                eq(laneRushDuelMatches.player1Id, clerkId),
                eq(laneRushDuelMatches.player2Id, clerkId),
              ),
            ),
        ),
        safeCount("memory-grid", () =>
          db
            .select({ n: count() })
            .from(memoryGridMatches)
            .where(
              or(
                eq(memoryGridMatches.player1Id, clerkId),
                eq(memoryGridMatches.player2Id, clerkId),
              ),
            ),
        ),
        safeCount("hex-duel", () =>
          db
            .select({ n: count() })
            .from(hexDuelGames)
            .where(
              and(
                or(
                  eq(hexDuelGames.player1Id, clerkId),
                  eq(hexDuelGames.player2Id, clerkId),
                ),
                eq(hexDuelGames.isFunMode, false),
              ),
            ),
        ),
        safeCount("odds", () =>
          db
            .select({ n: count() })
            .from(oddsGames)
            .where(
              or(
                eq(oddsGames.player1Id, clerkId),
                eq(oddsGames.player2Id, clerkId),
              ),
            ),
        ),
        safeCount("dice-flush", () =>
          db.select({ n: count() }).from(diceFlushPlayers).where(eq(diceFlushPlayers.userId, clerkId)),
        ),
      ]);

      const gameCounts = [
        ["Roulette", counts[0]],
        ["Blackjack", counts[1]],
        ["Mines", counts[2]],
        ["Plinko", counts[3]],
        ["Crash", counts[4]],
        ["RPS", counts[5]],
        ["UNO", counts[6]],
        ["Chess", counts[7]],
        ["Keno Duel", counts[8]],
        ["Keno", counts[9]],
        ["Four-In-A-Row", counts[10]],
        ["Lane Runner", counts[11]],
        ["Lane Rush Duel", counts[12]],
        ["Memory Grid", counts[13]],
        ["Hex Duel", counts[14]],
        ["Odds", counts[15]],
        ["Dice Flush", counts[16]],
      ];
      const favoriteGame =
        gameCounts.sort((a, b) => b[1] - a[1])[0]?.[1] > 0
          ? gameCounts[0][0]
          : "N/A";

      // Only favorite_game is written here — it is the one stat that
      // applyLeaderboardCounters doesn't track. All other stats
      // (total_bets, wins, losses, win_rate, biggest_win, total_wagered,
      // etc.) are maintained incrementally by applyLeaderboardCounters in
      // leaderboardCounters.js and must NOT be overwritten here — doing so
      // would corrupt all-time values relative to weekly counters and cause
      // weekly > all-time. The record below reads those counters as-is.
      //
      // Write operations are fire-and-forget — they must not fail the request.
      try {
        await sql`
          INSERT INTO user_stats (user_id, favorite_game)
          VALUES (${uid}, ${favoriteGame})
          ON CONFLICT (user_id)
          DO UPDATE SET favorite_game = EXCLUDED.favorite_game;
        `;
      } catch (writeErr) {
        console.error("[user-stats] Failed to update user_stats:", writeErr);
      }

      //  Get user meta (level, referrals, authoritative wagered total)
      let row = null;
      try {
        const rows = await sql`
          SELECT
            referral_code,
            referral_count,
            referral_earnings,
            total_wagered,
            xp
          FROM users
          WHERE clerk_id = ${userId}
          LIMIT 1
        `;
        row = rows[0];
      } catch (selectErr) {
        console.error("[user-stats] Failed to fetch user meta:", selectErr);
      }

      // Battlepass level is DERIVED from TROPHIES (OVERALL_TROPHY_MAX = level 100),
      // not XP. The stored level/xp columns are legacy and no longer drive
      // progression; nothing is overwritten here.
      const totalTrophies = await getTotalTrophiesForUser(userId);
      const computedLevel = getLevelFromTrophies(totalTrophies);
      const progress = getBattlepassProgressFromTrophies(totalTrophies);
      const computedHighestTitle = getHighestTitle(computedLevel)?.title || null;

      // Titles still unlock by level — keep the highest unlocked title in
      // sync with the battlepass level.
      try {
        await sql`
          UPDATE users
          SET highest_title = COALESCE(${computedHighestTitle}, highest_title)
          WHERE clerk_id = ${userId}
        `;
      } catch (updateErr) {
        console.error("[user-stats] Failed to update highest title:", updateErr);
      }

      // Leaderboard-style record — the exact columns the leaderboard boards
      // read (user_stats + users), so the profile's stat tabs show the same
      // data as the /classement leaderboards. pvp_wins lives on users only.
      let record = null;
      try {
        const recordRows = await sql`
          SELECT
            COALESCE(s.wins, 0)::int AS wins,
            COALESCE(s.losses, 0)::int AS losses,
            COALESCE(s.total_bets, 0)::int AS games,
            COALESCE(s.win_rate, 0)::numeric AS win_rate,
            COALESCE(s.best_streak, 0)::int AS best_streak,
            COALESCE(s.current_streak, 0)::int AS current_streak,
            COALESCE(s.biggest_win, 0)::numeric AS biggest_win,
            COALESCE(s.favorite_game, 'N/A') AS favorite_game,
            COALESCE(u.pvp_wins, 0)::int AS pvp_wins,
            COALESCE(s.weekly_wins, 0)::int AS weekly_wins,
            COALESCE(s.weekly_losses, 0)::int AS weekly_losses,
            COALESCE(s.weekly_win_rate, 0)::numeric AS weekly_win_rate,
            COALESCE(s.weekly_best_streak, 0)::int AS weekly_best_streak,
            COALESCE(s.weekly_game_streak, 0)::int AS weekly_current_streak,
            COALESCE(s.weekly_biggest_win, 0)::numeric AS weekly_biggest_win,
            COALESCE(s.daily_streak_current, 0)::int AS daily_streak_current,
            COALESCE(s.daily_streak_best, 0)::int AS daily_streak_best,
            COALESCE(s.weekly_streak_current, 0)::int AS weekly_streak_current,
            COALESCE(s.weekly_streak_best, 0)::int AS weekly_streak_best
          FROM user_stats s
          INNER JOIN users u ON u.id = s.user_id
          WHERE s.user_id = ${uid}
          LIMIT 1
        `;
        record = recordRows[0] || null;
      } catch (recordErr) {
        console.error("[user-stats] Failed to fetch leaderboard record:", recordErr);
      }

      // Same shape as the previous response — every stat now sourced from
      // the maintained counters (record + users row) instead of a capped
      // history scan. The record query runs after the favorite_game upsert,
      // so record.favorite_game is the freshly persisted value.
      return {
        totalBets: Number(record?.games ?? 0),
        totalWins: Number(record?.wins ?? 0),
        totalLosses: Number(record?.losses ?? 0),
        winRate: Number(record?.winRate ?? 0),
        biggestWin: Number(record?.biggestWin ?? 0),
        favoriteGame,
        referrals: Number(row?.referral_count || 0),
        referralEarnings: Number(row?.referral_earnings || 0),
        referralCode: row?.referral_code || "",
        totalWagered: Number(row?.total_wagered || 0),
        currentLevel: computedLevel,
        levelProgress: progress,
        record,
      };
    });

    // ── Per-game Elo ratings ──────────────────────────────────────────
    // Read OUTSIDE the cached block: a rating moves the instant a rated
    // match settles, so the profile must never serve a stale Elo for the
    // length of the stats TTL. Only games the player has actually been rated
    // in appear — an unplayed game is simply absent, and the Ratings tab
    // omits it rather than inventing a 1000. Each entry carries the
    // provisional fields (completed / remaining / stage) so the UI can mark
    // a still-unplaced rating. Ratings are per game and never combined.
    let ratings = {};
    try {
      ratings = await getRatingsForUser(clerkId);
    } catch (ratingErr) {
      console.error("[user-stats] Failed to load ratings:", ratingErr);
    }

    // Overall Elo — an aggregate of the established ratings above, derived on
    // read from the same rows. Null until the player has an established
    // rating in at least OVERALL_MIN_GAMES different games; provisional game
    // ratings never count. Not stored anywhere and never client-supplied.
    const overall = overallEloFromRatingsMap(ratings);

    return new Response(
      JSON.stringify({
        success: true,
        stats: {
          ...stats,
          ratings,
          overallElo: overall.overallElo,
          overallEligibleGames: overall.eligibleGames,
          overallEligible: overall.eligible,
          overallMinGames: OVERALL_MIN_GAMES,
        },
      }),
      { status: 200, headers: { "Cache-Control": "private, s-maxage=120, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error("[USER_STATS_ERROR]", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to load stats" }),
      {
        status: 500,
      },
    );
  }
}