import { neon } from "@neondatabase/serverless";

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }
  _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

export async function GET() {
  try {
    const sql = getSql();

    const [onlineResult, gamesResult] = await Promise.all([
      // Online players: any presence record seen in last 5 minutes
      sql`
        SELECT COUNT(*)::int AS count
        FROM user_presence
        WHERE last_seen > NOW() - INTERVAL '5 minutes'
      `,
      // Games played today: sum across major game tables (range scan for index-friendly perf)
      sql`
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
          COALESCE((SELECT COUNT(*) FROM connect_four_games WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM lane_runner_games  WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM hex_duel_games     WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM dice_matches       WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM odds_games         WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM dice_flush_rooms   WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM poker_games        WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM pool_matches       WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0) +
          COALESCE((SELECT COUNT(*) FROM precision_matches  WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'), 0)
        )::int AS count
      `,
    ]);

    const playersOnline = onlineResult?.[0]?.count ?? 0;
    const gamesPlayedToday = gamesResult?.[0]?.count ?? 0;

    return new Response(
      JSON.stringify({
        success: true,
        playersOnline,
        gamesPlayedToday,
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
