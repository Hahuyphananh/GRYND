import { getNeonSql } from "../db/neon";
import { invalidateOnGameSettlement, invalidateBigWins } from "./redis/invalidation";

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Set it in your runtime environment (for example, Vercel Project Settings > Environment Variables).",
    );
  }
  _sql = getNeonSql();
  return _sql;
}

export async function applyLeaderboardCounters({
  clerkId,
  game = "casino",
  betAmount = 0,
  payout = 0,
  isPvpWin = false,
}) {
  const bet = Math.max(0, Math.floor(Number(betAmount) || 0));
  const win = Math.max(0, Math.floor(Number(payout) || 0));
  const multiplier = bet > 0 ? win / bet : 0;
  const isWin = win > bet;

  if (!clerkId || bet <= 0) return;

  await getSql()`
    WITH updated_user AS (
      UPDATE users
      SET total_wagered = total_wagered + ${bet},
          weekly_wagered = weekly_wagered + ${bet},
          total_won = total_won + ${win},
          weekly_won = weekly_won + ${win},
          weekly_profit = weekly_profit + ${win - bet},
          biggest_win = GREATEST(biggest_win, ${win}),
          best_multiplier = GREATEST(best_multiplier, ${multiplier}),
          current_streak = CASE WHEN ${isWin} THEN current_streak + 1 ELSE 0 END,
          best_streak = GREATEST(best_streak, CASE WHEN ${isWin} THEN current_streak + 1 ELSE best_streak END),
          weekly_wins = weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          pvp_wins = pvp_wins + CASE WHEN ${isPvpWin} THEN 1 ELSE 0 END
      WHERE clerk_id = ${clerkId}
      RETURNING id, level, xp
    )
    INSERT INTO user_stats (
      user_id,
      total_bets,
      wins,
      losses,
      win_rate,
      total_wagered,
      total_won,
      biggest_win,
      current_streak,
      best_streak,
      level,
      xp,
      weekly_wagered,
      weekly_won,
      weekly_wins,
      weekly_losses,
      weekly_biggest_win,
      weekly_best_streak,
      weekly_win_rate,
      weekly_level_gain,
      weekly_game_streak
    )
    SELECT
      id,
      1,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      CASE WHEN ${isWin} THEN 100 ELSE 0 END,
      ${bet},
      ${win},
      ${win},
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      level,
      xp,
      ${bet},
      ${win},
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      ${win},
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 100 ELSE 0 END,
      0,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END
    FROM updated_user
    ON CONFLICT (user_id) DO UPDATE SET
      total_bets = user_stats.total_bets + 1,
      wins = user_stats.wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      losses = user_stats.losses + CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      win_rate = ROUND(((user_stats.wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END)::numeric / NULLIF(user_stats.total_bets + 1, 0)) * 100, 2),
      total_wagered = user_stats.total_wagered + ${bet},
      total_won = user_stats.total_won + ${win},
      biggest_win = GREATEST(user_stats.biggest_win, ${win}),
      current_streak = CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE 0 END,
      best_streak = GREATEST(user_stats.best_streak, CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE user_stats.best_streak END),
      level = EXCLUDED.level,
      xp = EXCLUDED.xp,
      weekly_wagered = user_stats.weekly_wagered + ${bet},
      weekly_won = user_stats.weekly_won + ${win},
      weekly_wins = user_stats.weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      weekly_losses = user_stats.weekly_losses + CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      weekly_biggest_win = GREATEST(user_stats.weekly_biggest_win, ${win}),
      weekly_game_streak = CASE WHEN ${isWin} THEN user_stats.weekly_game_streak + 1 ELSE 0 END,
      weekly_best_streak = GREATEST(user_stats.weekly_best_streak, CASE WHEN ${isWin} THEN user_stats.weekly_game_streak + 1 ELSE 0 END),
      weekly_win_rate = ROUND(((user_stats.weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END)::numeric / NULLIF(user_stats.weekly_wins + user_stats.weekly_losses + 1, 0)) * 100, 2),
      weekly_level_gain = GREATEST(0, EXCLUDED.level - user_stats.level + user_stats.weekly_level_gain),
      updated_at = NOW()
  `;

  if (multiplier >= 10) {
    await getSql()`
      INSERT INTO big_wins (id, user_id, username, game, bet_amount, win_amount, multiplier)
      SELECT gen_random_uuid(), clerk_id, name, ${game}, ${bet}, ${win}, ${multiplier}
      FROM users
      WHERE clerk_id = ${clerkId}
    `;

    // Invalidate big-wins feed cache (new big win recorded)
    invalidateBigWins().catch(() => {});
  }

  // Invalidate caches affected by this game settlement.
  // Fire-and-forget — don't block the settlement response on cache ops.
  invalidateOnGameSettlement(clerkId).catch(() => {});
}
