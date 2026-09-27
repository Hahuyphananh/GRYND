import { getNeonSql } from "../db/neon";
import { invalidateOnGameSettlement } from "./redis/invalidation";
import { sendLossStreakEmail } from "./emails/behavior";

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

/**
 * Record the skill outcome of a settled game on the counters the SKILL
 * leaderboards read.
 *
 * WHY THIS SHAPE
 *   The leaderboards rank wins, win rate and streaks (never tokens). Those
 *   counters must move for EVERY settled competitive result, so this helper is
 *   driven by an explicit `outcome` rather than by a wager: stakes are retired
 *   (every match is created with stake 0), so a `payout > bet` test can never
 *   identify a win. Trophies and Elo are applied separately.
 *
 * WHAT IT DOES *NOT* DO
 *   No token- or XP-denominated column is touched — `total_wagered`,
 *   `total_won`, `weekly_profit`, `biggest_win`, `best_multiplier`, `xp`,
 *   `level`, `last_settled_xp*` and the daily wagered/won counters are all
 *   deliberately absent. Progression is trophies; there is no wager XP.
 *
 * @param {object} args
 * @param {string} args.clerkId       the player whose result this is
 * @param {string} [args.game]        canonical game key (context only)
 * @param {"win"|"loss"} args.outcome the settled result for THIS player
 * @param {boolean} [args.isPvpWin]   true only for the winner of a real
 *                                    human-vs-human match (feeds pvp_wins)
 */
export async function applyLeaderboardCounters({
  clerkId,
  game = "casino",
  outcome,
  isPvpWin = false,
}) {
  const isWin = outcome === "win";
  const isLoss = outcome === "loss";

  // Only a real settled result moves a counter. AI/bot matches are filtered by
  // the caller (they must not touch leaderboards), and a missing/invalid
  // outcome is a no-op rather than a guess.
  if (!clerkId || (!isWin && !isLoss)) return;

  // Fetch the player's email + current streak BEFORE the update so the loss
  // streak email (if any) reflects this result.
  const userBefore = await getSql()`
    SELECT id, email, name, current_streak
    FROM users
    WHERE clerk_id = ${clerkId}
    LIMIT 1
  `;

  const userEmail = userBefore?.[0]?.email;
  const userName = userBefore?.[0]?.name;

  const counterRows = await getSql()`
    WITH updated_user AS (
      UPDATE users
      SET current_streak = CASE WHEN ${isWin} THEN current_streak + 1 ELSE 0 END,
          best_streak = GREATEST(best_streak, CASE WHEN ${isWin} THEN current_streak + 1 ELSE best_streak END),
          weekly_wins = weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          pvp_wins = pvp_wins + CASE WHEN ${isPvpWin} THEN 1 ELSE 0 END,
          -- Result-screen progression: the wins/losses this settlement moved,
          -- read by /api/leaderboard/my-rank (migration 0151).
          last_settled_wins_delta = CASE WHEN ${isWin} THEN 1 ELSE 0 END,
          last_settled_losses_delta = CASE WHEN ${isWin} THEN 0 ELSE 1 END
      WHERE clerk_id = ${clerkId}
      RETURNING id, email, name, current_streak
    )
    INSERT INTO user_stats (
      user_id,
      total_bets,
      wins,
      losses,
      win_rate,
      current_streak,
      best_streak,
      weekly_wins,
      weekly_losses,
      weekly_win_rate,
      weekly_best_streak,
      weekly_game_streak
    )
    SELECT
      id,
      1,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      CASE WHEN ${isWin} THEN 100 ELSE 0 END,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      CASE WHEN ${isWin} THEN 100 ELSE 0 END,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      CASE WHEN ${isWin} THEN 1 ELSE 0 END
    FROM updated_user
    ON CONFLICT (user_id) DO UPDATE SET
      total_bets = user_stats.total_bets + 1,
      wins = user_stats.wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      losses = user_stats.losses + CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      win_rate = ROUND(((user_stats.wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END)::numeric / NULLIF(user_stats.total_bets + 1, 0)) * 100, 2),
      current_streak = CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE 0 END,
      best_streak = GREATEST(user_stats.best_streak, CASE WHEN ${isWin} THEN user_stats.current_streak + 1 ELSE user_stats.best_streak END),
      weekly_wins = user_stats.weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END,
      weekly_losses = user_stats.weekly_losses + CASE WHEN ${isWin} THEN 0 ELSE 1 END,
      weekly_game_streak = CASE WHEN ${isWin} THEN user_stats.weekly_game_streak + 1 ELSE 0 END,
      weekly_best_streak = GREATEST(user_stats.weekly_best_streak, CASE WHEN ${isWin} THEN user_stats.weekly_game_streak + 1 ELSE user_stats.weekly_best_streak END),
      weekly_win_rate = ROUND(((user_stats.weekly_wins + CASE WHEN ${isWin} THEN 1 ELSE 0 END)::numeric / NULLIF(user_stats.weekly_wins + user_stats.weekly_losses + 1, 0)) * 100, 2),
      updated_at = NOW()
    RETURNING user_id AS id, current_streak
  `;

  const currentStreak = counterRows?.[0]?.current_streak ?? (isWin ? 1 : 0);

  // Loss streak email (3+ losses in a row) — fire-and-forget, never blocks
  // settlement. `current_streak` counts consecutive WINS, so a fresh loss
  // resets it to 0; the email only concerns itself with an active streak.
  if (userEmail && isLoss && Number(currentStreak) <= -3) {
    try {
      await sendLossStreakEmail({ clerkId, email: userEmail, name: userName });
    } catch (err) {
      console.error("[applyLeaderboardCounters] Loss streak email failed:", err);
    }
  }

  // Invalidate caches affected by this game settlement.
  // Fire-and-forget — don't block the settlement response on cache ops.
  invalidateOnGameSettlement(clerkId).catch(() => {});
}
