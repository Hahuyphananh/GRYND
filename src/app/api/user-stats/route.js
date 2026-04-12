import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { getLevelProgress } from "../../../lib/vipLevels";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await sql`
      SELECT
        u.id,
        COALESCE(us.total_bets, 0) AS total_bets,
        COALESCE(us.wins, 0) AS total_wins,
        COALESCE(us.losses, 0) AS total_losses,
        COALESCE(us.win_rate, 0) AS win_rate,
        COALESCE(us.biggest_win, 0) AS biggest_win,
        COALESCE(us.favorite_game, 'N/A') AS favorite_game,
        COALESCE(u.referral_code, '') AS referral_code,
        COALESCE(u.referral_count, 0) AS referral_count,
        COALESCE(u.referral_earnings, 0) AS referral_earnings,
        COALESCE(u.total_wagered, 0) AS total_wagered,
        COALESCE(u.level, 1) AS level
      FROM users u
      LEFT JOIN user_stats us ON us.user_id = u.id
      WHERE u.clerk_id = ${userId}
      LIMIT 1
    `;

    const row = result.rows[0];
    if (!row) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const progress = getLevelProgress(Number(row.total_wagered));

    return new Response(
      JSON.stringify({
        success: true,
        stats: {
          totalBets: Number(row.total_bets),
          totalWins: Number(row.total_wins),
          totalLosses: Number(row.total_losses),
          winRate: Number(row.win_rate),
          biggestWin: Number(row.biggest_win),
          favoriteGame: row.favorite_game,
          referrals: Number(row.referral_count),
          referralEarnings: Number(row.referral_earnings),
          referralCode: row.referral_code,
          totalWagered: Number(row.total_wagered),
          currentLevel: Number(row.level),
          levelProgress: progress,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || error || "").toLowerCase();
    const schemaMismatch =
      code === "42P01" ||
      code === "42703" ||
      message.includes("user_stats") ||
      message.includes("referral_") ||
      message.includes("total_wagered") ||
      message.includes("level");

    if (schemaMismatch) {
      const fallbackCandidates = [
        sql`
          SELECT
            id,
            COALESCE(referral_code, '') AS referral_code,
            COALESCE(referral_count, 0) AS referral_count,
            COALESCE(referral_earnings, 0) AS referral_earnings,
            COALESCE(total_wagered, 0) AS total_wagered,
            COALESCE(level, 1) AS level
          FROM users
          WHERE clerk_id = ${userId}
          LIMIT 1
        `,
        sql`
          SELECT
            id,
            '' AS referral_code,
            0::integer AS referral_count,
            0::numeric AS referral_earnings,
            COALESCE(total_wagered, 0) AS total_wagered,
            COALESCE(level, 1) AS level
          FROM users
          WHERE clerk_id = ${userId}
          LIMIT 1
        `,
        sql`
          SELECT
            id,
            '' AS referral_code,
            0::integer AS referral_count,
            0::numeric AS referral_earnings,
            0::numeric AS total_wagered,
            1::integer AS level
          FROM users
          WHERE clerk_id = ${userId}
          LIMIT 1
        `,
      ];

      for (const fallbackQuery of fallbackCandidates) {
        try {
          const fallback = await fallbackQuery;
          const row = fallback.rows[0];
          if (!row) {
            return new Response(JSON.stringify({ success: false, error: "User not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }

          const progress = getLevelProgress(Number(row.total_wagered));
          return new Response(JSON.stringify({
            success: true,
            stats: {
              totalBets: 0,
              totalWins: 0,
              totalLosses: 0,
              winRate: 0,
              biggestWin: 0,
              favoriteGame: 'N/A',
              referrals: Number(row.referral_count),
              referralEarnings: Number(row.referral_earnings),
              referralCode: row.referral_code,
              totalWagered: Number(row.total_wagered),
              currentLevel: Number(row.level),
              levelProgress: progress,
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (fallbackError) {
          console.error("[USER_STATS_FALLBACK_ATTEMPT_FAILED]", fallbackError);
        }
      }
    }

    console.error("[USER_STATS_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to load stats" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
