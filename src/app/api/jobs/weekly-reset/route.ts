import { sql } from "../../../../db/sql";
import { invalidateAllLeaderboards } from "../../../../lib/redis/invalidation";
import { sendWeeklySummaryEmail } from "../../../../lib/emails/summary";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

export async function GET(request: Request) {
  // Authenticate cron request before performing global state changes
  const authError = verifyCronRequest(request);
  if (authError) return authError;
  // Fetch weekly stats BEFORE resetting, then send summary emails
  const weeklyStatsResult = await sql`
    SELECT u.clerk_id as "clerkId", u.email,
           us.weekly_wagered as "totalWins",
           us.weekly_won as "totalLosses",
           us.weekly_profit as "net",
           to_char(NOW(), 'IYYY-"W"IW') as "periodKey"
    FROM users u
    JOIN user_stats us ON us.user_id = u.id
    WHERE COALESCE(us.weekly_wagered, 0) <> 0
       OR COALESCE(us.weekly_won, 0) <> 0
       OR COALESCE(us.weekly_profit, 0) <> 0
       OR COALESCE(us.weekly_wins, 0) <> 0
  `;

  const weeklyStats = weeklyStatsResult.rows ?? [];

  // Send weekly summary emails (fire-and-forget)
  for (const row of weeklyStats) {
    try {
      await sendWeeklySummaryEmail(
        { clerkId: row.clerkId, email: row.email },
        {
          totalWins: Number(row.totalWins),
          totalLosses: Number(row.totalLosses),
          net: Number(row.net),
          periodKey: row.periodKey,
        }
      );
    } catch (err) {
      console.error("[weekly-reset] Weekly summary email failed:", err);
    }
  }

  // Only touch rows with any nonzero weekly activity — a full-table UPDATE
  // writes a new tuple for EVERY user (even inactive ones) via MVCC, so the
  // WHERE guard skips the vast majority of rows and avoids the write + lock
  // churn at the Monday-midnight boundary. Rows with all-zero weekly values
  // are already in the post-reset state.
  await sql`
    UPDATE users
    SET weekly_wagered = 0,
        weekly_won = 0,
        weekly_profit = 0,
        weekly_wins = 0
    WHERE COALESCE(weekly_wagered, 0) <> 0
       OR COALESCE(weekly_won, 0) <> 0
       OR COALESCE(weekly_profit, 0) <> 0
       OR COALESCE(weekly_wins, 0) <> 0
  `;

  // Same WHERE guard as the users update — skip rows with all-zero weekly
  // values (inactive players) instead of writing a new tuple for everyone.
  // weekly_streak_best is intentionally NOT reset (all-time best persists).
  await sql`
    UPDATE user_stats
    SET weekly_wagered = 0,
        weekly_won = 0,
        weekly_wins = 0,
        weekly_losses = 0,
        weekly_level_gain = 0,
        weekly_best_streak = 0,
        weekly_biggest_win = 0,
        weekly_win_rate = 0,
        weekly_game_streak = 0,
        weekly_streak_current = 0,
        updated_at = NOW()
    WHERE COALESCE(weekly_wagered, 0) <> 0
       OR COALESCE(weekly_won, 0) <> 0
       OR COALESCE(weekly_wins, 0) <> 0
       OR COALESCE(weekly_losses, 0) <> 0
       OR COALESCE(weekly_level_gain, 0) <> 0
       OR COALESCE(weekly_best_streak, 0) <> 0
       OR COALESCE(weekly_biggest_win, 0) <> 0
       OR COALESCE(weekly_win_rate, 0) <> 0
       OR COALESCE(weekly_game_streak, 0) <> 0
       OR COALESCE(weekly_streak_current, 0) <> 0
  `;

  // Purge big-wins feed entries older than 7 days so the
  // big-wins chat feed doesn't show stale wins after reset
  await sql`
    DELETE FROM big_wins
    WHERE created_at < NOW() - INTERVAL '7 days'
  `;

  // Invalidate all leaderboard caches so the next request fetches
  // fresh (post-reset) data instead of serving stale cached rows
  invalidateAllLeaderboards().catch((err) =>
    console.error("weekly-reset: failed to invalidate leaderboard caches", err),
  );

  return Response.json({ ok: true, resetAt: new Date().toISOString() });
}
