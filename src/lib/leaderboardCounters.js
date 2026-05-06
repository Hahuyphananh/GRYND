import { sql } from "@vercel/postgres";

export async function applyLeaderboardCounters({ clerkId, game = "casino", betAmount = 0, payout = 0, isPvpWin = false }) {
  const bet = Math.max(0, Math.floor(Number(betAmount) || 0));
  const win = Math.max(0, Math.floor(Number(payout) || 0));
  const multiplier = bet > 0 ? win / bet : 0;
  const isWin = win > bet;

  if (!clerkId || bet <= 0) return;

  await sql`
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
  `;

  if (multiplier >= 10) {
    await sql`
      INSERT INTO big_wins (id, user_id, username, game, bet_amount, win_amount, multiplier)
      SELECT gen_random_uuid(), clerk_id, name, ${game}, ${bet}, ${win}, ${multiplier}
      FROM users
      WHERE clerk_id = ${clerkId}
    `;
  }
}
