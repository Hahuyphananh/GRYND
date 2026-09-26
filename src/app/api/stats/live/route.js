import { getNeonSql } from "../../../../db/neon";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }
  _sql = getNeonSql();
  return _sql;
}

export async function GET() {
  try {
    const sql = getSql();

    const [onlineResult, gamesPlayedToday] = await Promise.all([
      // Online players: any presence record seen in last 5 minutes
      sql`
        SELECT COUNT(*)::int AS count
        FROM user_presence
        WHERE last_seen > NOW() - INTERVAL '5 minutes'
      `,
      // Games played today: sum across major game tables. This is a slow-
      // moving daily aggregate and the ticker polls every 30s, so it is
      // Redis-cached (5 min) — each poll becomes one Redis GET instead of
      // 20 Postgres COUNTs. The online count above stays live.
      cacheOrFetch(
        CacheKeys.liveStatsGamesToday(),
        CacheTTL.liveStatsGamesToday,
        async () => {
          const result = await sql`
        SELECT (
          COALESCE((SELECT COUNT(*) FROM roulette_games  WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM blackjack_games WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM crash_games     WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM mines_games     WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM plinko_games    WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM rps_games       WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM keno_games      WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM keno_pvp_matches WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM uno_games       WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM chess_games     WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM four_in_a_row_games WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM lane_runner_games  WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM hex_duel_games     WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM dice_matches       WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM odds_games         WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM dice_flush_rooms   WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM pool_matches       WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM precision_matches  WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM memory_grid_matches WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0)
        )::int AS count
          `;
          return Number(result?.[0]?.count ?? 0);
        },
      ),
    ]);

    const playersOnline = onlineResult?.[0]?.count ?? 0;
    const gamesPlayedTodayNum = Number(gamesPlayedToday ?? 0);

    return new Response(
      JSON.stringify({
        success: true,
        playersOnline,
        gamesPlayedToday: gamesPlayedTodayNum,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
        },
      }
    );
  } catch (error) {
    console.error("[LIVE_STATS_ERROR]", error);
    return new Response(
      JSON.stringify({ success: false, playersOnline: 0, gamesPlayedToday: 0 }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
