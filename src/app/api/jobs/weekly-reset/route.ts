import { sql } from "../../../../db/sql";
import { invalidateAllLeaderboards } from "../../../../lib/redis/invalidation";

export async function GET() {
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
